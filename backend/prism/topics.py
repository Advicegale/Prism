"""Reviewer-facing roll-ups over verified change groups and graph data."""
from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
from math import ceil
from pathlib import PurePosixPath
import re


_FAMILY_TITLES = {
    "application": "Application code",
    "backend": "Backend code",
    "configuration": "Configuration",
    "database": "Database changes",
    "documentation": "Documentation",
    "frontend": "Frontend code",
    "other": "Other changes",
    "server": "Server code",
    "tests": "Tests",
}

# Structural containment describes file organization, not a useful dependency
# for a reviewer to follow. Keep meaningful calls/imports/references as context.
_NON_DEPENDENCY_RELATIONS = {
    "contains", "contained_by", "parent_of", "child_of", "defines", "defined_in",
    "has_member", "member_of", "file_contains", "directory_contains",
}
_CONTEXT_RELATION_WEIGHTS = {
    "calls": 3, "called_by": 3, "imports": 3, "imports_from": 3,
    "uses": 3, "depends_on": 3, "extends": 3, "implements": 3,
    "references": 2, "references_from": 2,
}


def _file_family(raw_path: str) -> str:
    path = PurePosixPath(raw_path.replace("\\", "/"))
    parts = [part.lower() for part in path.parts]
    name = path.name.lower()
    suffix = path.suffix.lower()

    if any(part in {"test", "tests", "__tests__", "spec", "specs"} for part in parts) or re.search(r"(?:^|[._-])(test|spec)(?:[._-]|$)", name):
        return "tests"
    if "docs" in parts or "documentation" in parts or suffix in {".md", ".mdx", ".rst", ".adoc"}:
        return "documentation"
    if any(part in {"migrations", "migration", "schema", "schemas", "database", "db"} for part in parts):
        return "database"
    if any(part in {"config", "configs", "configuration"} for part in parts) or name.startswith(".env") or suffix in {".toml", ".yaml", ".yml", ".ini"}:
        return "configuration"

    root = parts[0] if parts else ""
    if root in {"server", "api"}:
        return "server"
    if root in {"backend", "back-end"}:
        return "backend"
    if root in {"frontend", "front-end", "client", "web"}:
        return "frontend"
    if root in {"src", "app", "lib", "packages", "pkg"} or not root:
        return "application"
    return "other"


def _fallback_assignments(groups: list[dict]) -> list[dict]:
    buckets: dict[str, list[str]] = defaultdict(list)
    for group in groups:
        family_counts = Counter(_file_family(path) for path in group.get("files", []))
        family = min(family_counts, key=lambda key: (-family_counts[key], key)) if family_counts else "other"
        buckets[family].append(group["id"])
    order = ["application", "frontend", "backend", "server", "database", "tests", "documentation", "configuration", "other"]
    return [
        {"title": _FAMILY_TITLES[family], "group_ids": sorted(buckets[family]), "source": "paths"}
        for family in order if buckets.get(family)
    ]


def _check_suggestions(suggestions: object, groups: list[dict]) -> tuple[list[dict] | None, list[str]]:
    """Return (accepted topics or None, issue codes explaining any rejection or adjustment)."""
    if suggestions is None:
        return None, ["no_suggestions"]
    if not isinstance(suggestions, list):
        return None, ["not_a_list"]
    if not suggestions:
        return None, ["no_suggestions"]
    group_ids = {group["id"] for group in groups}
    max_topics = min(len(group_ids), max(5, ceil(len(group_ids) / 3)))
    if len(suggestions) > max_topics:
        return None, ["too_many_topics"]

    assigned: set[str] = set()
    result = []
    issues: list[str] = []
    for topic in suggestions:
        if not isinstance(topic, dict):
            return None, ["topic_not_object"]
        title = topic.get("title")
        focus = topic.get("focus", "")
        members = topic.get("group_ids")
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 80:
            return None, ["bad_title"]
        if not isinstance(members, list) or not members:
            return None, ["bad_members"]
        # A bad optional explanation must not discard an otherwise valid partition.
        focus_was_set = focus is not None and (not isinstance(focus, str) or focus.strip() != "")
        focus = focus.strip() if isinstance(focus, str) else ""
        if len(focus) > 180 or "\n" in focus or "\r" in focus:
            focus = ""
        if focus_was_set and not focus:
            issues.append("focus_cleared")
        normalized = []
        for group_id in members:
            if not isinstance(group_id, str):
                return None, ["bad_members"]
            if group_id not in group_ids:
                return None, ["unknown_group"]
            if group_id in assigned:
                return None, ["duplicate_group"]
            assigned.add(group_id)
            normalized.append(group_id)
        result.append({"title": title.strip(), "focus": focus, "group_ids": sorted(normalized), "source": "ai"})
    if assigned != group_ids:
        return None, ["missing_groups"]
    return result, list(dict.fromkeys(issues))


def _validated_suggestions(suggestions: object, groups: list[dict]) -> list[dict] | None:
    return _check_suggestions(suggestions, groups)[0]


def _stable_id(group_ids: list[str]) -> str:
    return hashlib.sha256("|".join(sorted(group_ids)).encode()).hexdigest()[:12]


def _make_topic(assignment: dict, by_group_id: dict[str, dict], overview: dict) -> dict:
    groups = [by_group_id[group_id] for group_id in assignment["group_ids"]]
    changed_ids = sorted({symbol_id for group in groups for symbol_id in group.get("changed_ids", [])})
    files = sorted({path for group in groups for path in group.get("files", [])})

    nodes: dict[str, dict] = {}
    edges: dict[tuple[str, str, str], dict] = {}
    truncated = False
    for group in groups:
        graph = group.get("graph", {})
        truncated = truncated or bool(graph.get("truncated"))
        for node in graph.get("nodes", []):
            nodes.setdefault(node["id"], node)
        for edge in graph.get("edges", []):
            key = (edge["source"], edge["target"], edge.get("relation", "references"))
            edges.setdefault(key, edge)

    # The all-change graph can retain real cross-group links omitted from a
    # single group's local graph; all members still have to be report nodes.
    for node in overview.get("nodes", []):
        nodes.setdefault(node["id"], node)
    for edge in overview.get("edges", []):
        key = (edge["source"], edge["target"], edge.get("relation", "references"))
        edges.setdefault(key, edge)

    changed = set(changed_ids)
    context_scores: Counter[str] = Counter()
    for edge in edges.values():
        relation = str(edge.get("relation", "")).strip().lower().replace(" ", "_")
        if relation in _NON_DEPENDENCY_RELATIONS:
            continue
        weight = _CONTEXT_RELATION_WEIGHTS.get(relation, 1)
        source, target = edge["source"], edge["target"]
        if source in changed and target in nodes and target not in changed and nodes[target].get("status") == "context":
            context_scores[target] += weight
        if target in changed and source in nodes and source not in changed and nodes[source].get("status") == "context":
            context_scores[source] += weight

    context_limit = min(12, max(4, ceil(len(changed_ids) / 2)))
    selected_context = {
        node_id for node_id, _score in sorted(
            context_scores.items(), key=lambda item: (-item[1], nodes[item[0]].get("path", ""), item[0])
        )[:context_limit]
    }
    included = changed | selected_context
    topic_nodes = [nodes[node_id] for node_id in sorted(included) if node_id in nodes]
    topic_edges = [
        edge for edge in edges.values()
        if edge["source"] in included and edge["target"] in included
    ]
    topic_edges.sort(key=lambda edge: (edge["source"], edge["target"], edge.get("relation", "references")))

    return {
        "id": _stable_id(assignment["group_ids"]),
        "title": assignment["title"],
        "focus": assignment.get("focus", ""),
        "source": assignment["source"],
        "group_ids": sorted(assignment["group_ids"]),
        "changed_count": len(changed_ids),
        "files": files,
        "graph": {"nodes": topic_nodes, "edges": topic_edges,
                  "truncated": truncated or len(context_scores) > len(selected_context)},
        "connections": [],
    }


def _topic_connections(topics: list[dict], overview: dict) -> None:
    owner: dict[str, str] = {}
    topic_by_id = {topic["id"]: topic for topic in topics}
    overview_nodes = {node["id"]: node for node in overview.get("nodes", [])}
    overview_degree: Counter[str] = Counter()
    for edge in overview.get("edges", []):
        overview_degree[edge["source"]] += 1
        overview_degree[edge["target"]] += 1
    for topic in topics:
        for node in topic["graph"]["nodes"]:
            if node.get("status", "modified") != "context":
                owner[node["id"]] = topic["id"]

    counts: Counter[tuple[str, str, str]] = Counter()
    context_topics: dict[str, set[str]] = defaultdict(set)
    context_degrees: Counter[str] = Counter()
    for edge in overview.get("edges", []):
        source_owner, target_owner = owner.get(edge["source"]), owner.get(edge["target"])
        if source_owner and target_owner and source_owner != target_owner:
            pair = tuple(sorted((source_owner, target_owner)))
            counts[(pair[0], pair[1], "direct")] += 1
        for changed_id, other_id in ((edge["source"], edge["target"]), (edge["target"], edge["source"])):
            other = overview_nodes.get(other_id, {})
            if (changed_id in owner and other_id not in owner and other.get("status") == "context"
                    and other.get("kind") not in {"file", "module", "directory"}):
                context_topics[other_id].add(owner[changed_id])
                context_degrees[other_id] += 1

    for node_id, related in context_topics.items():
        if len(related) < 2 or context_degrees[node_id] > 16 or overview_degree[node_id] > 16:
            continue
        ordered = sorted(related)
        for index, left in enumerate(ordered):
            for right in ordered[index + 1:]:
                counts[(left, right, "shared context")] += 1

    for (left, right, kind), count in counts.items():
        topic_by_id[left]["connections"].append({"topic_id": right, "count": count, "kind": kind})
        topic_by_id[right]["connections"].append({"topic_id": left, "count": count, "kind": kind})
    for topic in topics:
        topic["connections"].sort(key=lambda item: (-item["count"], topic_by_id[item["topic_id"]]["title"]))


def build_topics(groups: list[dict], overview: dict, suggestions: object = None,
                 review_order: object = None) -> list[dict]:
    """Build a compact parent layer; only accepted suggestions can change membership."""
    return build_topics_with_diagnostics(groups, overview, suggestions, review_order)[0]


def build_topics_with_diagnostics(groups: list[dict], overview: dict, suggestions: object = None,
                                  review_order: object = None) -> tuple[list[dict], dict]:
    """Same topics as build_topics, plus why the AI plan was used or replaced by path grouping."""
    if not groups:
        return [], {"source": "paths", "issues": [], "appended_paths": 0}
    accepted, issues = _check_suggestions(suggestions, groups)
    assignments = accepted or _fallback_assignments(groups)
    by_group_id = {group["id"]: group for group in groups}
    topics = [_make_topic(assignment, by_group_id, overview) for assignment in assignments]
    if isinstance(review_order, list):
        ranks = {
            step["path"]: index for index, step in enumerate(review_order)
            if isinstance(step, dict) and isinstance(step.get("path"), str)
        }
        topics.sort(key=lambda topic: min((ranks.get(path, float("inf")) for path in topic["files"]), default=float("inf")))
    _topic_connections(topics, overview)
    # appended_paths stays 0: _validated_steps does not report how many omitted paths it added.
    diagnostics = {"source": "ai" if accepted else "paths", "issues": issues, "appended_paths": 0}
    return topics, diagnostics
