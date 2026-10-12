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
React/Cytoscape interactive viewer
     |
Capture bounded exact code excerpts for each changed symbol
     |
Optional CLI LLM: JSON Schema report per change group (all symbols)
     |
Validate symbol IDs and recommended file paths, synthesize PR overview
     |
Persist AI narrative independently of deterministic graph
```

## Stable data shape

`Report` contains `meta`, `stats`, `files` (old/new hunk ranges + capped patch), `overview` (`nodes`/`edges`), `groups` (`id`, `title`, `changed_ids`, `files`, contextual `graph`), `topics` (a parent roll-up over existing groups with topic-scoped subgraphs), and `evidence` (line-numbered source excerpts from the actual base/head revisions), plus optional `ai` (a concise diff-grounded statement per changed symbol, optional reviewer notes and rationale, file review order, and suggested topic memberships). Legacy cached AI reports may also contain longer how-it-works and snippet explanations; the frontend keeps those fields readable as collapsed implementation detail. Node IDs are from Graphify or prefixed `ast:` if a Tree-sitter declaration can't be associated to an existing graph node.

A change group is a *cluster of changed symbols*, not necessarily a list of changed files. This makes multi-file feature refactors a single group when relationships support it. Source context can be displayed in several graphs. For oversized connected clusters, greedy modularity identifies candidate splits, followed by bounded connected neighborhoods.

Topics reduce overview density without changing structural groups. Graph-only reports roll groups up by path family. AI report schema version 6 allows the synthesis to suggest specific reviewer topics and an optional one-sentence focus. The synthesis sees validated group summaries, paths, diff summaries, risks, and review routes; every group ID must appear exactly once and unknown IDs invalidate the suggestion. A malformed or overlong focus is discarded without losing a valid group partition. Topic graphs and cross-topic links are projections of verified report nodes and edges; the model cannot add graph entities or relationships. Unchanged topic context excludes structural containment edges such as `contains`, which otherwise surface neighboring declarations without indicating a dependency. Cached reports receive the current deterministic topic graph when the topic rules change, preserving valid saved AI titles and focus.

The detailed walkthrough uses the same validated topic partition and topic order as the change map. Topics follow the earliest file they contain in the validated PR-wide review route, with their previous order retained for ties; member-group symbols follow that file order as well. Each symbol keeps its original group for graph navigation. The optional topic focus appears once in this walkthrough. Reports without a valid AI topic partition use the deterministic path-based topics.

GitHub viewed-file state is fetched on demand through `gh api graphql` for the authenticated viewer. Prism does not persist it in cached reports; refreshing reads the current `viewerViewedState` for changed paths. Mark/unmark actions use GitHub's file-view mutations and are restricted to paths present in that report. The shared UI filter removes viewed files from the map, review route, and detailed walkthrough.

The in-report question endpoint runs as an asynchronous job, independently of graph analysis and report generation. It supplies bounded PR metadata, report summaries, and up to 18 relevance-ranked changed-symbol contexts containing verified source excerpts and symbol-matched diff hunks. The provider returns a separate structured answer with source IDs; Prism discards citations that were not in that exact prompt. General-question citations link to the corresponding changed symbol in the report. Conversation follow-ups reuse a bounded recent history, but earlier model answers are treated as fallible context, not proof.

Each question can opt into repository browsing. Prism starts a per-run stdio MCP server with four tools: list tracked source files, list Tree-sitter declarations in a file, follow cached Graphify relationships, and read exact line ranges. Reads come from Git blobs at the report's verified PR-head commit, not the mutable worktree; file count and byte limits still apply. Returned code excerpts receive audit-backed source IDs, and Prism validates citations against the tool audit. There is no keyword-ranked prefetch. Codex has shell, web, browser, app, plugin and unrelated MCP tools disabled; only the four Prism read tools are enabled and auto-approved. Claude runs with built-in tools disabled and a strict MCP allowlist. Retrieved code is sent to the selected CLI provider only when repository browsing is enabled.

Inline questions use the same endpoint and answer schema with an optional line anchor. The detailed diff reader preserves old/new line coordinates even when it displays a symbol-filtered patch excerpt. The server resolves the requested path and old/new line numbers against the report's cached unified patch, reconstructs the selected +/- rows, and rejects references outside the stored diff; client-supplied source text is never trusted. The anchored diff is the first source in the prompt and the model is instructed to answer about it directly. Inline chats expose model and effort controls backed by the same assistant settings as the general PR chat, while keeping their own bounded follow-up history.

## Cache details

`~/.local/share/prism-pr-review/repos/<hash>/origin` is a normal Git clone, with detached worktrees under `worktrees/<sha>`. Graphs are cached as `graphs/graph-v2-<sha>-<graphify-version>.json`, containing the normalized Graphify extraction. Reports are separate, keyed by repository/PR/merge-base/head SHAs. AI runs can re-use persisted reports. Older reports are opportunistically enriched with source evidence from their retained worktrees; no graph rebuild is required.

Scanning doesn't execute repository scripts, tests, post-checkout hooks or dependency installs. It parses source files. It skips symlinks and unusually large files. Repositories crossing configured caps return an explicit failure rather than silently indexing a subset.

## CLI invocation and trust boundaries

- **Codex:** `codex exec --sandbox read-only --skip-git-repo-check --output-schema ... --output-last-message ... -` with `--model` and `-c model_reasoning_effort=...` when explicitly set.
- **Claude Code:** `claude -p --output-format json --json-schema ... --permission-mode plan --tools "" --disallowedTools "mcp__*"` with model/effort flags when explicitly set.
- **Working directory:** temporary empty directory, never checked-out PR code. Agents receive serialized graph context and bounded patches only. Prompts label PR text untrusted data and tell models not to follow embedded instructions.
- The question adapter uses its own answer-and-citations schema. It validates each citation against the bounded source catalog and does not accept model-created file paths or symbol IDs.
- Question context, including PR text, summaries, source excerpts, diffs, and recent conversation, is sent to the selected CLI provider. GitHub file-view requests use the user's `gh` authentication; Prism does not store GitHub tokens or viewer state in reports.
- This is not a guarantee against prompt injection, leakage through the external harness, or arbitrary user customization of CLI configurations. Running on untrusted PR content must be treated cautiously.

Only the backend accesses Git/processes or local report data. Frontend never executes shell commands. The app listens on loopback; cross-origin POSTs from unrelated web origins are blocked.

## Reviewer-focused AI reports

- A review explanation is generated **per PR change group**, so long PRs do not lose entire segments to prompt truncation. The default per-symbol output is one short statement grounded in that symbol's actual diff hunks.
- Prompts include every changed symbol ID, Graphify relationships, diff hunks, and bounded exact code excerpts (source material, treated as untrusted data).
- Intent is included only when the PR text states it or the diff strongly supports it. Up to two symbol-level reviewer notes are included only for actionable behavior, security, compatibility, correctness, or validation concerns; small diffs still receive a risk review.
- Group and PR summaries, risks, and test suggestions are omitted when they add no distinct reviewer value. Group routes are omitted for one-file groups; the global route lists each affected file once and includes a reason only where the order is not self-evident.
- The server verifies symbol IDs and file paths against the deterministic report. It fills omitted route paths without inventing rationale, preserving a complete review path.
- The frontend shows each route once for the current view, hides empty prose, keeps exact diff lines visible, and collapses fallback source context and legacy long-form explanations by default. The displayed code always comes from the worktree, not the model's imagination.
- Reports with multiple groups have a separate overall synthesis, which can suggest a global cross-group file order and semantic topic partition. All returned paths and symbol IDs are validated against the deterministic report graph.
- The map renders that validated file order as a numbered review path. Selecting a file highlights its changed symbols and directly linked context; the route is a reading recommendation, not a new graph edge.
- Invalid, incomplete, duplicated, or overly fragmented topic partitions fall back to path-based topics; the renderer builds each topic subgraph from existing groups and graph edges.
- Source excerpts are bounded to avoid persisting huge class bodies; if truncated or unavailable, the UI clearly labels that. AI motivations are not proven author intent unless grounded in the PR description.

## Expansion opportunities

- Provider-native model discovery for Claude when a supported endpoint exists.
- Report navigation by stable symbol source links, optionally open in editor.
- GitHub webhook/watch support for incremental PR refresh.
- Richer hierarchical segmentation with cross-group bridge overview.
- Bounded task execution and cancellation, progress streaming over SSE.
- Full report export to Markdown/PDF; inline diff-to-graph hover linking.
- Optional local-repo comparisons without GitHub.
