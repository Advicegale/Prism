# Changelog

## Unreleased

- Fixed setup on older Bash versions, including macOS's system Bash, by replacing `mapfile` with a compatible read loop. Parser dependency discovery failures now stop setup before installation.

- Corrected the parser failures found across the retained preview PRs: JSX literal ampersands, PostgreSQL migration syntax and C# pointer assignments. Setup reproducibly builds small licensed grammar patches from pinned upstream source; both Graphify and exploration use them without changing reviewed code or source anchors. Parser-version changes invalidate old exploration caches. Pointer writes retain explicit analysis limits, and malformed syntax still produces coverage warnings. Added an all-report/both-revision parser audit and passive-source regressions.

- Added a split/unified diff reader with aligned before/after source, separate line gutters, changed-word highlighting, wrapping controls and next-change navigation. Reader preferences persist across files; inline questions stay tied to exact revision-side coordinates and conversations survive mode changes. Narrow screens default to unified; offline HTML retains its static unified view.

- Added self-contained offline HTML export named `<repo>-<pull_nr>.html`, with shared architecture layout, local connection selection/evidence, topic/file navigation, complete captured diffs, saved notes and print styling. Export omits live assistants and GitHub mutations and includes files hidden by the current viewed filter.

- Removed the Symbols diagram and Cytoscape renderer. Redesigned Topics around a persistent topic list, ordered/searchable file queue, saved file notes and progressively expandable complete cached diffs. Retained GitHub viewed state, inline questions, Architecture state and re-click-only deselection; architecture actions and PR citations now open file review. Added complete-file-coverage checks, including renamed/deleted paths and unassigned files.

- Preserved architecture/symbol view state across tab switches and symbol drill-down. Embedded the layout worker in the app bundle to prevent stale worker URLs from breaking open pages after rebuilding the frontend.

- Implemented the 4.1 architecture layout: connection-aware within-group ordering, readable four-row grids, distinct ports and obstacle-aware separated lanes, crossing bridges, mixed-evidence styling, and background-worker layout. Re-clicking the selected file or connection toggles selection; removed inspector Close and background deselection.

- Bound architecture discovery navigation seeds by UTF-8 bytes, retaining every changed-file entry and full extracted evidence. Larger relationship sets no longer require reducing the PR to fit repeated evidence into the initial prompt.

- Replaced fixed architecture categories with source-browsing AI discovery: repository-specific groups, ordering, supporting sections and bundles. Added complete changed-file coverage checks and two-endpoint source citation validation for model-interpreted relationships; extracted facts retain their relation type.
- Added Discover/Rebuild architecture independently of prose reports. Expanded read-only repository tools to bounded tracked UTF-8 text in arbitrary languages and optional exact-base reads; projects without symbol parser support continue with file-level review.

- Added a default file architecture map with fixed application-layer columns, bundled migrations, expandable shared-domain/test/doc/configuration groups, source evidence inspection and symbol/diff drill-down.
- Added deterministic repository import/alias resolution and source-backed HTML/CSS/DOM, fixture, HTTP route and SQL table relationships. Existing cached reports upgrade from their exact retained head/base Git commits without another AI invocation.

- Fixed Codex repository browsing by disabling global MCP servers with safe TOML overrides while preserving the user's Codex config and selected model.
- Rendered model responses and report explanations as Markdown, including emphasis, lists, tables, quotes, and code blocks; preserved single line breaks and kept raw HTML disabled.
- Added opt-in repository browsing to PR-wide and inline questions. The selected CLI can inspect tracked files at the exact PR head through bounded read-only file, Tree-sitter symbol, Graphify relationship and source-range tools; source citations are checked against tool-read audit records.
- Added GitHub viewed-file controls backed by the authenticated GitHub CLI; file state can be refreshed and hidden consistently from the topic overview, graph, suggested route, and code walkthrough.
- Added in-report PR questions for Codex and Claude Code, with selectable model/reasoning effort, bounded report-grounded context, follow-up questions, and validated source citations that navigate to changed symbols.
- Added GitHub-style inline chats to changed-code excerpts: ask about a selected diff line, Shift-click within the same hunk to include a range, and continue a focused thread. Each inline composer exposes model and effort pickers synchronized with the PR chat. Anchors are checked against Prism's cached patch before being sent to the CLI.
- Rebalanced the dark palette around neutral graphite and slate surfaces with a restrained blue interaction accent; green and red remain reserved for change meaning and status.
- Refined the report workspace around PR context, compact review facts, a full-width topic index, and the focused change map; the full analyzer now opens on demand while reviewing. The home screen includes a short list of recent reports.
- Reworked detailed review into a topic rail and focused patch-reading column; moved file order into one expandable list and removed repeated legacy explanation prompts from cached reports.
- Asked full-PR synthesis for specific reviewer-facing topics ordered along the suggested file route, with an optional short focus on shared behavior or a concrete review question. Validated and cached the focus alongside the exact group-ID partition; the detailed review shows it once per topic.
- Organized the detailed review under validated AI-suggested topics, combining their structural groups into one review section and keeping symbols in recommended file order; individual symbols still navigate to their source graph group.
- Ordered detailed change-group sections by the first file in the recommended review route, preserving existing order for ties or unranked groups.
- Simplified generated change-group reviews to concise diff-grounded symbol summaries with optional actionable rationale/risk notes; single-symbol groups omit repeated group prose, routes appear once, exact diffs stay visible, and legacy long-form detail is collapsed by default.
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
