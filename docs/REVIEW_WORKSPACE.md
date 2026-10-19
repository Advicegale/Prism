# Review workspace: first delivery

Prism's primary purpose is improving the human's own review experience: coherent topics, a useful topic/file order, architecture, explanations, and source exploration. Complete access supports those outputs as well as detecting concrete defects. Prompts explicitly preserve that priority; useful review questions need not imply a bug.

## Implemented

Every model invocation in the app receives the same pinned repository interface. There is no report-only question mode. Old clients sending `include_repository_context=false` cannot disable it; the obsolete field is ignored. Selecting Graph only still makes no model call.

The twelve tools expose all tracked paths, exact source on both PR sides (plus target tip and available historical commits), paginated UTF-8 text, byte-exact blobs, literal repository-wide content search, complete changed-path inventories and diffs, commit history, full shared report context, and read-only GitHub context. Source reads are independent of graph/parser/indexing limits and include unchanged code. Tree listings do not request blob sizes, avoiding a fetch of every file just to navigate a partial clone; size is unknown until content is read. LF-only source coordinates match Git even with Unicode/control separators. A symlink is its committed target string, never a filesystem traversal. LFS pointers and submodule entries remain distinguishable from their referenced contents.

Large responses have continuation rather than inaccessible tails. `read_source` returns `next_range` with a line and character column; `read_text`/`read_diff`/`read_context` use character offsets; `read_blob` uses byte offsets. Search/list/history results have result-offset continuation. `read_github` has both character-offset continuation within a response and page continuation across collection pages. GitHub source is pinned by SHA, while discussions/checks are timestamped observations. Tree reads are nonrecursive; follow subtree SHAs. API file contents may be base64 or require tree/blob reads for large content. Missing permissions or unavailable resources produce errors rather than inferred contents.

Prompts carry a compact complete-or-explicitly-partial whole-PR manifest and pointers to full data. The architecture and all previous validated group observations are retrievable by later stages. Notes and risks are retained even for single-symbol changes, and synthesis receives symbol notes/rationale. Source read provenance is saved in AI `review_state`, which explicitly marks correctness coverage as not measured. File/topic order remains separate from defect counts; the existing separate Tests section is preserved.

Full patches are stored for fresh analyses. Opening a legacy report recovers complete patches from retained Git blobs without another AI call. Saved notes are preserved on open. Explicit reanalysis upgrades old changed-symbol mappings and archives AI results tied to the obsolete group structure under `previous_ai` before generating replacements. Legacy PR bodies without `meta.body_complete=true` can be recovered with `read_github resource=pr`. This preserves all sibling declarations in a whole-file hunk.

## Authentication and execution

GitHub reads use GH_TOKEN/GITHUB_TOKEN or existing gh authentication inside the backend. Model tools select a resource, owner/repository, ID and optional SHA/path; they cannot select an arbitrary host or HTTP method. GitHub redirects drop authorization when the authority changes. Source/GitHub text is untrusted evidence, never instructions. Reviewed source is parsed or read, never executed. Both CLIs receive prompt text on stdin and a strict Prism tool allowlist with shell/built-in execution disabled.

## Limits and next milestones

This delivery improves the existing guide pipeline rather than replacing its topic schema or orchestration:

- Topics still partition structural group IDs, so an oversized structural group cannot yet be split into independently named file-based topics. A first-class guide schema with richer topic/file relationships is follow-up work.
- Shared group observations and the architecture are available across stages, but the model is responsible for deciding what additional source to inspect. Availability is not a claim of inspection or comprehension.
- Calls still run with timeouts (normally 360 seconds, architecture 600); Claude's turn budget is configurable (`PRISM_REVIEW_MAX_TURNS=48`). Fetching a historical/target blob not present locally may need Git network access and can time out. Automatic continuation/resume, durable pending investigations and file/hunk review-coverage tracking remain follow-ups.
- Git source/diff/search outputs and API response bodies are currently materialized before pagination. Very large files/results can hit memory or command timeouts. Streaming/spooled retrieval is a follow-up; no permanent source eligibility cap is reintroduced.
- Search is literal, matches tracked nonbinary content, and is independent of parser coverage. Symbols/relationships remain optional, incomplete navigation hints; related-symbol graphs are head-only.
- Binary bytes and linked GitHub blobs are retrievable, but model-facing image/document viewers, automatic LFS/submodule fetching and generic CI artifact downloads are not implemented.
- GitHub observations are stable within a provider call, not a durable shared snapshot across all calls. GitHub-specific evidence is returned with URL/time; structured Q&A citations currently validate numbered source reads rather than every metadata/history/diff tool result.
- Current code-access regressions and CLI probes demonstrate retrieval. Better topic quality and reading order require real-guide comparisons and the user's assessment; no quality improvement is inferred merely from a passing access test.

## Verification

`backend/.venv/bin/python -m pytest -q backend/tests` covers lossless source/diff continuation beyond prior caps, literal search at both revisions, unusual paths, binary/symlink payloads, full descriptions, shared observations/concern retention, universal Q&A, CLI allowlists/stdin, GitHub auth/redirects/pagination and cached report migration.

Frontend checks: `npm run build`, `npm run test:review`, `npm run test:assistant`, `npm run test:diff`, `npm run test:export`. The remaining existing frontend scripts can run independently.

For an explicit live probe (invokes installed, authenticated provider CLIs):

```bash
PYTHONPATH=backend backend/.venv/bin/python scripts/probe-review-workspace.py
```

The probe creates passive temporary Git commits and hides random markers in unchanged code, deleted base code, a PR body after character 13,000 and a diff after character 16,000. It reports marker recovery and source-read counts without printing marker values. It executes no reviewed source. This is a manual integration check, not part of pytest.
