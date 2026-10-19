"""Read-only, tracked-source tools for model-led repository exploration."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import subprocess
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from prism import settings
    from prism.symbols import LANGUAGES, scan_source
    from prism.github_context import read_github
    from prism.sourcefiles import git_lines
else:
    from . import settings
    from .symbols import LANGUAGES, scan_source
    from .github_context import read_github
    from .sourcefiles import git_lines

TOOL_NAMES = ("list_files", "list_symbols", "related_symbols", "read_source", "read_text",
              "read_blob", "search_source", "list_changes", "read_diff", "read_context",
              "read_history", "read_github")
PAGE_CHARS = 24000


def text_page(text: str, args: dict) -> dict:
    """Bound transport size without making any part of the text inaccessible."""
    offset = min(len(text), max(0, int(args.get("offset", 0))))
    limit = max(1, min(int(args.get("limit", PAGE_CHARS)), PAGE_CHARS))
    end = min(len(text), offset + limit)
    return {"text": text[offset:end], "offset": offset, "total_chars": len(text),
            "next_offset": end if end < len(text) else None, "complete": end >= len(text)}


class RepositoryToolError(RuntimeError):
    pass


def head_worktree(report: dict) -> Path:
    """Return the verified local worktree for this report's exact PR-head commit."""
    meta = report.get("meta") or {}
    owner = str(meta.get("owner") or "")
    repo = str(meta.get("repo") or "")
    head = str(meta.get("head") or "")
    if not owner or not repo or not re.fullmatch(r"[a-f0-9]{40}", head):
        raise RepositoryToolError("This report does not contain a valid PR-head revision.")
    repo_key = hashlib.sha256(f"{owner}/{repo}".encode()).hexdigest()[:20]
    worktree = settings.DATA_DIR / "repos" / repo_key / "worktrees" / head
    if worktree.is_symlink() or not worktree.is_dir():
        raise RepositoryToolError("The cached PR checkout is unavailable. Reanalyze the pull request before browsing repository code.")
    root = worktree.resolve()
    if not root.is_relative_to(settings.DATA_DIR.resolve()):
        raise RepositoryToolError("The cached PR checkout is outside Prism's local data directory.")
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--verify", "HEAD^{commit}"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RepositoryToolError("Could not verify the cached PR checkout revision.") from exc
    if result.returncode or result.stdout.strip().lower() != head:
        raise RepositoryToolError("The cached PR checkout does not match this report's head revision.")
    return root


class RepositoryTools:
    """A small MCP server whose only capabilities are bounded reads of tracked source."""

    def __init__(self, root: Path, expected_head: str, audit_path: Path, expected_base: str | None = None,
                 context: dict | None = None):
        self.root = root.resolve()
        self.expected_head = expected_head
        self.audit_path = audit_path
        self.expected_base = expected_base
        self.context = context or {}
        self.github_cache = {}
        self.inventories = {}
        self._resolved = {}
        self.entries = {}
        self.base_files = None
        self.next_source_id = 1
        self.inventory_limited = False
        self.files = self._tracked_sources()
        self.cache: dict[str, list[str]] = {}
        self.symbol_cache: dict[str, list[dict]] = {}
        self.graph_loaded = False
        self.graph: dict | None = None

    def _git(self, *args: str, allowed=(0,)) -> bytes:
        try:
            proc = subprocess.run(
                ["git", "--no-pager", "--literal-pathspecs", "-C", str(self.root), *args],
                capture_output=True, timeout=90, check=False,
                env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1", "GIT_TERMINAL_PROMPT": "0"},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RepositoryToolError("Repository read failed or timed out; this content remains uninspected.") from exc
        if proc.returncode not in allowed:
            raise RepositoryToolError("Git could not retrieve the requested committed content.")
        return proc.stdout

    def _revision(self, side: str = "head") -> str:
        aliases = {"head": self.expected_head, "base": self.expected_base,
                   "target": (self.context.get("meta") or {}).get("base")}
        sha = aliases.get(side, side)
        if not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{40}", sha):
            raise RepositoryToolError("Choose head, base, target, or a full commit SHA available in this repository.")
        if sha in self._resolved: return sha
        resolved = self._git("rev-parse", "--verify", sha + "^{commit}").decode().strip()
        if resolved != sha:
            raise RepositoryToolError("The requested commit is unavailable.")
        self._resolved[sha] = True
        return sha

    def _tracked_sources(self, revision: str | None = None) -> dict[str, tuple[str, int | None]]:
        head = self._git("rev-parse", "--verify", "HEAD^{commit}").decode().strip()
        if head != self.expected_head:
            raise RepositoryToolError("The repository tools are not pointed at the report's PR-head revision.")
        sha = self._revision(revision or "head")
        # Git objects, including symlink payloads and binary blobs, never follow
        # filesystem links. Analysis/parser eligibility does not restrict access.
        files = {}; entries = {}
        for raw in self._git("ls-tree", "-rz", "--full-tree", sha).split(b"\0"):
            if not raw: continue
            header, path_bytes = raw.split(b"\t", 1)
            mode, kind, oid = header.decode("ascii").split()
            relative = os.fsdecode(path_bytes)
            entries[relative] = {"path": relative, "mode": mode, "kind": kind,
                                 "oid": oid, "size": None}
            if kind == "blob": files[relative] = (oid, None)
        self.entries[sha] = entries
        self.inventories[sha] = files
        return files

    def _inventory(self, side: str = "head") -> dict:
        sha = self._revision(side)
        if sha not in self.inventories: self._tracked_sources(sha)
        return self.inventories[sha]

    def _blob(self, relative: str, side: str = "head") -> bytes:
        item = self._inventory(side).get(relative)
        if item is None:
            raise RepositoryToolError("Choose an exact tracked blob path from list_files. Submodules require their own repository.")
        oid, expected_size = item
        result = self._git("cat-file", "blob", oid)
        if expected_size is not None and len(result) != expected_size:
            raise RepositoryToolError("Git returned incomplete blob content.")
        return result

    def _lines(self, relative: str, side: str = "head") -> list[str]:
        cache_key = side + ":" + relative
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            raw = self._blob(relative, side)
            if b"\0" in raw: raise RepositoryToolError("This file contains binary data.")
            lines = git_lines(raw.decode("utf-8"))
        except UnicodeError as exc:
            raise RepositoryToolError("Could not read that source file as UTF-8.") from exc
        self.cache[cache_key] = lines
        return lines

    def _source(self, relative: str, start: int, end: int, code: str, side: str = "head", **extra) -> dict:
        source_id = f"R{self.next_source_id}"
        self.next_source_id += 1
        revision = self._revision(side)
        canonical_side = "head" if revision == self.expected_head else "base" if revision == self.expected_base else side
        record = {"source_id": source_id, "path": relative, "line": start, "end_line": end,
                  "side": canonical_side, "revision": revision, **extra}
        with self.audit_path.open("a", encoding="utf-8") as audit:
            audit.write(json.dumps(record, ensure_ascii=True) + "\n")
        return {**record, "code": code}

    def list_files(self, args: dict) -> dict:
        side = str(args.get("revision") or "head")
        self._inventory(side)
        prefix = str(args.get("path_prefix") or "").rstrip("/")
        contains = str(args.get("path_contains") or "")
        paths = [p for p in self.entries[self._revision(side)]
                 if (not prefix or p == prefix or p.startswith(prefix + "/")) and contains in p]
        offset = max(0, int(args.get("offset", 0)))
        limit = max(1, min(int(args.get("limit", 150)), 250))
        page = paths[offset:offset + limit]
        end = offset + len(page)
        return {"revision": self._revision(side), "files": page,
                "entries": [self.entries[self._revision(side)][p] for p in page],
                "total_matching": len(paths), "next_offset": end if end < len(paths) else None,
                "inventory_limited": False}

    def list_symbols(self, args: dict) -> dict:
        relative = str(args.get("path") or "")
        side = str(args.get("revision") or "head")
        cache_key = self._revision(side) + ":" + relative
        symbols = self.symbol_cache.get(cache_key)
        if symbols is None:
            symbols = scan_source(self._blob(relative, side), relative)
            self.symbol_cache[cache_key] = symbols
        offset = max(0, int(args.get("offset", 0)))
        limit = max(1, min(int(args.get("limit", 120)), 200))
        page = symbols[offset:offset + limit]
        next_offset = offset + len(page)
        return {"path": relative, "revision": self._revision(side), "symbols": page, "total": len(symbols),
                "next_offset": next_offset if next_offset < len(symbols) else None,
                "parser_supported": Path(relative).suffix.lower() in LANGUAGES,
                "note": "Declarations are navigation only. Empty results do not establish absence of code; use search_source/read_source."}

    def _graph(self) -> dict | None:
        if self.graph_loaded:
            return self.graph
        self.graph_loaded = True
        graph_dir = self.root.parent.parent / "graphs"
        data_root = settings.DATA_DIR.resolve()
        if graph_dir.is_symlink() or not graph_dir.is_dir():
            return None
        try:
            graph_dir = graph_dir.resolve(strict=True)
            if not graph_dir.is_relative_to(data_root):
                return None
            candidates = sorted(graph_dir.glob(f"graph-v2-{self.expected_head}-*.json"),
                                key=lambda path: path.stat().st_mtime, reverse=True)
        except (OSError, RuntimeError):
            return None
        for path in candidates:
            try:
                if path.is_symlink() or path.stat().st_size > 80_000_000:
                    continue
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(graph_dir):
                    continue
                data = json.loads(resolved.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("nodes"), list) and isinstance(data.get("edges"), list):
                    self.graph = data
                    return data
            except (OSError, UnicodeError, ValueError, RuntimeError):
                continue
        return None

    def related_symbols(self, args: dict) -> dict:
        relative = str(args.get("path") or "").replace("\\", "/")
        if relative not in self.files:
            raise RepositoryToolError("Choose one tracked source path from list_files.")
        graph = self._graph()
        if graph is None:
            return {"path": relative, "available": False,
                    "note": "No cached Graphify snapshot is available. Use list_symbols and read_source to inspect code."}
        line_arg = args.get("line")
        line = max(1, int(line_arg)) if line_arg is not None else None
        nodes = {str(node.get("id")): node for node in graph["nodes"]
                 if isinstance(node, dict) and node.get("id")}
        local = [node for node in nodes.values() if node.get("path") == relative]
        if line is not None and local:
            local.sort(key=lambda node: (abs(int(node.get("line") or 0) - line), str(node.get("label") or "")))
            nearest = abs(int(local[0].get("line") or 0) - line)
            local = [node for node in local if abs(int(node.get("line") or 0) - line) <= max(12, nearest)]
        local = local[:8]
        links = []
        for edge in graph["edges"]:
            if not isinstance(edge, dict):
                continue
            source_id, target_id = str(edge.get("source") or ""), str(edge.get("target") or "")
            if source_id not in nodes or target_id not in nodes:
                continue
            source_is_seed = any(source_id == item.get("id") for item in local)
            target_is_seed = any(target_id == item.get("id") for item in local)
            if not (source_is_seed or target_is_seed):
                continue
            source, target = nodes[source_id], nodes[target_id]
            source_path, target_path = source.get("path"), target.get("path")
            if target_path not in self.files or source_path not in self.files:
                continue
            relative_to_seed = "both" if source_is_seed and target_is_seed else "from" if source_is_seed else "to"
            links.append({"from": {"label": source.get("label"), "path": source_path,
                                     "line": source.get("line")},
                          "relation": edge.get("relation", "related to"),
                          "to": {"label": target.get("label"), "path": target_path,
                                   "line": target.get("line"), "kind": target.get("kind")},
                          "relative_to_seed": relative_to_seed})
        links.sort(key=lambda item: (str(item["to"].get("path") or ""),
                                     int(item["to"].get("line") or 0), str(item["relation"])))
        return {"path": relative, "seed_symbols": [
                    {"label": node.get("label"), "line": node.get("line"), "kind": node.get("kind")}
                    for node in local],
                "relationships": links[max(0, int(args.get("offset", 0))):max(0, int(args.get("offset", 0))) + 40],
                "total": len(links),
                "next_offset": int(args.get("offset", 0)) + 40 if int(args.get("offset", 0)) + 40 < len(links) else None,
                "note": "Graph relationships are navigation hints; read the returned source before relying on them."}

    def read_source(self, args: dict) -> dict:
        relative = str(args.get("path") or "")
        side = str(args.get("revision") or "head")
        lines = self._lines(relative, side)
        start = int(args.get("start_line", 1)); column = int(args.get("start_column", 0))
        end = int(args.get("end_line", start + 79))
        if start < 1 or end < start or column < 0:
            raise RepositoryToolError("Choose positive line numbers and a nonnegative character column.")
        if not lines and start == 1:
            return self._source(relative, 1, 1, "", side, total_lines=0, next_range=None)
        if start > len(lines) or column > len(lines[start - 1]):
            raise RepositoryToolError("The requested source position is outside this file.")
        end = min(end, len(lines), start + 79)
        code = []; remaining = PAGE_CHARS; next_range = None; last = start
        for number in range(start, end + 1):
            col = column if number == start else 0
            prefix = f"{number:>5}: " if col == 0 else f"{number:>5} (column {col}): "
            available = max(0, remaining - len(prefix) - 1)
            part = lines[number - 1][col:col + available]
            code.append(prefix + part); remaining -= len(prefix) + len(part) + 1; last = number
            if col + len(part) < len(lines[number - 1]):
                next_range = {"start_line": number, "start_column": col + len(part)}; break
            if remaining < 40 and number < len(lines):
                next_range = {"start_line": number + 1, "start_column": 0}; break
        if next_range is None and last < len(lines):
            next_range = {"start_line": last + 1, "start_column": 0}
        return self._source(relative, start, last, "\n".join(code), side,
                            total_lines=len(lines), start_column=column, next_range=next_range,
                            partial_lines=bool(column or (next_range and next_range.get("start_column"))))

    def read_text(self, args: dict) -> dict:
        relative = str(args.get("path") or ""); side = str(args.get("revision") or "head")
        try: text = self._blob(relative, side).decode("utf-8")
        except UnicodeError as exc: raise RepositoryToolError("Non-UTF-8 content: use read_blob for exact bytes.") from exc
        result = text_page(text, args)
        start = text.count("\n", 0, result["offset"]) + 1
        end = start + result["text"].count("\n")
        return {**self._source(relative, start, end, result["text"], side, partial_lines=True), **result}

    def read_blob(self, args: dict) -> dict:
        relative = str(args.get("path") or ""); side = str(args.get("revision") or "head")
        data = self._blob(relative, side)
        offset = max(0, int(args.get("offset", 0))); limit = max(1, min(int(args.get("limit", 12000)), 12000))
        end = min(len(data), offset + limit)
        return {"path": relative, "revision": self._revision(side), "encoding": "base64",
                "data": base64.b64encode(data[offset:end]).decode("ascii"), "total_bytes": len(data),
                "next_offset": end if end < len(data) else None,
                "note": "Exact bytes, including LFS pointers and symlink payloads; referenced content is separate."}

    def search_source(self, args: dict) -> dict:
        query = str(args.get("query") or "")
        if not query or "\n" in query or "\0" in query:
            raise RepositoryToolError("Search for one nonempty literal line fragment.")
        side = str(args.get("revision") or "head"); sha = self._revision(side)
        command = ["grep", "--no-textconv", "-I", "-n", "--column", "-z", "-F"]
        if args.get("ignore_case"): command.append("-i")
        command += ["-e", query, sha, "--"]
        prefix = str(args.get("path_prefix") or "")
        if prefix: command.append(prefix)
        raw = self._git(*command, allowed=(0, 1))
        matches = []; pos = 0
        offset = max(0, int(args.get("offset", 0))); limit = max(1, min(int(args.get("limit", 40)), 100))
        count = 0
        while pos < len(raw):
            fields = []
            for _ in range(3):
                stop = raw.index(b"\0", pos)
                fields.append(raw[pos:stop]); pos = stop + 1
            path, line, column = fields
            stop = raw.find(b"\n", pos)
            if stop == -1: stop = len(raw)
            content = raw[pos:stop]; pos = stop + 1
            if offset <= count < offset + limit:
                value = content.decode("utf-8", errors="replace")
                col = len(content[:int(column) - 1].decode("utf-8", errors="replace"))
                snippet_start = max(0, col - 120)
                matches.append({"path": os.fsdecode(path).removeprefix(sha + ":"), "line": int(line),
                                "column": col + 1, "byte_column": int(column), "snippet_column": snippet_start,
                                "text": value[snippet_start:snippet_start + 400],
                                "note": "Search hit only; retrieve full source to inspect behavior."})
            count += 1
        end = offset + len(matches)
        return {"revision": sha, "matches": matches, "total": count,
                "next_offset": end if end < count else None,
                "note": "Literal matches in tracked nonbinary content, independent of parser/graph coverage."}

    def list_changes(self, args: dict) -> dict:
        base = self._revision("base"); head = self._revision("head")
        fields = self._git("diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", base, head, "--").split(b"\0")
        changes = []; i = 0
        while i < len(fields) and fields[i]:
            status = fields[i].decode("ascii"); path = os.fsdecode(fields[i + 1]); i += 2
            old_path = path
            if status[0] in "RC": path = os.fsdecode(fields[i]); i += 1
            changes.append({"path": path, "old_path": old_path, "status": status})
        offset = max(0, int(args.get("offset", 0))); limit = max(1, min(int(args.get("limit", 150)), 250))
        page = changes[offset:offset + limit]; end = offset + len(page)
        return {"base": base, "head": head, "files": page, "total": len(changes),
                "next_offset": end if end < len(changes) else None}

    def read_diff(self, args: dict) -> dict:
        base = self._revision(str(args.get("from_revision") or "base"))
        head = self._revision(str(args.get("to_revision") or "head"))
        context = max(0, min(int(args.get("context_lines", 3)), 30))
        command = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", f"--unified={context}", base, head, "--"]
        paths = args.get("paths") or []
        if not isinstance(paths, list) or any(not isinstance(p, str) or "\0" in p for p in paths):
            raise RepositoryToolError("paths must be exact repository paths.")
        patch = self._git(*command, *paths).decode("utf-8", errors="replace")
        return {"base": base, "head": head, **text_page(patch, args)}

    def read_context(self, args: dict) -> dict:
        section = str(args.get("section") or "meta")
        if section not in ("meta", "files", "groups", "architecture", "overview", "ai", "review_state", "previous_ai"):
            raise RepositoryToolError("Choose meta, files, groups, architecture, overview, ai, review_state, or previous_ai.")
        return {"section": section, **text_page(json.dumps(self.context.get(section), ensure_ascii=False), args)}

    def read_history(self, args: dict) -> dict:
        sha = self._revision(str(args.get("revision") or "head"))
        skip = max(0, int(args.get("offset", 0))); limit = max(1, min(int(args.get("limit", 20)), 100))
        command = ["log", "--no-show-signature", f"--skip={skip}", f"--max-count={limit + 1}",
                   "--format=%H%x00%P%x00%aI%x00%s%x00", sha, "--"]
        if args.get("path"): command.append(str(args["path"]))
        fields = self._git(*command).decode("utf-8", errors="replace").split("\0")
        commits = []
        for i in range(0, len(fields) - 3, 4):
            commits.append({"sha": fields[i].strip(), "parents": fields[i + 1].split(),
                            "date": fields[i + 2], "subject": fields[i + 3]})
        return {"revision": sha, "commits": commits[:limit], "next_offset": skip + limit if len(commits) > limit else None}

    def read_github(self, args: dict) -> dict:
        return read_github(self.context.get("meta") or {}, args, self.github_cache)

    def _tool_specs(self) -> list[dict]:
        integer = {"type": "integer", "minimum": 0}
        string = {"type": "string"}
        revision = {"type": "string", "description": "head, base (merge-base), target, or a full available commit SHA"}
        page = {"offset": integer, "limit": {"type": "integer", "minimum": 1}}
        specs = [
            ("list_files", "List ALL tracked paths (including binary/symlink/submodule entries), paginated; no analysis-size or suffix exclusions.", {"revision": revision, "path_prefix": string, "path_contains": string, **page}, []),
            ("list_symbols", "Optional parser declarations at either revision. Empty results are not evidence of absent behavior.", {"revision": revision, "path": string, **page}, ["path"]),
            ("related_symbols", "Paginated cached head graph hints, not proof. Use search_source for missing relationships.", {"path": string, "line": integer, "offset": integer}, ["path"]),
            ("read_source", "Read exact numbered text. Continue with next_range (line/character column); no line clipping. Use read_text for original whitespace or read_blob for binary.", {"revision": revision, "path": string, "start_line": integer, "end_line": integer, "start_column": integer}, ["path"]),
            ("read_text", "Read exact UTF-8 text by character offset; paginate until next_offset is null, including long lines/large files.", {"revision": revision, "path": string, **page}, ["path"]),
            ("read_blob", "Read exact bytes as base64, paginated by byte offset. Supports binaries, symlink payloads, and non-UTF-8 files.", {"revision": revision, "path": string, **page}, ["path"]),
            ("search_source", "Search literal content over the ENTIRE tracked repository at a pinned revision. Paginate hits; read full source before claiming behavior.", {"revision": revision, "query": string, "path_prefix": string, "ignore_case": {"type": "boolean"}, **page}, ["query"]),
            ("list_changes", "Complete Git changed-path manifest between pinned merge-base and head, with rename/deletion paths; paginated.", page, []),
            ("read_diff", "Complete Git diff, paginated by character offset. Use both old/new paths for renames. Empty paths reads whole PR. No stored patch cap.", {"from_revision": revision, "to_revision": revision, "paths": {"type": "array", "items": string}, "context_lines": integer, **page}, []),
            ("read_context", "Full shared report context, including full PR body, graph, architecture, existing guide and previous group observations. Paginated JSON text.", {"section": string, **page}, []),
            ("read_history", "Paginated commit history, optionally for a path. Read any returned commit through revision-aware source/diff tools.", {"revision": revision, "path": string, **page}, []),
            ("read_github", "Read authenticated GitHub PR/issue context, comments/reviews, commits, checks/statuses, workflows, or linked repository source. No writes. Pages and text continuations are explicit.", {"resource": string, "owner": string, "repo": string, "number": integer, "revision": string, "path": string, "sha": string, "page": integer, "field": string, **page}, ["resource"]),
        ]
        return [{"name": name, "description": description,
                 "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
                 "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True,
                                 "openWorldHint": name == "read_github"}} for name, description, properties, required in specs]

    def call_tool(self, name: str, args: dict) -> dict:
        if not isinstance(args, dict): raise RepositoryToolError("Tool arguments must be a JSON object.")
        if name not in TOOL_NAMES: raise RepositoryToolError("That repository tool is not available.")
        return getattr(self, name)(args)


def _send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def serve(root: Path, head: str, audit_path: Path, base: str | None = None, context: dict | None = None) -> None:
    tools = RepositoryTools(root, head, audit_path, base, context)
    specs = tools._tool_specs()
    for raw in sys.stdin:
        try:
            packet = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(packet, dict): continue
        request_id = packet.get("id")
        method = packet.get("method")
        if request_id is None:
            continue
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": request_id,
                   "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {"listChanged": False}},
                              "serverInfo": {"name": "prism_repository", "version": "0.2.0"}}})
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": specs}})
        elif method == "tools/call":
            params = packet.get("params") or {}
            if not isinstance(params, dict): params = {}
            try:
                payload = tools.call_tool(str(params.get("name") or ""), params.get("arguments") or {})
                _send({"jsonrpc": "2.0", "id": request_id,
                       "result": {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=True)}],
                                  "structuredContent": payload, "isError": False}})
            except (RepositoryToolError, ValueError, TypeError, OverflowError, UnicodeError, OSError) as exc:
                _send({"jsonrpc": "2.0", "id": request_id,
                       "result": {"content": [{"type": "text", "text": str(exc)}], "isError": True}})
        elif method == "shutdown":
            _send({"jsonrpc": "2.0", "id": request_id, "result": None})
        else:
            _send({"jsonrpc": "2.0", "id": request_id,
                   "error": {"code": -32601, "message": "Method not found"}})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--base", default=None)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--context", type=Path)
    args = parser.parse_args()
    try:
        context = json.loads(args.context.read_text(encoding="utf-8")) if args.context else {}
        serve(args.root, args.head, args.audit, args.base, context)
    except RepositoryToolError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
