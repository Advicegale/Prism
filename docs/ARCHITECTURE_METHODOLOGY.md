# General-purpose review-map methodology

Prism uses one graph contract across languages and project types. It does not require an application to have views, services, repositories, or any other predefined architectural categories.

## 1. Establish the immutable change boundary

Use the PR merge-base and head commits. Inventory bounded tracked text directly from Git blobs, independently of file extension or installed parsers. Retain every changed file, including binary/non-readable files, even when no relationship can be established. Never silently equate source coverage with complete runtime behavior.

## 2. Collect evidence

Use available deterministic parsers and recognizers as accelerators: symbol graphs, resolved imports, markup/resource references, endpoints and SQL objects. Missing parser support is not a reason to reject the review; retain file nodes and allow exact source reads. Inventory and snippets are discovery aids, not proof of a relationship.

## 3. Trace the change with the selected model

Give the model the complete changed-file manifest, bounded diff/source seeds and compact extracted-fact references. Full fact evidence stays in Prism and is preserved during validation; it is not duplicated in the initial prompt. Optional seeds share explicit byte budgets and the model can load additional exact source through the tools. It can browse paths and read source at either exact revision through restricted read-only tools. The model traces the affected behavior and selects only context needed to explain connections. It must read selected context and cite both endpoints of newly interpreted relationships.

This is the same task for Java, C#, Python, JavaScript, Godot, libraries and scripts. Framework knowledge can guide investigation; conventions alone are insufficient evidence.

## 4. Propose repository-specific organization

The model proposes ordered groups, their file membership and optional focus. Groups can represent real architectural roles, behavior slices, boundaries or supporting material. There is no mandatory taxonomy or column sequence. The only presentation choices are ordinary files, a coherent bundle, or a supporting group whose file list starts collapsed.

Examples might be controllers/business rules/persistence, scene composition/player behavior/resources, or input parsing/transformation/output. These are examples, not categories encoded in the application.

## 5. Validate the common graph contract

- Every changed file appears exactly once, including isolated changes.
- Selected context paths exist and have supplied/audited source reads.
- Groups have unique membership and respect explicit readability budgets.
- Extracted fact IDs must match their original endpoints; their relation type cannot be upgraded by a model label.
- Interpreted edges must cite valid ranges from both endpoint files, within the supplied or audited read catalog. Evidence is reconstructed from exact Git source, not model-provided code.
- Existing extracted relationships between selected files survive model omissions.
- Invalid proposed edges are discarded and reported. Invalid group partitions fail without replacing a previously accepted map.
- Renamed nodes can cite their original paths at the base revision.

Citation validation proves the source exists and was supplied/read. It does **not** mechanically prove an LLM's semantic claim. Newly interpreted edges remain identified as model interpretations and do not acquire an invented added/removed status.

## 6. Render and persist

Render groups in their proposed order. File review rank seeds a bounded, deterministic within-group slot optimizer; connections then determine clearer positions without changing group membership. Four-row grids favor a narrower footprint at readable native scale. A background worker allocates distinct side ports, reserves future attachment access, routes around card obstacles without shared segments, and marks perpendicular crossings with bridge arcs. Multiple relationships for the same directed displayed pair share one inspectable edge; mixed confidence is styled separately. Bundles and supporting sections retain their original references. Re-click a selected file or connection to deselect it; there is no Close/Clear selection control or background-tap deselection. Selection and zoom never rerun the layout. Architecture and Symbols & topics remain mounted when switching views, preserving their layout and viewport state. The layout worker is embedded in the app bundle rather than loaded from a separate hashed asset, so an open page can still create workers after a local frontend rebuild. Source evidence and the existing symbol/diff explorer remain accessible.

Ordering has a 1.2-second refinement budget and uses up to 160 pair seeds when the graph is denser; every pair is still drawn. Routing has a 4-second budget and tries deterministic route orders. If separate lanes cannot be found within those bounds, an explicit note identifies the less constrained or direct-line fallback; no files or references are silently removed. The symbol explorer continues to use Cytoscape; the file map uses SVG and native cards. Run `npm run test:layout` in `frontend/` for coverage, future-port reservation, lane/card separation, repeatability and bridge checks.

Persist the accepted map with head/base SHAs, organizer version, provider, model, effort and timestamp. Opening a saved report reuses its map without another model invocation. Explicit Rebuild map can change the interpretation. Caching and invariant checks provide consistency; they do not promise identical model output across fresh runs or correctness on every language/framework.

## Operational boundaries

The source-only mode is a neutral graph of extracted references, not a claim of discovered architectural roles. AI analysis and Discover architecture invoke source browsing through the user's selected Codex/Claude CLI. Only bounded tracked text reads and structural navigation tools are enabled; there is no repository shell, GitHub write or source execution.

Current budgets: configured source file/byte limits; 110,000 UTF-8 bytes per initial discovery prompt; 12 groups; 40 context files; up to 160 proposed edges; 80 lines per tool read; 12 lines per citation. These are resource/readability budgets, not architectural categories. Over-budget or unreadable inputs produce explicit errors/notes rather than fabricated context.

Current text decoding is UTF-8. Binary assets, non-UTF-8 source, dependency artifacts, dynamic runtime wiring and incomplete model investigation can leave unresolved relationships. The map is a review aid with inspectable evidence, not an execution trace or compiler proof.
