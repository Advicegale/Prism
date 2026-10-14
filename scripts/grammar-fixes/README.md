# Corrections to Graphify's parser packages

The manifest pins the upstream source revision, package version and local version
for each corrected parser. The patch files contain only the grammar/scanner
changes; generated C parsers and compiled wheels stay outside the repository.
Upstream MIT licenses are retained in `licenses/` and in the cached sources/wheels.

`setup.sh` invokes `../install-parser-fixes.py` after installing Graphify's discovered
parser dependencies. To repair an existing environment:

```bash
backend/.venv/bin/python scripts/install-parser-fixes.py
```

The first build needs Git, Node.js, a C compiler and network access. The installer
downloads immutable upstream source archives and a checksum-verified Tree-sitter
0.26.3 compiler for Linux/macOS, x64/arm64. It uses uv or the environment's pip to
build/install wheels. Repeated runs skip installed local versions; `--force`
reinstalls cached wheels. Bump the local version when changing a patch.
The normal app does not download or build grammars at runtime.

Corrections:

- [JavaScript](https://github.com/tree-sitter/tree-sitter-javascript) and
  [TypeScript/TSX](https://github.com/tree-sitter/tree-sitter-typescript): accept
  bare ampersands within JSX text. Character references and adjacent label text
  are analyzed together as literal text. JSX expressions and attributes retain
  their normal grammar. Source bytes, ranges and displayed snippets are unchanged.
- [C#](https://github.com/tree-sitter/tree-sitter-c-sharp): permit pointer operands
  such as `*(destination + i)` and keep the assignment's left/right AST fields.
  Prism still stops pointer writes at an explicit memory-alias boundary.
- [SQL](https://github.com/DerekStride/tree-sitter-sql): PostgreSQL `DROP TRIGGER`
  with `ON`, conflict targets, `DELETE` aliases/`USING`, `DISTINCT ON`, non-binary
  `CHECK` expressions, empty arrays and typed array casts. These extend the same
  SQL AST used by Graphify's native extractor, preserving its declaration and
  relationship extraction rather than masking unsupported statements.

The Graphify provider registry remains the language eligibility authority. These
are targeted maintenance patches for observed grammar gaps, not a second registry.
Remove patches as equivalent upstream releases become available and pass the
passive-source regressions in `backend/tests/test_parser_fixes.py` plus the full
preview audit:

```bash
backend/.venv/bin/python scripts/audit-preview-parsers.py --output /tmp/parser-audit.json
```
