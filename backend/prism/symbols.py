"""Map zero-context diff hunks to Tree-sitter declaration *ranges* (not just start lines)."""
from __future__ import annotations
import importlib
from pathlib import Path

LANGUAGES = {
 ".py": ("tree_sitter_python", "language"),
 ".js": ("tree_sitter_javascript", "language"), ".jsx": ("tree_sitter_javascript", "language"),
 ".ts": ("tree_sitter_typescript", "language_typescript"), ".tsx": ("tree_sitter_typescript", "language_tsx"),
 ".go": ("tree_sitter_go", "language"), ".java": ("tree_sitter_java", "language"),
 ".rs": ("tree_sitter_rust", "language"), ".rb": ("tree_sitter_ruby", "language"),
 ".c": ("tree_sitter_c", "language"), ".h": ("tree_sitter_cpp", "language"),
 ".cpp": ("tree_sitter_cpp", "language"), ".cc": ("tree_sitter_cpp", "language"),
 ".cs": ("tree_sitter_c_sharp", "language"),
 ".swift": ("tree_sitter_swift", "language"),
 ".kt": ("tree_sitter_kotlin", "language"),
 ".php": ("tree_sitter_php", "language_php"),
}
CLASS_TYPES = {"class_definition", "class_declaration", "class_expression", "interface_declaration", "interface_definition", "struct_item", "enum_item", "trait_item", "type_declaration", "class_specifier", "struct_specifier", "object_declaration", "record_declaration", "impl_item", "module"}
FUNCTION_TYPES = {"function_definition", "function_declaration", "method_definition", "method_declaration", "method_signature", "constructor_declaration", "function_item", "method_declaration", "function_signature", "arrow_function", "function_expression"}


def scan_symbols(root: Path, path: str) -> list[dict]:
    full_path = root / path
    if not full_path.is_file() or full_path.is_symlink() or full_path.stat().st_size > 600_000:
        return []
    try:
        source = full_path.read_bytes()
    except OSError:
        return []
    return scan_source(source, path)


def scan_source(source: bytes, path: str) -> list[dict]:
    """Return Tree-sitter declarations from source bytes, independent of the worktree."""
    definition = LANGUAGES.get(Path(path).suffix.lower())
    if not definition:
        return []
    try:
        from tree_sitter import Language, Parser
        module = importlib.import_module(definition[0])
        language = Language(getattr(module, definition[1])())
        parser = Parser(language)
        root_node = parser.parse(source).root_node
    except (ImportError, AttributeError, TypeError, ValueError, OSError):
        return []
    found = []
    def visit(node, scope: list[str]):
        kind = "class" if node.type in CLASS_TYPES else "method" if node.type in FUNCTION_TYPES and scope else "function" if node.type in FUNCTION_TYPES else None
        new_scope = scope
        if kind:
            name_node = node.child_by_field_name("name") or node.child_by_field_name("declarator")
            name = source[name_node.start_byte:name_node.end_byte].decode("utf-8", errors="replace")[:110] if name_node else ""
            if not name and node.type in ("constructor_declaration",):
                name = "constructor"
            if name:
                name = name.split("(")[0].strip().split()[-1]
                qualified = ".".join([*scope, name])
                found.append({"path": path, "name": name, "qualified": qualified,
                              "kind": kind, "start": node.start_point.row + 1,
                              "end": node.end_point.row + 1, "parent": ".".join(scope) or None})
                if kind == "class":
                    new_scope = [*scope, name]
        for child in node.named_children:
            visit(child, new_scope)
    visit(root_node, [])
    return found


def changed_symbols(root: Path, path: str, ranges: list[list[int]]) -> list[dict]:
    symbols = scan_symbols(root, path)
    hits = []
    for a, b in ranges:
        overlapping = [s for s in symbols if s["start"] <= b and a <= s["end"]]
        if overlapping:
            # Include every declaration touched by the hunk. A whole-file hunk
            # can add many sibling functions; choosing one loses review content.
            selected = overlapping
            for item in selected:
                if not any(x["qualified"] == item["qualified"] and x["kind"] == item["kind"] for x in hits):
                    hits.append(item)
    return hits
