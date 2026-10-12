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

`Report` contains `meta`, `stats`, `files` (old/new hunk ranges + capped patch), `overview` (`nodes`/`edges`), `groups` (`id`, `title`, `changed_ids`, `files`, contextual `graph`), `topics` (a parent roll-up over existing groups with topic-scoped subgraphs), and `evidence` (line-numbered source excerpts from the actual base/head revisions), plus optional `ai` (overall summary, per-group review order, per-symbol rationale and how-it-works explanation, and suggested topic memberships). Node IDs are from Graphify or prefixed `ast:` if a Tree-sitter declaration can't be associated to an existing graph node.

A change group is a *cluster of changed symbols*, not necessarily a list of changed files. This makes multi-file feature refactors a single group when relationships support it. Source context can be displayed in several graphs. For oversized connected clusters, greedy modularity identifies candidate splits, followed by bounded connected neighborhoods.

Topics reduce overview density without changing structural groups. Graph-only reports roll groups up by path family. When AI explanations are generated, the report synthesis may suggest more semantic topics, but every group ID must appear exactly once and unknown IDs invalidate the suggestion. Topic graphs and cross-topic links are projections of verified report nodes and edges; the model cannot add graph entities or relationships. Unchanged topic context excludes structural containment edges such as `contains`, which otherwise surface neighboring declarations without indicating a dependency. Cached reports receive the current deterministic topic graph when the topic rules change.

## Cache details

`~/.local/share/prism-pr-review/repos/<hash>/origin` is a normal Git clone, with detached worktrees under `worktrees/<sha>`. Graphs are cached as `graphs/graph-v2-<sha>-<graphify-version>.json`, containing the normalized Graphify extraction. Reports are separate, keyed by repository/PR/merge-base/head SHAs. AI runs can re-use persisted reports. Older reports are opportunistically enriched with source evidence from their retained worktrees; no graph rebuild is required.

Scanning doesn't execute repository scripts, tests, post-checkout hooks or dependency installs. It parses source files. It skips symlinks and unusually large files. Repositories crossing configured caps return an explicit failure rather than silently indexing a subset.

## CLI invocation and trust boundaries

- **Codex:** `codex exec --sandbox read-only --skip-git-repo-check --output-schema ... --output-last-message ... -` with `--model` and `-c model_reasoning_effort=...` when explicitly set.
- **Claude Code:** `claude -p --output-format json --json-schema ... --permission-mode plan --tools "" --disallowedTools "mcp__*"` with model/effort flags when explicitly set.
- **Working directory:** temporary empty directory, never checked-out PR code. Agents receive serialized graph context and bounded patches only. Prompts label PR text untrusted data and tell models not to follow embedded instructions.
- This is not a guarantee against prompt injection, leakage through the external harness, or arbitrary user customization of CLI configurations. Running on untrusted PR content must be treated cautiously.

Only the backend accesses Git/processes or local report data. Frontend never executes shell commands. The app listens on loopback; cross-origin POSTs from unrelated web origins are blocked.

## Detailed review generation (v0.2)

- A review explanation is generated **per PR change group**, so long PRs do not lose entire segments to prompt truncation.
- Prompts include every changed symbol ID, Graphify relationships, diff hunks, and bounded exact code excerpts (source material, treated as untrusted data).
- The AI returns one explanation per symbol: inferred/author-stated reason, operation of new code, and commentary on an actual snippet. The displayed code always comes from the worktree, not the model's imagination.
- It also returns an ordered list of the group's files with concrete review rationale. The server verifies every path belongs to the group and inserts any omitted paths, ensuring the route is complete.
- Reports with multiple groups have a separate overall synthesis, which can suggest a global cross-group file order. All returned paths and symbol IDs are validated against the deterministic report graph.
- The map renders that validated file order as a numbered review path. Selecting a file highlights its changed symbols and directly linked context; the route is a reading recommendation, not a new graph edge.
- The same synthesis may suggest a small topic partition over the supplied structural group IDs. Invalid, incomplete, duplicated, or overly fragmented partitions fall back to path-based topics; the renderer builds each topic subgraph from existing groups and graph edges.
- Source excerpts are bounded to avoid persisting huge class bodies; if truncated or unavailable, the UI clearly labels that. AI motivations are not proven author intent unless grounded in the PR description.

## Expansion opportunities

- Provider-native model discovery for Claude when a supported endpoint exists.
- Report navigation by stable symbol source links, optionally open in editor.
- GitHub webhook/watch support for incremental PR refresh.
- Richer hierarchical segmentation with cross-group bridge overview.
- Bounded task execution and cancellation, progress streaming over SSE.
- Full report export to Markdown/PDF; inline diff-to-graph hover linking.
- Optional local-repo comparisons without GitHub.
