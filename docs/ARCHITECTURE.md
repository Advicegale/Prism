# Architecture & implementation notes

## Pipeline

```text
Paste GitHub PR URL
     |
GitHub API: base/head SHAs and PR metadata
     |
Local checkout, fetch refs/pull/N/head, git merge-base
     |
Two detached worktrees (base + head) inside user cache
     |
Git diff --unified=0 --find-renames (both old and new line ranges)
     |
Graphify: extract(collect_files(root), root=root) for each revision
     |                  [cached by SHA + Graphify version]
Tree-sitter range analysis for changed source files
     |
Match changed declarations onto Graphify graph nodes by path/name/line
     |
Merge head graph + removed base-only edges; classify edge additions/removals
     |
Cluster change symbols + expand graph context; split oversized communities
     |
Roll up structural groups into reviewer topics (path-based fallback or validated AI suggestion)
     |
Persist report JSON
     |
React file architecture map + topic/file review workspace
     |
Capture bounded exact code excerpts for each changed symbol
     |
Optional CLI LLM: one whole-PR guide (all groups/symbols/topics/order)
     |
Validate complete group/symbol coverage and recommended file paths
     |
Large assignments only: bounded batches, then one whole-PR synthesis
     |
Persist AI narrative independently of deterministic graph
```

## Stable data shape

Symbol exploration is a separate exact-revision enrichment index and progressive query layer under `backend/prism/exploration/`. It reuses pinned Graphify grammar/import facts and committed-source infrastructure without using the lossy report graph as semantic truth. Report-scoped resolve/expand/source APIs feed a stationary React popover in Topics. Field-aware identity/wrapping/construction facts determine eligible edges; grouping/changed-file filtering only projects them. See [the model, coverage, API and resource contract](SYMBOL_EXPLORATION.md).

`Report` contains `meta`, `stats`, `files` (old/new hunk ranges + complete Git patch), `overview` (`nodes`/`edges`), `groups` (`id`, `title`, `changed_ids`, `files`, contextual `graph`), `topics` (a parent roll-up over existing groups with topic-scoped subgraphs), and `evidence` (line-numbered source excerpts from the actual base/head revisions), plus optional `ai` (a concise diff-grounded statement per changed symbol, optional reviewer notes and rationale, file review order, and suggested topic memberships). Legacy cached AI reports may also contain longer how-it-works and snippet explanations; those fields remain in the stored report for compatibility. Node IDs are from Graphify or prefixed `ast:` if a Tree-sitter declaration can't be associated to an existing graph node.

A change group is a *cluster of changed symbols*, not necessarily a list of changed files. This makes multi-file feature refactors a single group when relationships support it. Source context can be displayed in several graphs. For oversized connected clusters, greedy modularity identifies candidate splits, followed by bounded connected neighborhoods.

Topics reduce overview density without changing structural groups. Graph-only reports roll groups up by path family. AI report schema version 8 allows the whole-PR guide (or final batch synthesis) to suggest specific reviewer topics and an optional one-sentence focus. The combined pass receives all assigned groups, source seeds and per-file facts in one call and returns their notes together with the global guide. Larger assignments are batched, then synthesis sees all validated observations, paths, diff summaries, substantive review notes/rationale, risks, and review routes; it can retrieve the full architecture and earlier group evidence through the shared workspace; every group ID must appear exactly once and unknown IDs invalidate the suggestion. A malformed or overlong focus is discarded without losing a valid group partition. Topic graphs and cross-topic links are projections of verified report nodes and edges; the model cannot add graph entities or relationships. Unchanged topic context excludes structural containment edges such as `contains`, which otherwise surface neighboring declarations without indicating a dependency. Cached reports receive the current deterministic topic graph when the topic rules change, preserving valid saved AI titles and focus.

The frontend has two review surfaces: Architecture and Topics. Both remain mounted across tab switches. Topics projects saved semantic memberships (or deterministic fallback memberships) onto `report.files`, using old paths for renamed/deleted files when necessary. A catch-all scope preserves files omitted from older topic metadata. Within a topic, the validated PR-wide file route controls queue order; stored per-symbol change notes are aggregated by file. No symbol diagram or structural group navigation is displayed. File selection shows the full cached patch with progressive line expansion and anchored inline questions. The reader offers split/unified presentation, bounded replacement-line alignment and word comparisons, persistent mode/wrap/highlight preferences, and hunk navigation. Split uses shared grid rows and one scroller; inline question anchors preserve the chosen base/head side. Stable change-block chat containers preserve conversations while switching display modes. Narrow screens default to unified without an explicit saved choice; offline HTML uses the static unified renderer. Architecture actions and validated Q&A citations open the corresponding file.

GitHub viewed-file state is fetched on demand through `gh api graphql` for the authenticated viewer. Prism does not persist it in cached reports; refreshing reads the current `viewerViewedState` for changed paths. Mark/unmark actions use GitHub's file-view mutations and are restricted to paths present in that report. The shared UI filter removes viewed files from the map, review route, and detailed walkthrough.

The in-report question endpoint runs as an asynchronous job, independently of graph analysis and report generation. It supplies bounded PR metadata, report summaries, and up to 18 relevance-ranked changed-symbol contexts containing verified source excerpts and symbol-matched diff hunks. The provider returns a separate structured answer with source IDs; Prism discards citations that were not in that exact prompt. General-question citations link to the corresponding changed symbol in the report. Conversation follow-ups reuse a bounded recent history, but earlier model answers are treated as fallible context, not proof.

Every model stage has the same read-only review workspace: architecture, group notes, synthesis, general Q&A and inline Q&A. A per-call stdio MCP service exposes twelve tools: `list_files`, `list_symbols`, `related_symbols`, `read_source`, `read_text`, `read_blob`, `search_source`, `list_changes`, `read_diff`, `read_context`, `read_history`, and `read_github`. Reads use committed Git objects at head, merge-base, target tip or an explicit available commit SHA. Tracked files remain accessible regardless of graph/parser language, directory, file-size or indexing budgets. Source lines, full text, binary bytes and diffs support explicit continuation instead of silently losing tails. Graph analysis still has its own bounded eligibility and is a navigation aid.

`read_context` exposes full saved metadata, files, groups, architecture, previous guide and accumulated group observations. Provider prompts include a whole-PR navigation seed and explicitly prioritize meaningful topics, useful file order, explanations and human review questions. JSON seeds are shortened structurally with omission notices. All substantive symbol notes and group risks/tests survive storage and synthesis regardless of symbol count. AI schema v8 persists source-read provenance and shared batch observations plus guide call-count/timing metrics in `review_state`; `correctness_coverage=not_measured` makes no exhaustive-review claim. Topic memberships still use the existing group-based schema and the UI retains its separate Tests section.

`read_github` supports only allowlisted GET routes on api.github.com for PR/issue text, comments/reviews/commits, checks/statuses, workflow jobs/logs and linked source/tree/blob/commit records. Source reads resolve aliases or require full SHAs. Authentication stays in the backend and is removed on redirects to other authorities. Responses carry retrieval timestamps, URL/revision, text continuation and collection-page continuation; each resource page is stable within the call. Unsupported or inaccessible evidence returns an explicit error. Source assets are available as exact bytes; visual interpretation, automatic LFS/submodule expansion and arbitrary artifact downloads are not implemented.

Codex has shell, web, browser, app, plugin and unrelated MCP tools disabled; only Prism's read tools are enabled. Claude has built-in tools disabled and a strict MCP allowlist. Both receive prompts on stdin. `PRISM_REVIEW_MAX_TURNS` (default 48) configures Claude's per-call tool budget; calls still time out rather than resume automatically. See [review-workspace contract and limits](REVIEW_WORKSPACE.md).

Inline questions use the same endpoint and answer schema with an optional line anchor. The detailed diff reader preserves old/new line coordinates even when it displays a symbol-filtered patch excerpt. The server resolves the requested path and old/new line numbers against the report's cached unified patch, reconstructs the selected +/- rows, and rejects references outside the stored diff; client-supplied source text is never trusted. The anchored diff is the first source in the prompt and the model is instructed to answer about it directly. Inline chats expose model and effort controls backed by the same assistant settings as the general PR chat, while keeping their own bounded follow-up history.

## Cache details

`~/.local/share/prism-pr-review/repos/<hash>/origin` is a normal Git clone, with detached worktrees under `worktrees/<sha>`. Graphs are cached as `graphs/graph-v2-<sha>-<graphify-version>.json`, containing the normalized Graphify extraction. Reports are separate, keyed by repository/PR/merge-base/head SHAs. AI runs can re-use persisted reports. Older reports are opportunistically enriched with source evidence and complete patches from retained Git objects without an AI run. `diff_version=1` records complete patches. Explicit Analyze refreshes old symbol mappings (`symbol_mapping_version=2`, all declarations overlapping a changed hunk) and archives incompatible prior AI guides under `previous_ai`; merely opening a report preserves saved notes.

Scanning doesn't execute repository scripts, tests, post-checkout hooks or dependency installs. It parses source files. Graph indexing skips symlinks and unusually large files. Repositories crossing graph caps return an explicit failure rather than silently indexing a subset. These indexing limits do not restrict review-workspace reads of an existing checkout. Git operations and blobs are currently materialized in memory before response pagination; very large repositories/results may exhaust resources or time out explicitly.

## CLI invocation and trust boundaries

- **Codex:** `codex exec --sandbox read-only --skip-git-repo-check --output-schema ... --output-last-message ... -` with `--model` and `-c model_reasoning_effort=...` when explicitly set.
- **Claude Code:** `claude -p --output-format json --json-schema ... --permission-mode plan --tools ""` with model/effort flags when explicitly set.
- **Working directory:** temporary empty directory, never checked-out PR code. Agents start with serialized graph context and bounded patches. Group checks, topic synthesis, and architecture discovery also receive the four restricted Prism repository tools; Claude uses `--restricted --strict-mcp-config` and an explicit tool allowlist. Source reads use exact PR-head and merge-base Git blobs, including unchanged files. Prompts label PR text untrusted data and tell models not to follow embedded instructions.
- The question adapter uses its own answer-and-citations schema. It validates each citation against the bounded source catalog and does not accept model-created file paths or symbol IDs.
- Question context, including PR text, summaries, source excerpts, diffs, and recent conversation, is sent to the selected CLI provider. GitHub file-view requests use the user's `gh` authentication; Prism does not store GitHub tokens or viewer state in reports.
- This is not a guarantee against prompt injection, leakage through the external harness, or arbitrary user customization of CLI configurations. Running on untrusted PR content must be treated cautiously.

Only the backend accesses Git/processes or local report data. Frontend never executes shell commands. The app listens on loopback; cross-origin POSTs from unrelated web origins are blocked.

## Reviewer-focused AI reports

- A review explanation is generated **per PR change group**, so long PRs do not lose entire segments to prompt truncation. The default per-symbol output is one short statement grounded in that symbol's actual diff hunks.
- Prompts include every changed symbol ID, Graphify relationships, diff hunks, and bounded exact code excerpts (source material, treated as untrusted data). Each group check and the final topic synthesis can browse relevant callers, dependencies, tests, docs, and unchanged source through the same bounded repository tools used by architecture discovery. Prompts ask models to inspect missing context before reporting an evidence gap, using `revision=head` or `revision=base` as appropriate. Fresh analyses, cached analyses, and Explain reruns all enable these tools; unavailable retained checkouts fail explicitly rather than silently generating diff-only checks. Existing saved checks need an Explain rerun to benefit. Repository inventory/read caps still apply.
- Intent is included only when the PR text states it or the diff strongly supports it. Up to two symbol-level reviewer notes are included only for actionable behavior, security, compatibility, correctness, or validation concerns; small diffs still receive a risk review.
- Group and PR summaries, risks, and test suggestions are omitted when they add no distinct reviewer value. Group routes are omitted for one-file groups; the global route lists each affected file once and includes a reason only where the order is not self-evident.
- The server verifies symbol IDs and file paths against the deterministic report. It fills omitted route paths without inventing rationale, preserving a complete review path.
- The frontend uses the route to order the topic file queue, hides empty prose, and presents saved notes alongside the complete cached file diff. The displayed code always comes from the worktree, not the model's imagination.
- Reports with multiple groups have a separate overall synthesis, which can suggest a global cross-group file order and semantic topic partition. All returned paths and symbol IDs are validated against the deterministic report graph.
- Topics uses that validated file order as a reading recommendation; it does not create graph edges.
- Invalid, incomplete, duplicated, or overly fragmented topic partitions fall back to path-based topics; the file-review workspace uses the resulting topic file memberships.
- Source excerpts are bounded to avoid persisting huge class bodies; if truncated or unavailable, the UI clearly labels that. AI motivations are not proven author intent unless grounded in the PR description.

## Expansion opportunities

- Provider-native model discovery for Claude when a supported endpoint exists.
- Report navigation by stable symbol source links, optionally open in editor.
- GitHub webhook/watch support for incremental PR refresh.
- Richer hierarchical segmentation with cross-group bridge overview.
- Bounded task execution and cancellation, progress streaming over SSE.
- Full report export to Markdown/PDF; inline diff-to-graph hover linking.
- Optional local-repo comparisons without GitHub.

## General-purpose file architecture review

See [the review-map methodology](ARCHITECTURE_METHODOLOGY.md) for the language-independent process and validation contract.

`architecture.py` collects a neutral source graph from immutable head/base Git blobs. Existing specialized recognizers and Graphify supply facts when available; missing language parsers fall back to file nodes. Tracked UTF-8 source/configuration/resource text can be browsed regardless of language or extension.

`architecture_review.py` runs the configured CLI with restricted read-only repository tools, asks it to trace the change, and validates its proposed map. Architectural group names, membership, order, supporting sections and bundles are generated from this repository's source; there is no fixed role taxonomy. Every changed file must be assigned once. Selected context must be read. Interpreted edges require audited citations for both endpoint paths; the server reconstructs evidence from exact Git revisions. Citation validity does not certify the relationship itself, so interpreted links remain distinguishable from extracted facts.

`POST /api/reports/{id}/architecture` runs discovery independently of the existing prose report, preserving the current accepted map if generation fails. AI-assisted PR analysis also discovers architecture. Cached accepted maps persist with revision/model/organizer metadata and are reused on ordinary opens; the explicit Rebuild action invokes a fresh model run. Source-only reports use a neutral fallback rather than guessed folder categories.

The renderer consumes generic groups. It no longer special-cases migrations, tests, services or a particular application-layer order. Viewed-file filtering, source evidence inspection and symbol/diff drill-down apply to the map.

Symbol exploration discovers Graphify native providers dynamically, including custom parsers/regex extractors and source-aware filename/shebang routing. Native facts retain provenance from an isolated committed-source tree; shared AST-shape enrichment adds value/field transfers. The complete registry and installed parser versions fingerprint revision caches. Setup discovers optional language-parser dependencies from Graphify metadata. See docs/SYMBOL_EXPLORATION.md for per-construct evidence and limits.
