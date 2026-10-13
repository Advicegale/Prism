"""Read-only, tracked-source tools for model-led repository exploration."""
from __future__ import annotations

import argparse
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
    from prism.sourcefiles import eligible_path
else:
    from . import settings
    from .symbols import LANGUAGES, scan_source
    from .sourcefiles import eligible_path

_SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "vendor", "dist", "build", "target", "coverage"}


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

    def __init__(self, root: Path, expected_head: str, audit_path: Path, expected_base: str | None = None):
        self.root = root.resolve()
        self.expected_head = expected_head
        self.audit_path = audit_path
        self.expected_base = expected_base
        self.base_files = None
        self.next_source_id = 1
        self.inventory_limited = False
        self.files = self._tracked_sources()
        self.cache: dict[str, list[str]] = {}
        self.symbol_cache: dict[str, list[dict]] = {}
        self.graph_loaded = False
        self.graph: dict | None = None

    def _tracked_sources(self, revision: str | None = None) -> dict[str, tuple[Path, int]]:
        try:
            head = subprocess.run(
                ["git", "-C", str(self.root), "rev-parse", "--verify", "HEAD^{commit}"],
                capture_output=True, text=True, timeout=10, check=False,
            )
            if head.returncode or head.stdout.strip().lower() != self.expected_head:
                raise RepositoryToolError("The repository tools are not pointed at the report's PR-head revision.")
            result = subprocess.run(
                ["git", "-C", str(self.root), "ls-tree", "-rz", "--full-tree", revision or self.expected_head],
                capture_output=True, timeout=15, check=False,
                env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RepositoryToolError("Could not inspect tracked files in the cached PR checkout.") from exc
        if result.returncode:
            raise RepositoryToolError("Could not inspect tracked files in the cached PR checkout.")

        candidates: list[tuple[str, str]] = []
        for raw in result.stdout.split(b"\0"):
            if not raw or b"\t" not in raw:
                continue
            header, path_bytes = raw.split(b"\t", 1)
            fields = header.decode("ascii", errors="ignore").split()
            if len(fields) != 3:
                continue
            mode, kind, oid = fields
            relative = os.fsdecode(path_bytes).replace("\\", "/")
            pure = PurePosixPath(relative)
            if (mode not in ("100644", "100755") or kind != "blob" or pure.is_absolute()
                    or ".." in pure.parts or _SKIP_DIRS.intersection(pure.parts)
                    or not eligible_path(relative)):
                continue
            candidates.append((relative, oid))

        if not candidates:
            return {}
        try:
            sizes = subprocess.run(
                ["git", "-C", str(self.root), "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
                input=("\n".join(oid for _path, oid in candidates) + "\n").encode("ascii"),
                capture_output=True, timeout=30, check=False,
                env={**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1"},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RepositoryToolError("Could not inspect source sizes in the cached PR commit.") from exc
        if sizes.returncode:
            raise RepositoryToolError("Could not inspect source sizes in the cached PR commit.")
        size_rows = sizes.stdout.decode("ascii", errors="replace").splitlines()
        if len(size_rows) != len(candidates):
            raise RepositoryToolError("Git returned an incomplete source inventory for the cached PR commit.")

        files: dict[str, tuple[str, int]] = {}
        total = 0
        for (relative, oid), size_row in zip(candidates, size_rows):
            try:
                row_oid, kind, size_text = size_row.split()
                size = int(size_text)
            except (ValueError, TypeError):
                self.inventory_limited = True
                continue
            if row_oid != oid or kind != "blob":
                self.inventory_limited = True
                continue
            if size <= 0 or size > settings.MAX_FILE_BYTES:
                self.inventory_limited = True
                continue
            if len(files) >= settings.MAX_FILES or total + size > settings.MAX_TOTAL_BYTES:
                self.inventory_limited = True
                break
            files[relative] = (oid, size)
            total += size
        return files

    def _inventory(self, side: str = "head") -> dict:
        if side == "head": return self.files
        if side != "base" or not self.expected_base or not re.fullmatch(r"[a-f0-9]{40}", self.expected_base):
            raise RepositoryToolError("This run has no base revision available.")
        if self.base_files is None: self.base_files = self._tracked_sources(self.expected_base)
        return self.base_files

    def _blob(self, relative: str, side: str = "head") -> bytes:
        item = self._inventory(side).get(relative)
        if item is None:
            raise RepositoryToolError("Choose a tracked, supported source file from this PR checkout.")
        oid, expected_size = item
        try:
            result = subprocess.run(
                ["git", "-C", str(self.root), "cat-file", "blob", oid],
                capture_output=True, timeout=15, check=False,
                env={**os.environ, "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1"},
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RepositoryToolError("Could not read that source file from the PR commit.") from exc
        if result.returncode or len(result.stdout) != expected_size:
            raise RepositoryToolError("Could not read that source file from the PR commit.")
        return result.stdout

    def _lines(self, relative: str, side: str = "head") -> list[str]:
        cache_key = side + ":" + relative
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            raw = self._blob(relative, side)
            if b"\0" in raw: raise RepositoryToolError("This file contains binary data.")
            lines = raw.decode("utf-8").splitlines()
        except UnicodeError as exc:
            raise RepositoryToolError("Could not read that source file as UTF-8.") from exc
        self.cache[cache_key] = lines
        return lines

    @staticmethod
    def _clip_line(line: str) -> str:
        return line if len(line) <= 300 else line[:300] + " … [line clipped]"

    def _source(self, relative: str, start: int, end: int, code: str, side: str = "head") -> dict:
        source_id = f"R{self.next_source_id}"
        self.next_source_id += 1
        record = {"source_id": source_id, "path": relative, "line": start, "end_line": end, "side": side}
        with self.audit_path.open("a", encoding="utf-8") as audit:
            audit.write(json.dumps(record, ensure_ascii=False) + "\n")
        return {**record, "code": code}

    def list_files(self, args: dict) -> dict:
        files = self._inventory(str(args.get("revision") or "head"))
        prefix = str(args.get("path_prefix") or "").replace("\\", "/").lstrip("/")
        if ".." in PurePosixPath(prefix).parts:
            raise RepositoryToolError("Path prefixes cannot leave the repository.")
        offset = max(0, min(int(args.get("offset", 0)), len(files)))
        limit = max(1, min(int(args.get("limit", 150)), 250))
        directory_prefix = prefix.rstrip("/") + "/" if prefix else ""
        paths = [path for path in files
                 if not prefix or path == prefix.rstrip("/") or path.startswith(directory_prefix)]
        page = paths[offset:offset + limit]
        next_offset = offset + len(page)
        return {"files": page, "total_matching": len(paths),
                "next_offset": next_offset if next_offset < len(paths) else None,
                "inventory_limited": self.inventory_limited}

    def list_symbols(self, args: dict) -> dict:
        relative = str(args.get("path") or "").replace("\\", "/")
        if relative not in self.files:
            raise RepositoryToolError("Choose one tracked source path from list_files.")
        symbols = self.symbol_cache.get(relative)
        if symbols is None:
            symbols = scan_source(self._blob(relative), relative)
            self.symbol_cache[relative] = symbols
        offset = max(0, min(int(args.get("offset", 0)), len(symbols)))
        limit = max(1, min(int(args.get("limit", 120)), 200))
        page = symbols[offset:offset + limit]
        next_offset = offset + len(page)
        return {"path": relative, "symbols": page, "total": len(symbols),
                "next_offset": next_offset if next_offset < len(symbols) else None}

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
                "relationships": links[:40],
                "note": "Graph relationships are navigation hints; read the returned source before relying on them."}

    def read_source(self, args: dict) -> dict:
        relative = str(args.get("path") or "").replace("\\", "/")
        pure = PurePosixPath(relative)
        side = str(args.get("revision") or "head")
        if pure.is_absolute() or ".." in pure.parts or relative not in self._inventory(side):
            raise RepositoryToolError("Choose a tracked, supported source file from list_files or list_symbols.")
        lines = self._lines(relative, side)
        start = int(args.get("start_line", 1))
        end = int(args.get("end_line", start + 39))
        if start < 1 or end < start or end - start >= 80:
            raise RepositoryToolError("Read a valid range of at most 80 source lines.")
        if start > len(lines):
            raise RepositoryToolError(f"{relative} has only {len(lines)} lines.")
        end = min(end, len(lines))
        code = "\n".join(f"{number:>5}: {self._clip_line(lines[number - 1])}"
                          for number in range(start, end + 1))
        return self._source(relative, start, end, code, side)

    def _tool_specs(self) -> list[dict]:
        annotations = {"readOnlyHint": True, "destructiveHint": False,
                       "idempotentHint": True, "openWorldHint": False}
        return [
            {"name": "list_files", "description": "List bounded tracked text/source paths at the exact head or optional base revision, independent of language. Use path_prefix to browse a directory and offset to continue. If inventory_limited is true, Prism's repository size limits omitted some files.",
             "inputSchema": {"type": "object", "properties": {
                 "revision": {"type": "string", "enum": ["head", "base"]}, "path_prefix": {"type": "string"}, "offset": {"type": "integer", "minimum": 0},
             "limit": {"type": "integer", "minimum": 1, "maximum": 250}}, "additionalProperties": False},
             "annotations": annotations},
            {"name": "list_symbols", "description": "List exact Tree-sitter declarations (classes, methods and functions) in one tracked source file. Use this after browsing paths with list_files; returns source ranges for follow-up reads.",
             "inputSchema": {"type": "object", "properties": {
                 "path": {"type": "string"}, "offset": {"type": "integer", "minimum": 0},
                 "limit": {"type": "integer", "minimum": 1, "maximum": 200}},
                 "required": ["path"], "additionalProperties": False}, "annotations": annotations},
            {"name": "related_symbols", "description": "Show Graphify relationships connected to symbols in one tracked source file, or nearest one to a supplied line. Use returned paths and lines to read the implementations before drawing conclusions.",
             "inputSchema": {"type": "object", "properties": {
                 "path": {"type": "string"}, "line": {"type": "integer", "minimum": 1}},
                 "required": ["path"], "additionalProperties": False}, "annotations": annotations},
            {"name": "read_source", "description": "Read an exact range of up to 80 lines from tracked text in any language. revision defaults to head; base is available when supplied by the caller. Returns line-numbered code and a source ID for citations. Read large implementations in adjacent ranges.",
             "inputSchema": {"type": "object", "properties": {
                 "revision": {"type": "string", "enum": ["head", "base"]}, "path": {"type": "string"}, "start_line": {"type": "integer", "minimum": 1},
                 "end_line": {"type": "integer", "minimum": 1}},
                 "required": ["path", "start_line", "end_line"], "additionalProperties": False},
             "annotations": annotations},
        ]

    def call_tool(self, name: str, args: dict) -> dict:
        functions = {"list_files": self.list_files,
                     "list_symbols": self.list_symbols,
                     "related_symbols": self.related_symbols,
                     "read_source": self.read_source}
        function = functions.get(name)
        if function is None:
            raise RepositoryToolError("That repository tool is not available.")
        return function(args)


def _send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve(root: Path, head: str, audit_path: Path, base: str | None = None) -> None:
    tools = RepositoryTools(root, head, audit_path, base)
    specs = tools._tool_specs()
    for raw in sys.stdin:
        try:
            packet = json.loads(raw)
        except (ValueError, TypeError):
            continue
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
            try:
                payload = tools.call_tool(str(params.get("name") or ""), params.get("arguments") or {})
                _send({"jsonrpc": "2.0", "id": request_id,
                       "result": {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
                                  "structuredContent": payload, "isError": False}})
            except (RepositoryToolError, ValueError, TypeError) as exc:
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
    args = parser.parse_args()
    try:
        serve(args.root, args.head, args.audit, args.base)
    except RepositoryToolError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
