"""Graphify extraction, precise changed-symbol annotation and PR-scoped graph segmentation."""
from __future__ import annotations
from collections import defaultdict, deque
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
from . import settings
from .symbols import LANGUAGES, changed_symbols, scan_symbols


def _norm_path(raw: str, root: Path) -> str:
    path = Path(raw)
    if path.is_absolute():
        try:
            return path.relative_to(root).as_posix()
        except ValueError:
            return path.as_posix()
    return path.as_posix().removeprefix("./")


def snapshot(root: Path, cache_root: Path, sha: str, progress=lambda x: None) -> dict:
    try:
        package_version = importlib.metadata.version("graphifyy")
    except importlib.metadata.PackageNotFoundError as exc:
        raise RuntimeError("Graphify isn't installed. Run ./setup.sh to install project dependencies.") from exc
    cache = cache_root / f"graph-v2-{sha}-{package_version}.json"
    if cache.exists():
        progress("Loading cached knowledge graph")
        return json.loads(cache.read_text())
    from graphify.extract import collect_files, extract
    progress("Scanning repository source files")
    files = []
    total = 0
    for p in collect_files(root):
        path = Path(p)
        if not path.is_absolute():
            path = root / path
        if not path.is_file() or path.is_symlink() or path.suffix.lower() not in LANGUAGES:
            continue
        size = path.stat().st_size
        if size > settings.MAX_FILE_BYTES:
            continue
        total += size
        if total > settings.MAX_TOTAL_BYTES or len(files) >= settings.MAX_FILES:
            raise RuntimeError(f"Repository exceeds analysis limit ({settings.MAX_FILES} code files / {settings.MAX_TOTAL_BYTES // 1_000_000} MB). Increase PRISM_MAX_FILES / PRISM_MAX_TOTAL_BYTES to analyze it.")
        files.append(path)
    if not files:
        progress("No symbol parser for these files; continuing with file-level review")
        return {"nodes":[], "edges":[], "files_indexed":0, "engine":"file-only", "version":package_version}
    progress(f"Graphify: extracting relationships from {len(files)} source files")
    extraction = extract(files, root=root)
    if not isinstance(extraction, dict) or "nodes" not in extraction or "edges" not in extraction:
        raise RuntimeError("Graphify returned an unexpected extraction format")
    nodes = []
    seen = set()
    for raw in extraction["nodes"]:
        if not isinstance(raw, dict) or not raw.get("id") or raw["id"] in seen:
            continue
        seen.add(raw["id"])
        n = {"id":raw["id"],"label":str(raw.get("label") or raw["id"]),
             "path":_norm_path(str(raw.get("source_file") or ""),root),
             "line":int((re.search(r"\d+",str(raw.get("source_location") or "")) or ["0"])[0]),
             "kind":str(raw.get("type") or raw.get("kind") or "symbol"),"status":"context"}
        nodes.append(n)
    edges = []
    edge_seen = set()
    for raw in extraction["edges"]:
        s, t = str(raw.get("source", "")), str(raw.get("target", ""))
        if s not in seen or t not in seen or s == t:
            continue
        key = (s,t,str(raw.get("relation") or "references"))
        if key not in edge_seen:
            edge_seen.add(key)
            edges.append({"source":s,"target":t,"relation":key[2],"confidence":str(raw.get("confidence") or "EXTRACTED")})
    data = {"nodes":nodes,"edges":edges,"files_indexed":len(files),"engine":"graphifyy", "version":package_version}
    cache_root.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(cache)
    return data


def identify_changes(files: list[dict], before: Path, after: Path, old_graph: dict, new_graph: dict) -> tuple[list[dict],list[dict],list[dict]]:
    """Annotate graph nodes using AST ranges; augment unmatched symbols rather than guessing."""
    nodes = {n["id"]:dict(n) for n in new_graph["nodes"]}
    # Compare relationship topology at the two revisions. Old-only edges remain
    # visible as deleted relationships, with old-only endpoints retained.
    old_edge_keys = {(e["source"],e["target"],e["relation"]) for e in old_graph["edges"]}
    new_edge_keys = {(e["source"],e["target"],e["relation"]) for e in new_graph["edges"]}
    edges = [{**e,"status":"unchanged" if (e["source"],e["target"],e["relation"]) in old_edge_keys else "added"} for e in new_graph["edges"]]
    previous = {n["id"]:n for n in old_graph["nodes"]}
    for old_edge in old_graph["edges"]:
        key=(old_edge["source"],old_edge["target"],old_edge["relation"])
        if key not in new_edge_keys:
            edges.append({**old_edge,"status":"removed"})
            for nid in (old_edge["source"],old_edge["target"]):
                if nid not in nodes and nid in previous:
                    nodes[nid]={**previous[nid],"status":"context"}
    files_to_nodes: dict[str,list[dict]] = defaultdict(list)
    for n in nodes.values():
        files_to_nodes[n["path"]].append(n)
    changed_ids = set()
    for f in files:
        new_path, old_path = f["path"],f["old_path"]
        # Deleted symbols come from before; changed ranges on the new side from after.
        symbols_new = changed_symbols(after,new_path,f["new_ranges"]) if f["status"] != "deleted" else []
        symbols_old = changed_symbols(before,old_path,f["old_ranges"]) if f["status"] != "added" else []
        new_catalog = {(s["kind"],s["qualified"]):s for s in scan_symbols(after,new_path)}
        old_catalog = {(s["kind"],s["qualified"]):s for s in scan_symbols(before,old_path)}
        # Old hunks that removed text inside a still-existing symbol are modifications,
        # not deletions. Only old-side symbols truly missing at head are 'deleted'.
        only_old = [s for s in symbols_old if (s["kind"],s["qualified"]) not in new_catalog]
        old_modified = [new_catalog[(s["kind"],s["qualified"])] for s in symbols_old
                        if (s["kind"],s["qualified"]) in new_catalog]
        combined_new = { (s["kind"],s["qualified"]):s for s in [*symbols_new,*old_modified] }
        for side, sym_list in (("new", list(combined_new.values())),("old",only_old)):
            for sym in sym_list:
                key = (sym["kind"],sym["qualified"])
                status = ("added" if key not in old_catalog else "modified") if side == "new" else "deleted"
                # Prefer actual Graphify node when type/label/start location agree.
                candidates = files_to_nodes.get(new_path, []) if side == "new" else [n for n in previous.values() if n["path"] == old_path]
                matches = [n for n in candidates if n["label"].split(".")[-1] == sym["name"] and abs(n["line"]-sym["start"]) <= 3]
                chosen = min(matches, key=lambda n:abs(n["line"]-sym["start"])) if matches else None
                if chosen:
                    actual = nodes.get(chosen["id"])
                    if actual is None:
                        actual = {**chosen}
                        nodes[chosen["id"]] = actual
                    actual["kind"] = sym["kind"]
                    actual["status"] = status
                    actual["end"] = sym["end"]
                    changed_ids.add(actual["id"])
                else:
                    nid = f"ast:{old_path if side=='old' and status=='deleted' else new_path}:{sym['kind']}:{sym['qualified']}"
                    node = {"id":nid,"label":sym["name"],"qualified":sym["qualified"],
                            "path":old_path if status=="deleted" else new_path,
                            "line":sym["start"],"end":sym["end"],"kind":sym["kind"],"status":status}
                    if nid in nodes:
                        nodes[nid]["status"] = "modified" if status != nodes[nid]["status"] else status
                    else:
                        nodes[nid] = node
                        # Ground synthetically generated nodes in the file graph node if available.
                        file_match = next((n for n in candidates if n["kind"] in ("file","module") or n["label"] == Path(new_path).stem), None)
                        if file_match:
                            edges.append({"source":file_match["id"],"target":nid,"relation":"contains", "confidence":"AST"})
                    changed_ids.add(nid)
        if not combined_new and not only_old:
            # Graphify can still show the changed file even if grammar is unavailable.
            ident = f"filechange:{new_path or old_path}"
            nodes[ident] = {"id":ident,"label":Path(new_path or old_path).name,"path":new_path or old_path,
                            "line":f["new_ranges"][0][0] if f["new_ranges"] else 0,
                            "kind":"file","status":f["status"]}
            changed_ids.add(ident)
            for neighbor in files_to_nodes.get(new_path, [])[:8]:
                edges.append({"source":ident,"target":neighbor["id"],"relation":"contains", "confidence":"FILE"})
    return list(nodes.values()), edges, sorted(changed_ids)


def segment(nodes: list[dict], edges: list[dict], changed_ids: list[str], files: list[dict], max_nodes=130) -> tuple[list[dict],dict]:
    by_id = {n["id"]:n for n in nodes}
    changed = set(changed_ids)
    neighbor_map: dict[str,set] = defaultdict(set)
    for e in edges:
        a,b=e["source"],e["target"]
        if a in by_id and b in by_id:
            neighbor_map[a].add(b);neighbor_map[b].add(a)
    # Only use direct code-level links or same-file changes for clustering;
    # don't merge the whole PR through generic file/module hubs.
    parent = {nid:nid for nid in changed}
    def find(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n
    def union(a,b):
        ra,rb=find(a),find(b)
        if ra != rb: parent[rb]=ra
    path_groups = defaultdict(list)
    for nid in changed:
        path_groups[by_id[nid]["path"]].append(nid)
    for group in path_groups.values():
        for nid in group[1:]: union(group[0],nid)
    for a in changed:
        for b in neighbor_map[a]:
            if b in changed:
                union(a,b)
            elif by_id[b]["kind"] not in ("file", "module", "directory") and len(neighbor_map[b]) <= 16:
                for c in (neighbor_map[b] & changed):
                    union(a,c)
    groups = defaultdict(list)
    for nid in sorted(changed):
        groups[find(nid)].append(nid)
    # Make a separate contextual subgraph for each cluster, plus all-changes.
    def make_graph(ids: list[str], limit=max_nodes):
        selected = set(ids)
        for nid in ids:
            for nb in sorted(neighbor_map[nid],key=lambda x:(by_id[x]["kind"] in ("file","module","directory"),-len(neighbor_map[x])))[:5]:
                if len(selected) < limit: selected.add(nb)
        return {"nodes":[by_id[n] for n in sorted(selected)],
                "edges":[e for e in edges if e["source"] in selected and e["target"] in selected],
                "truncated":len(selected)>=limit}
    output=[]
    ordered = sorted(groups.values(),key=lambda ns:(-len(ns),sorted(ns)[0]))
    # Oversized connected components are partitioned using their actual
    # structural relationships, rather than dropping nodes from one huge map.
    partitioned = []
    for component in ordered:
        if len(component) <= 22:
            partitioned.append(component)
            continue
        import networkx as nx
        H=nx.Graph()
        H.add_nodes_from(component)
        component_set=set(component)
        for a in component:
            for b in neighbor_map[a] & component_set:
                H.add_edge(a,b,weight=2 if by_id[a]["path"]!=by_id[b]["path"] else 1)
        if H.number_of_edges():
            communities=[sorted(c) for c in nx.community.greedy_modularity_communities(H,weight="weight")]
        else:
            communities=[sorted(component)]
        for community in communities:
            remaining=set(community)
            while remaining:
                start=max(sorted(remaining),key=lambda n:len(neighbor_map[n] & remaining))
                chunk=[]
                queue=deque([start])
                queued={start}
                while queue and len(chunk)<22:
                    node=queue.popleft()
                    if node not in remaining:continue
                    remaining.remove(node)
                    chunk.append(node)
                    for next_id in sorted(neighbor_map[node] & remaining, key=lambda n:-len(neighbor_map[n] & remaining)):
                        if next_id not in queued:
                            queued.add(next_id);queue.append(next_id)
                partitioned.append(sorted(chunk))
    for idx,ids in enumerate(partitioned):
        paths = sorted({by_id[n]["path"] for n in ids})
        common = Path(paths[0]).parent.name if paths else "Changes"
        lead = by_id[ids[0]]["label"] if ids else "Change"
        title = (common.replace("_", " ").replace("-", " ").title() if common not in (".", "", "src", "lib", "app") else lead)
        if len(partitioned)>1 and sum(1 for other in partitioned if {by_id[n]["path"] for n in other} == set(paths))>1:
            title += f" · Part {1 + sum(1 for prior in partitioned[:idx] if {by_id[n]["path"] for n in prior} == set(paths))}"
        gid = hashlib.sha256("|".join(ids).encode()).hexdigest()[:10]
        output.append({"id":gid,"title":title,"changed_count":len(ids),
                       "files":paths,"changed_ids":ids,"graph":make_graph(ids)})
    overview = make_graph(changed_ids,limit=260)
    return output, overview
