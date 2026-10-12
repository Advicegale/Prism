# Testing

Automated Python suite:

```bash
cd backend
.venv/bin/python -m pytest -q
```

Tests cover PR URL validation, malicious URL rejection, Git diff hunk ranges with a real temporary Git repository, Graphify node association via fixture data, added/removed graph relations, deletion-only changes, change segmentation and FastAPI demo/health endpoints.

Manual smoke checklist on Linux and macOS:

1. Run `./setup.sh && ./start.sh`.
2. Open `http://127.0.0.1:4780` and verify the labeled demo report and both change groups.
3. Click a modified class, follow its relationships, inspect the sample diff and graph search/zoom controls.
4. Analyze a small public GitHub PR and confirm snapshots under `~/.local/share/prism-pr-review`.
5. Reopen it from Reports. Validate graph works when harness selector is `Graph only`.
6. If Codex or Claude is installed/authenticated, select it and regenerate an AI narrative. Confirm group references match graph symbols.
7. Try a private PR authenticated with `gh auth login` and verify clones work.

CI or package-integrity tests can run without GitHub credentials using the fixture dataset.

**Build environment limitation:** this delivery was generated in an environment without outbound npm/PyPI access. Backend Python tests were executed successfully, but the live Graphify installation, full GitHub retrieval against a real PR, actual Claude/Codex calls and production frontend bundle were **not** executed end-to-end here. The `setup.sh` workflow is intended to run and build those pieces on a networked Linux/macOS machine.
