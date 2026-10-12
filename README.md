# Prism — local structural PR review

**A pull-request viewer organized around changed classes, functions, methods and their relationships — rather than a flat list of changed files.** Paste a GitHub PR URL, inspect an interactive knowledge graph, move between related change groups, and optionally request an explanation from your locally installed **Codex** or **Claude Code** CLI.

Prism is a **localhost-first web app** for Linux and macOS. No Electron, Apple app signing, hosted backend, Docker, or remote database.

## Quick start

Requirements: **Python 3.11+**, **Node.js 20+ + npm**, **Git**. `uv` is preferred but optional. Internet access is needed for first-time dependency installation and fetching GitHub PRs.

```bash
unzip prism-pr-review.zip
cd prism-pr-review
./setup.sh
./start.sh
```

Open **http://127.0.0.1:4780** (or `http://localhost:4780`). The backend and built frontend share that port. Nothing binds to the public network interface by default.

`setup.sh` creates `backend/.venv/`, installs Graphify (`graphifyy`) + Tree-sitter grammars and FastAPI locally, runs `npm install` in `frontend/`, builds React/Vite, and creates `.env` from `.env.example`. **Do not separately install Graphify or Tree-sitter.** No global Python installs are required.

The home screen starts clean: **no example report loads automatically**. There is an internal `/api/demo` fixture for tests and developers, but no demo shortcut on the homepage.

### Real PR

1. Paste a GitHub URL such as `https://github.com/owner/repo/pull/123`.
2. Pick **Graph only** or **Claude Code / Codex**; pick a model and reasoning effort where available.
3. Click **Analyze PR**. The first run downloads the repository, computes Git's merge-base diff, indexes both revisions, and caches the graphs by commit SHA.
4. Start with **review topics**, open one to inspect its source graph, or choose **All symbols** for the complete graph. Click any node to see its source location, relationships, and diff.
5. Use the numbered **Suggested review order** rail in the map to follow the recommended file sequence; selecting a step highlights that file's changed symbols and linked context.
6. For each group, scroll down to **Detailed review**. Each modified class/method/function has its own card with one source panel: actual added/removed diff lines when available, otherwise the exact source excerpt captured from the relevant revision.
7. With Claude Code or Codex selected, each card contains **why this change was made (or inferred)**, **how the new implementation works**, and a line-level explanation. You can generate this later without reindexing the graph.
8. Mark each changed file as viewed on GitHub from its file header. The shared **Hide viewed** filter removes those files from the map, review route, and detailed walkthrough; refresh its status when files are viewed elsewhere on GitHub.
9. Ask Codex or Claude Code follow-up questions from **Ask this PR**. In a detailed diff, click the message icon beside a line to start a focused inline chat; Shift-click another line in the same hunk to ask about a range. Inline chats include model and effort pickers that stay synchronized with **Ask this PR**.

Private repositories are supported when `gh auth login` is configured or GitHub authentication is available. `GH_TOKEN` / `GITHUB_TOKEN` can also authenticate the GitHub API; repository cloning needs matching Git/`gh` access. No GitHub token is saved by Prism.

GitHub viewed-file status and mark/unmark actions use the authenticated GitHub CLI account (`gh auth login` or the CLI's supported token environment). They are scoped to that account's review state. The filter can be refreshed independently of the saved report.

### AI harness installation

Prism **does not install or sign you in** to third-party coding harnesses. Install and authenticate either CLI separately if you want AI narratives:

- `codex` — [`Codex CLI`](https://developers.openai.com/codex/cli/)
- `claude` — [`Claude Code`](https://code.claude.com/docs/)

The Configuration page detects available executables on the backend's `PATH`. Codex model and effort selections are populated from the installed app-server's `model/list` response when available. Claude Code doesn't offer a verified stable account-level CLI model-list interface; Prism uses CLI aliases / custom model IDs with user-selectable effort. When an API isn't available, fields remain editable/defaultable rather than pretending to know your account's models.

**Privacy:** Graph construction and symbol mapping run locally. Selecting Codex/Claude sends bounded PR context to the provider via that CLI. PR questions include the PR body, report summaries, and verified excerpts/diffs for changed symbols; inline questions also include the selected line-anchored diff excerpt. If **Allow repository browsing** is checked, the selected CLI can request tracked source from the exact PR-head commit through Prism's read-only file, symbol, relationship, and source tools. Prism sends only the requested excerpts; it does not give the CLI shell or `gh` access. Prism doesn't independently contact LLM APIs.

## Interface

- **Topic-first change map:** begin with a compact set of review topics, then open a topic or structural group to inspect changed symbols. Graph-only reports use file-area groupings; AI reports can suggest semantic topics by grouping validated existing change groups. Topic links summarize relationships already present in the code graph. AI reports also show a numbered file-review path; selecting a step spotlights that file's changed symbols and linked context.
- **Interactive Cytoscape graph:** switch between a relationship network, a tree rooted at changed symbols, and inferred groups. Group labels come from recurring type-name patterns in the current graph, with source folders as a fallback; test/spec paths stay together as Tests. Toggle any inferred group in the map filter across all three layouts. The map also supports modified/added/deleted/context nodes, directed and inferred connections, stronger scroll zoom, a zoom slider, pan, search and fit-to-view. Selected-symbol diffs and detailed-review source panels use syntax colors based on the file extension.
- **Symbol-first review:** Tree-sitter AST ranges identify innermost modified declarations, including their containing classes. Functions outside classes are supported too. Unparseable files appear as changed-file fallback nodes.
- **Before/after graph context:** Graphify runs on the merge-base and PR head. Relationship topology is compared; removed connections remain inspectable.
- **PR segmentation:** connected change clusters form separate graphs. Very large cohesive clusters are divided using structural connectivity and modularity; small contextual neighborhoods remain visible.
- **Detailed AI report (v3):** JSON-structured overview plus *per-symbol* actual syntax-highlighted added/removed diff lines in a single implementation panel, diff summary, rationale, step-by-step explanation of the new implementation, grounded code commentary, complete group/global recommended file review sequence, behavioral impact, risks and test suggestions.
- **GitHub review state and questions:** Mark changed files viewed through the GitHub CLI and hide viewed files across report views. Ask the configured CLI harness questions inside the report or from selected diff lines; inline threads stay focused on one line or a same-hunk range, and the server verifies anchors against the cached PR patch.
- **Verified code excerpts:** excerpts are captured from base/head worktrees, not invented by the LLM. Changes to removed symbols show their previous implementation. The LLM explains the provided source, but cannot rewrite it.
- **Graphite theme:** neutral dark panels with restrained blue navigation and semantic colors for change states.
- **Local report history:** reopen cached analysis, upgrade and regenerate detailed AI narrative independently, export report as JSON.

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

The backend API includes `GET /api/health`, `GET /api/harnesses`, `POST /api/analyze`, `GET /api/jobs/{id}`, `GET /api/reports`, `GET /api/reports/{id}`, `POST /api/reports/{id}/explain`, `GET/POST /api/reports/{id}/viewed-files`, `POST /api/reports/{id}/questions` and `GET /api/demo`; interactive docs are under `/api/docs`.

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
  components/GraphCanvas.tsx  Cytoscape knowledge graph
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
