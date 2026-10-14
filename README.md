# Prism — local structural PR review

**A pull-request viewer organized around changed classes, functions, methods and their relationships — rather than a flat list of changed files.** Paste a GitHub PR URL, inspect an interactive knowledge graph, move between related change groups, and optionally request an explanation from your locally installed **Codex** or **Claude Code** CLI.

Prism is a **localhost-first web app** for Linux and macOS. No Electron, Apple app signing, hosted backend, Docker, or remote database.

## Quick start

Requirements: **Python 3.11+**, **Node.js 20+ + npm**, **Git**, and a **C compiler** (`cc`, `gcc` or `clang`) for the first parser build. `uv` is preferred but optional. Internet access is needed for first-time dependency installation and fetching GitHub PRs.

```bash
unzip prism-pr-review.zip
cd prism-pr-review
./setup.sh
./start.sh
```

Open **http://127.0.0.1:4780** (or `http://localhost:4780`). The backend and built frontend share that port. Nothing binds to the public network interface by default.

`setup.sh` creates `backend/.venv/`, installs Graphify (`graphifyy`) + Tree-sitter grammars and FastAPI locally, runs `npm install` in `frontend/`, builds React/Vite, and creates `.env` from `.env.example`. **Do not separately install Graphify or Tree-sitter.** No global Python installs are required.

Setup also builds pinned corrections for JSX text, C# pointer assignments and PostgreSQL syntax used by the retained reports. Existing installations can run `backend/.venv/bin/python scripts/install-parser-fixes.py` and restart Prism. See [parser fixes and upstream provenance](scripts/grammar-fixes/README.md). Changed parser versions automatically invalidate exploration caches; another AI analysis is unnecessary.

The home screen starts clean: **no example report loads automatically**. There is an internal `/api/demo` fixture for tests and developers, but no demo shortcut on the homepage.

### Real PR

1. Paste a GitHub URL such as `https://github.com/owner/repo/pull/123`.
2. Pick **Graph only** or **Claude Code / Codex**; pick a model and reasoning effort where available.
3. Click **Analyze PR**. The first run downloads the repository, computes Git's merge-base diff, indexes both revisions, and caches the graphs by commit SHA.
4. Use **Architecture** to understand file relationships. Re-click a selected file or connection to deselect it; choose **Review file** to open its changes.
5. Switch to **Topics** to review a useful grouping of changes. Choose a topic, then a file from its searchable queue. Saved AI review order is used when available.
6. Read the selected file's saved change notes and syntax-highlighted diff. Switch between **Split** (before/after) and **Unified**, toggle line wrapping or changed-word highlighting, and jump to the next change. Split starts when the diff pane is at least 960px wide and unified below that, unless a mode was chosen. Longer diffs expand progressively; files omitted from saved topics appear under **Other changes**. **Reading shortcuts** (Topics, not in fields): `j`/`k` next or previous file, `]` next change, `s` split or unified, `f` focus mode, `?` shortcut list.

Click an ordinary named symbol in a Topics diff to open **Connections**. The popover explores compositions and imports at that side's exact revision. The popover is a movable, resizable window: it opens on the half of the screen opposite the clicked token so the diff stays visible, drag its header to move it, drag any edge or corner to resize it, and use the size button to switch between half and full window (a dragged or resized frame is remembered until you switch). The splitter between the map and source panes also drags (arrow keys nudge it, double-click resets). It centers the clicked source and opens its snippet first. One tree shows inputs to the left and consumers to the right; **Expand upstream** and **Expand downstream** grow it independently. **Changed files only** defaults on; expansion crosses unchanged source and labels indirect paths. **Definition** inspects the canonical declaration. File, connection and anchor selection shows committed-source snippets inside the stationary popover. Clicking another name in a snippet starts its own investigation there. Clicking the diff leaves it open; X or Escape (outside text fields) closes it; **Connections** reopens retained state. Text selection and source copying remain available. Comments, keywords and literal values do not open investigations.

Exploration discovers every provider in Graphify’s native registry, including custom extractors, filename rules and shebang files. Shared syntax enrichment adds static compositions beyond native Graphify facts; the five original languages have additional precision rules. Dynamic ownership, computed keys and unsupported flow stop with source evidence; this is not a runtime impact proof or a general call graph. See [coverage, limits and measured performance](docs/SYMBOL_EXPLORATION.md).
7. Mark files viewed on GitHub and use **Hide viewed** to narrow both views. Refresh status when reviewing elsewhere on GitHub.
8. Ask follow-up questions from **Ask this PR**, or use the message icon beside a diff line for an inline chat. Shift-click another line in the same hunk to ask about a range.

Private repositories are supported when `gh auth login` is configured or GitHub authentication is available. `GH_TOKEN` / `GITHUB_TOKEN` can also authenticate the GitHub API; repository cloning needs matching Git/`gh` access. No GitHub token is saved by Prism.

GitHub viewed-file status and mark/unmark actions use the authenticated GitHub CLI account (`gh auth login` or the CLI's supported token environment). They are scoped to that account's review state. The filter can be refreshed independently of the saved report.

### AI harness installation

Prism **does not install or sign you in** to third-party coding harnesses. Install and authenticate either CLI separately if you want AI narratives:

- `codex` — [`Codex CLI`](https://developers.openai.com/codex/cli/)
- `claude` — [`Claude Code`](https://code.claude.com/docs/)

The Configuration page detects available executables on the backend's `PATH`. Codex model and effort selections are populated from the installed app-server's `model/list` response when available. Claude Code doesn't offer a verified stable account-level CLI model-list interface; Prism uses CLI aliases / custom model IDs with user-selectable effort. When an API isn't available, fields remain editable/defaultable rather than pretending to know your account's models.

**Privacy:** Graph construction and symbol mapping run locally. Selecting Codex/Claude sends bounded PR context to the provider via that CLI. PR questions include the PR body, report summaries, and verified excerpts/diffs for changed symbols; inline questions also include the selected line-anchored diff excerpt. Architecture discovery always uses restricted read-only source browsing at the exact head/base commits. For Q&A, if **Allow repository browsing** is checked, the selected CLI can request tracked source from the exact PR-head commit through Prism's read-only file, symbol, relationship, and source tools. Prism sends only the requested excerpts; it does not give the CLI shell or `gh` access. Prism doesn't independently contact LLM APIs.

## Interface

- **File architecture map (default):** use **Discover architecture** to have the configured CLI trace exact-revision source and organize this project's changed/context files into its own architectural groups. Source evidence is inspectable; model-interpreted links stay distinct from extracted references. Supporting groups and coherent bundles reduce clutter without dropping changed files. Connection-aware ordering and separate routing lanes run in a background worker; crossings use bridge arcs and cards stay readable on a scrollable canvas. Re-click a selected file or connection to deselect it. Saved maps reopen without another AI run. Source-only mode offers a neutral graph; it does not impose folder-based architecture. See [the methodology](docs/ARCHITECTURE_METHODOLOGY.md).

- **File-focused Topics:** a persistent topic list, searchable file queue, and one focused reading pane. Semantic AI groupings or deterministic fallback topics organize the changes; every changed file remains reviewable, including deleted files, documentation and configuration. Saved change notes, review-order reasons, complete cached diffs, viewed state and inline questions stay attached to files. Architecture and Topics retain their state across tab switches.
- **Symbol connections:** unmarked source-name selection, one independently expandable upstream/downstream tree, field-specific compositions, merged file branches and progressive traversal through unchanged intermediates. The large popover initially focuses the clicked occurrence and inspects exact-revision source without navigating the main reader. Analysis is local and works lazily with retained cached reports.
- **Before/after graph context:** Graphify runs on the merge-base and PR head. Relationship topology is compared; removed connections remain inspectable.
- **PR segmentation:** connected change clusters form separate graphs. Very large cohesive clusters are divided using structural connectivity and modularity; small contextual neighborhoods remain visible.
- **Saved AI review notes:** concise diff-grounded notes and actionable checks are collected by file. Validated topic memberships and file review order guide the queue; symbol records remain internal report data rather than a second diagram.
- **GitHub review state and questions:** Mark changed files viewed through the GitHub CLI and hide viewed files across report views. Ask the configured CLI harness questions inside the report or from selected diff lines; inline threads stay focused on one line or a same-hunk range, and the server verifies anchors against the cached PR patch.
- **Verified code excerpts:** excerpts are captured from base/head worktrees, not invented by the LLM. Changes to removed symbols show their previous implementation. The LLM explains the provided source, but cannot rewrite it.
- **Graphite theme:** neutral dark panels with restrained blue navigation and semantic colors for change states.
- **Local report history:** reopen cached analysis, upgrade and regenerate detailed AI narrative independently, export reports as JSON or a self-contained offline HTML file (`<repo>-<pull_nr>.html`). HTML includes the complete captured report, grouped architecture, evidence, topics, saved notes and syntax-highlighted diffs. Local navigation and print expansion work without a server; live assistants and GitHub write controls are omitted.

## Configuration

Copy/edit `.env` after setup:

```dotenv
PORT=4780
# PRISM_DATA_DIR=/custom/path
# PRISM_MAX_FILES=2500
# PRISM_MAX_TOTAL_BYTES=35000000
```

The `PORT` setting changes the production server's port. The frontend API is relative to the current origin. In development, the Vite dev server uses `http://127.0.0.1:5173` and proxies `/api` to `4780`.

The default cache directory is `~/.local/share/prism-pr-review/`, including repository clones/worktrees, Graphify snapshots, and JSON reports. Delete it to clear all analysis data.

## Development

```bash
./setup.sh
./scripts/dev.sh
```

Development uses Vite hot reload (`:5173`) and FastAPI (`:4780`). To run tests:

```bash
cd backend
.venv/bin/python -m pytest -q
```

The backend API includes `GET /api/health`, `GET /api/harnesses`, `POST /api/analyze`, `GET /api/jobs/{id}`, `GET /api/reports`, `GET /api/reports/{id}`, `POST /api/reports/{id}/architecture`, `POST /api/reports/{id}/explain`, `GET/POST /api/reports/{id}/viewed-files`, `POST /api/reports/{id}/questions` and `GET /api/demo`; interactive docs are under `/api/docs`.

Symbol exploration adds report-scoped `POST /api/reports/{id}/exploration/resolve`, `POST .../expand` and `GET .../source`. Resolve accepts a path, old/new side, 1-based line and 0-based UTF-16 column. Revision selection is server-derived. See [the API and cache contract](docs/SYMBOL_EXPLORATION.md).

## Source structure

```text
backend/prism/
  app.py       FastAPI endpoints, jobs, cache/report persistence
  gitops.py    URL parsing, GitHub API/CLI, clones and Git diff
  graph.py     Graphify extraction, graph differences, segmentation
  symbols.py   Tree-sitter changed-symbol mapping
  harness.py   Codex/Claude structured report and grounded question adapters
  evidence.py  Exact base/head source excerpts per changed symbol
  demo.json    Clearly labeled illustrative example
frontend/src/
  main.tsx     React explorer and report UI
  components/ArchitectureMap.tsx  File relationship map
  components/TopicReview.tsx  Topic and file review workspace
  styles.css   Responsive dark UI
backend/tests/  Unit + API tests
```

## Upgrading from 0.1

Cached reports remain available. New analyses capture source evidence automatically, and old cached reports are enriched from the retained Git worktrees where possible. If you open an older AI report, the UI provides a **Regenerate details** action (select Codex or Claude first). Without source worktrees, the UI can fall back to the existing diff, but may have less context. No report data migration or cache reset is required.

## Important limitations of this initial build

This is a **functional first implementation**, not a fully field-tested production release:

- Graphify's extracted call/import graph is static and not guaranteed to resolve dynamic dispatch, reflection, implicit wiring, or all languages perfectly. AST symbol granularity is best for Python, JavaScript, TypeScript, Go, Java and Rust; other files may use fallback markers.
- Very large repositories are rejected at the configured indexing cap instead of silently producing an incomplete graph. Git LFS objects and submodules are not fetched automatically.
- The app supports **GitHub pull requests**, not GitLab/Bitbucket yet. Rename tracking is based on Git's diff detection and may not map every symbol across complex refactors.
- Context-aware segmentation is heuristic, not a claim to reconstruct the author's intended change breakdown.
- AI explanations are generated from bounded, potentially truncated diff excerpts and source excerpts; *why* is an inference unless the PR author states their intent. Always review code and tests yourself. Detailed reports call the harness once per segment (plus a synthesis for multi-segment PRs), increasing latency and CLI usage versus v0.1.
- Jobs are in memory until completion (persisted reports survive restarts), and the app does not yet provide process cancellation.
- Local analyzer packages are installed on first setup; this source ZIP does **not** embed wheel archives, npm dependencies, or a precompiled production UI. Running setup requires package registry access.

For deeper design notes, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
