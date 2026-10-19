# Testing

Use the installed environments:

```bash
cd backend
.venv/bin/python -m pytest -q
cd ../frontend
npm run test:diff
npm run test:review
npm run test:layout
npm run test:export
npm run test:exploration
npm run test:reading
npm run test:routes
npm run test:assistant
npm run build
```

Review-context regressions verify that fresh/cached analyses and Explain reruns pass the head checkout, and that every group check and synthesis receives both pinned revisions and repository-inspection guidance.

Python tests cover Git revisions/diff ranges, Graphify association, legacy report/topic compatibility, architecture, exact source, restricted repository tools, provider command/prompt validation and FastAPI endpoints. Exploration tests select source positions across the five original languages and 35 additional Graphify language/template formats. Registry tests also cover five further cross-file field/construction/wrapper families, C#/Kotlin/Swift/PHP static constructions, shared lexical shadowing, new provider registration, shebang routing and cache invalidation. They verify ordinary roots/shadowing, owned fields, external constructions, assignments/wrapping/imports, origins/sibling exclusions, usage-result stops, shared files, unchanged bridges, cycles, unknown fields and explicit unsupported states. They also cover namespace/default/reexports/manifest aliases, Unicode/CRLF, old/new renamed source, partial inventories, cache restoration, cursor validation, paired independent cursors with clicked-alias hidden-path evidence/filter context/sibling exclusion, and the indexing-response race. Passive reviewed source is never executed. Tests need no GitHub/provider credentials.

Route regressions (`test:routes`) cover every hash route kind, fallbacks for garbage, bad or uppercase ids, unknown views and trailing slashes, file names with spaces, unicode, `#`, `?`, `%` and `+` round-tripping through `formatRoute`/`parseRoute`, and tab titles.

Assistant checks (`test:assistant`) cover the saved single assistant and the AI-notes checkbox: fresh defaults, migration from the old question and Analyze keys (including `none` turning AI notes off), question-key precedence, corrupt or partial saved values, save/load round trips, summaries, model and effort options, and falling back to the installed CLI.

Frontend regressions cover Split/Unified alignment and side-specific anchors, source ordering and word changes, topic/file coverage, architecture layout, escaped offline HTML, generic UTF-16 click offsets, selection preservation, renamed revision paths, near-viewport bounds, half/full window placement opposite the click, drag/resize/clamp limits, splitter limits, clicked-source centering, resize-stable map panning, whole-graph initial fit, connection summaries (de-duplicated kinds, singular/plural and indirect unchanged-file counts), wheel-zoom anchoring/clamping/fit helpers, causal paired-projection merging, stale completion-state isolation and merged/cyclic file layout. Reading checks (`npm run test:reading`) cover the width-based diff layout with hysteresis, shortcut keys, modifier and editable-field exclusion, and symbol-explorer exclusion. Production build type-checks the React integration.

Parser regressions in `test_parser_fixes.py` cover literal JSX ampersands (including Unicode/CRLF, multiple labels and fragments), PostgreSQL migration constructs and C# pointer assignments. They verify exact retained source and symbol anchors, following declarations, assignment operands, explicit pointer-memory boundaries and continued diagnostics for malformed syntax. Run setup before these tests so the corrected parser wheels are installed.

To audit both retained revisions of every report currently in the local preview data:

```bash
backend/.venv/bin/python scripts/audit-preview-parsers.py --output /tmp/parser-audit.json
```

The audit reads immutable Git blobs, uses Graphify's filename/suffix/shebang dispatch and checks every available syntax grammar, including unchanged files. It exits nonzero for remaining failures and records locations, missing tokens and package versions. No GitHub request, AI run, compilation or execution of reviewed source occurs. [Current preview evidence](exploration-parser-audit.json) records the before/after results.

## Desktop symbol exploration QA

Use `./scripts/dev.sh`, or build the frontend and run `./start.sh`. Open a retained report from Recent reports; reanalysis is unnecessary.

A reproducible source-backed local report uses two real Git commits and isolated cache data:

```bash
backend/.venv/bin/python scripts/exploration-fixture.py
# Add --clicked-alias to check distinct definition/source files and both-way expansion.
# Add --language go to check Go field/import bridges plus a native Dart root.
# Copy data_dir from the JSON output. Stop any server on port 4780.
PRISM_DATA_DIR=/tmp/<printed-directory> backend/.venv/bin/python -m uvicorn prism.app:app --app-dir backend --host 127.0.0.1 --port 4780
```

Use the direct command for isolated QA: start.sh loads .env, which can override shell PRISM_DATA_DIR/PORT values. Browser Origin checks allow the normal 4780/5173 ports. The fixture's GitHub viewed status is expected to be unavailable. No package installation, GitHub analysis or AI run is needed.

1. Open Topics/config.ts and click the ordinary After attempts name. Verify the new SHA, real definition and Changed files only enabled. The clicked config.ts is centered and its snippet opens first. Both expansion controls appear in one tree.
2. Expand downstream. One screen.ts node should annotate client/retryPolicy with two indirect connections retaining client.ts/policy.ts. Unchanged bridges, logger.ts and responses.ts stay hidden/excluded.
3. Inspect files, connections and individual anchors. Hidden source opens inside the same popover. Record its rectangle, root, main file and page/diff scroll before/after inspection; they remain unchanged. Map/source regions scroll internally.
4. Click primary in a client.ts snippet. Its global root replaces the previous one in the same box; secondary is excluded. Both directions share one tree; changed/all views retain their independent expansions.
5. X/Escape dismisses; Connections reopens retained state. Check focus restoration. Literal/comment clicks and drag-select/copy must not initiate investigations.
6. Select Before retries versus After attempts, including Unified removals/additions. Verify old/new SHA and exact snippet names; context defaults to After.
7. Open an inline chat through a gutter button without submitting. Switch Split/Unified and retain the conversation. Check range selection, Wrap/Highlight, Copy diff and reader navigation. Offline export has no live explorer.
8. Switch reports/roots/filters during requests. Stale responses must not repaint a later view. Missing source, unsupported language, unresolved binding, partial analysis and usage endpoints have distinct explanations.

October 13–14 validation (including the evergreen registry correction) used the native collaborative desktop preview with the isolated Git report and retained AHOY25 source. Backend/frontend regressions and the production build were executed. New provider analyses, reviewed repository code execution and mobile QA were not performed. See [coverage and measured performance](SYMBOL_EXPLORATION.md).

For `--clicked-alias`, open Topics/screen.ts and click After `transportClient` on the import line. The root is `primary` in client.ts, while the initial source and centered card are screen.ts. Expand upstream to tuning.ts and downstream to consumer.ts, then end.ts; each retains the opposite branch. Secondary, logger and retryPolicy-derived outputs remain excluded. Definition inspects client.ts without moving the map/reader; Clicked source restores screen.ts. Toggle Changed files only and back to recover both expanded branches. Pan the map, close/reopen, and resize to 1440×900 and 1920×1080; verify readable stacked/side-by-side panes, stable inspection bounds and initial source centering. [Bidirectional browser evidence](exploration-bidirectional-browser-qa.json) records the current proof; earlier 880×680 screenshots are historical.

## Complete review workspace

`test_review_workspace.py` uses real passive Git commits to check exact source/diff pagination beyond old caps, long Unicode/CRLF lines, Git LF coordinates with control separators, binary/symlink/empty files, non-UTF-8 filenames, both revisions/history, full description retrieval, shared guide evidence, finding retention, authenticated GitHub pagination/redirect isolation and universal Q&A. A filtered clone regression ensures listing a revision does not fetch all its blobs. Cache tests preserve both archived guides and concurrently saved notes. Tool-server tests verify malformed calls return errors without terminating the session.

A manual live CLI probe is available in `scripts/probe-review-workspace.py`; it invokes the authenticated installed Codex and Claude CLIs against temporary passive fixtures. See [workspace verification and remaining limits](REVIEW_WORKSPACE.md). Automated tests do not invoke models or GitHub.

## Whole-PR call orchestration

`test_review_batching.py` verifies 36 structural groups use one guide invocation while preserving global file order, semantic topics and every change entry; oversized groups/metadata are split without lost IDs or observations, and only multi-batch guides receive a final synthesis call. Missing/duplicate group or symbol responses fail without extra model calls or mutation of the previous guide. Prompt tests exercise file facts, full-workspace access and short valid JSON seeds in both combined and batched modes. `review_state` records guide-call counts and timings separately from architecture preparation.

`test_progressive_review.py` verifies plan publication before detail calls, topic scheduling by validated reading order, immutable plan/topic membership, partial large-topic checkpoints, retained feedback on failures, early running-job report IDs, independent question scheduling, latest-field merging and restart interruption. Browser QA uses a separate temporary data directory and a controlled provider fixture so no retained reports are changed.

`test_diff_first_review.py` forbids Graphify extraction/collection and exploration index jobs during review preparation/opening, proves parsing is restricted to diff paths despite a large unchanged corpus, checks on-demand revision selection/deduplication, and preserves rename/deletion/binary/config anchors and existing maps/guides. `test_exploration_prefetch.py` retains tests for the explicit opt-in warm-up helper and verifies app entry points never call it.

Inline chat placement manual regression: use a long context hunk; open line5 chat and verify it sits between lines5/6; enter a draft and Shift-click line8, verifying placement after the range and unchanged draft; switch Unified/Split while retaining the same composer/conversation; submit via a controlled fixture and verify the answer survives further mode switches; open a second Before/After chat and verify alignment/independent state. Diff/export checks and production build cover unaffected rendering/export behavior.

`test_analysis_timings.py` uses a controlled monotonic clock to verify viewability vs finalization, failure/no-AI states, regeneration without idle-time inflation and architecture-only timing preservation. `npm run test:timing` checks duration formatting and tooltip labels for completed/running/failed/graph-only/regenerated/legacy records.
