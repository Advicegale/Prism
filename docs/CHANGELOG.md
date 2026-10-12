# Changelog

## Unreleased

- Added a map group filter listing every inferred group with per-group visibility toggles and show-all/hide-all controls; hidden groups and their edges are removed in network, tree, and inferred-group layouts. Inferred-layout headings now include only groups and nodes present in the filtered map.
- Classified nodes from test/spec paths and filenames as Tests before applying component-name suffixes, preventing test suites named after services from appearing in the Service group.
- Added a topic-first change map: begin with a compact overview, open a topic to inspect its source graph, and retain an all-symbols view. Graph-only reports group by file area; AI synthesis may suggest semantic topic names and membership using validated existing group IDs.
- Added a numbered suggested file-review path to the map. Selecting a step highlights that file's changed symbols and linked context; the route remains explicitly separate from extracted graph relationships.
- Filtered unchanged map context to omit structural containment edges, which often surfaced unrelated declarations from the same file.
- Added a persistent map toggle to hide unchanged context nodes while keeping changed nodes and their connected relationships visible.
- Disambiguated repeated change-group labels with affected file names, including for previously cached reports.
- Added change-map organization modes: relationship network, changed-symbol-rooted tree, and graph-specific groups learned from recurring type-name patterns, with source-folder fallback.
- Added language-aware syntax highlighting to selected-symbol file diffs and detailed-review source excerpts, while preserving the added and removed line styling.
- Added source-range-matched diff hunks to each changed-symbol prompt and concise, visible diff summaries to detailed change cards.
- Added symbol-scoped, syntax-highlighted PR diff excerpts with actual added (`+`) and removed (`-`) source lines to detailed change cards; the diff and implementation now share one source panel.

## 0.2.0 — Detailed review and black theme

- Switched the UI from blue/navy surfaces to a charcoal-black palette with emerald accents.
- Removed automatic example report loading and the demo shortcut from the homepage; retained the isolated API test fixture.
- Upgraded AI reporting to per-changed-symbol explanations: why, how the new code works, and an explanation of an exact code excerpt.
- Added deterministic line-numbered code excerpts captured from base/head worktrees; the model does not generate source snippets.
- Added recommended review order for every affected file at both group and full-PR levels, with reason per file and validation against actual PR paths.
- Segmented AI generation by change group and synthesized the overall report; ensures every changed symbol appears in the result even if the model omits details.
- Added source snippet cards, ordered file review routes, expandable change-group walkthroughs and graph navigation from change cards.
- Increased Cytoscape wheel sensitivity from 0.2 to 1.3; +/- buttons now zoom by 1.65× with an additional direct zoom slider and live percentage.
- Added compatibility for cached reports and opportunistic recovery of source evidence from cached worktrees.
- Added five detailed-report regressions; now 27 backend tests.

## 0.1.0 — Initial MVP

- Local FastAPI + React PR viewer, Graphify/Tree-sitter extraction, connected change groups, Cytoscape visualization, Claude/Codex CLI summaries, locally cached reports.
