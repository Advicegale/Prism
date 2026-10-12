"""GitHub retrieval and isolated git worktrees. No repository code is executed."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from urllib.parse import urlparse
from . import settings

PR_RE = re.compile(r"^/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)(?:/.*)?$")
SHA_RE = re.compile(r"^[a-f0-9]{40}$")

class RepoError(RuntimeError):
    pass


def parse_pr_url(url: str) -> tuple[str, str, int]:
    try:
        parsed = urlparse(url.strip())
        if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.port or parsed.username or parsed.password:
            raise ValueError()
        match = PR_RE.fullmatch(parsed.path.rstrip("/"))
        if not match or match.group(1) in (".", "..") or match.group(2) in (".", ".."):
            raise ValueError()
        return match.group(1), match.group(2), int(match.group(3))
    except (ValueError, TypeError) as exc:
        raise RepoError("Enter a valid https://github.com/owner/repo/pull/123 URL.") from exc


def command(args: list[str], *, cwd: Path | None = None, timeout: int = 180, input: str | None = None) -> str:
    try:
        p = subprocess.run(args, cwd=cwd, input=input, text=True, capture_output=True,
                           timeout=timeout, check=False, env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"})
    except FileNotFoundError as exc:
        raise RepoError(f"Missing command: {args[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RepoError(f"Command timed out: {args[0]} {args[1] if len(args)>1 else ''}") from exc
    if p.returncode:
        raise RepoError((p.stderr or p.stdout or "Command failed").strip()[:1000])
    return p.stdout


def github_token() -> str | None:
    if os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN"):
        return os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")
    if shutil.which("gh"):
        try:
            return command(["gh", "auth", "token"], timeout=6).strip() or None
        except RepoError:
            pass
    return None


def pr_metadata(owner: str, repo: str, number: int) -> dict:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "prism-pr-review/0.1"})
    token = github_token()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            info = json.load(response)
    except urllib.error.HTTPError as exc:
        status = exc.code
        raise RepoError(f"GitHub API returned {status}. For private repositories, sign in with `gh auth login` or set GH_TOKEN.") from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise RepoError(f"Couldn't retrieve pull request metadata: {exc}") from exc
    base, head = info.get("base", {}).get("sha", ""), info.get("head", {}).get("sha", "")
    if not SHA_RE.fullmatch(base) or not SHA_RE.fullmatch(head):
        raise RepoError("GitHub returned invalid revision data")
    return {"owner":owner,"repo":repo,"number":number,"title":info.get("title", ""),
            "body": (info.get("body") or "")[:12000],"url":info.get("html_url", ""),
            "base":base,"head":head,"base_ref":info.get("base",{}).get("ref", ""),
            "head_ref":info.get("head",{}).get("ref", ""),
            "state":info.get("state", ""),"draft":info.get("draft",False),
            "changed_files":info.get("changed_files", 0),"author":(info.get("user") or {}).get("login", "")}


def prepare_worktrees(meta: dict) -> tuple[Path, Path, Path, str]:
    owner, repo, number = meta["owner"], meta["repo"], meta["number"]
    base_sha, head_sha = meta["base"], meta["head"]
    for sha in (base_sha, head_sha):
        if not SHA_RE.fullmatch(sha):
            raise RepoError("Unsafe revision identifier")
    repo_root = settings.DATA_DIR / "repos" / hashlib.sha256(f"{owner}/{repo}".encode()).hexdigest()[:20]
    repo_root.mkdir(parents=True, exist_ok=True)
    checkout = repo_root / "origin"
    remote = f"https://github.com/{owner}/{repo}.git"
    if not (checkout / ".git").exists():
        if shutil.which("gh") and github_token():
            command(["gh", "repo", "clone", f"{owner}/{repo}", str(checkout), "--", "--filter=blob:none", "--no-checkout"], timeout=240)
        else:
            command(["git", "clone", "--filter=blob:none", "--no-checkout", remote, str(checkout)], timeout=240)
    # Pull request merge-base is the proper diff target; GitHub's base branch may have advanced.
    command(["git", "-C", str(checkout), "fetch", "--no-tags", "origin", base_sha, f"refs/pull/{number}/head"], timeout=240)
    # The API head revision may differ from the PR's latest ref if it was force-pushed during fetch.
    command(["git", "-C", str(checkout), "cat-file", "-e", f"{head_sha}^{{commit}}"])
    merge_base = command(["git", "-C", str(checkout), "merge-base", base_sha, head_sha]).strip()
    worktree_root = repo_root / "worktrees"
    worktree_root.mkdir(exist_ok=True)
    paths = []
    for sha in (merge_base, head_sha):
        path = worktree_root / sha
        if not path.exists():
            command(["git", "-C", str(checkout), "worktree", "add", "--detach", str(path), sha], timeout=240)
        paths.append(path)
    return checkout, paths[0], paths[1], merge_base


def diff_files(repo: Path, base_sha: str, head_sha: str) -> list[dict]:
    """Parse unified zero-context hunks and track line ranges on both sides."""
    content = command(["git", "-C", str(repo), "diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=0", base_sha, head_sha, "--"], timeout=120)
    results: list[dict] = []
    current: dict | None = None
    hunk = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
    for line in content.splitlines():
        if line.startswith("diff --git "):
            current = {"path": "", "old_path": "", "status":"modified", "new_ranges": [], "old_ranges": [], "patch": ""}
            results.append(current)
        elif current is None:
            continue
        elif line.startswith("+++ b/"):
            current["path"] = line[6:]
        elif line.startswith("--- a/"):
            current["old_path"] = line[6:]
        elif line.startswith("new file mode"):
            current["status"] = "added"
        elif line.startswith("deleted file mode"):
            current["status"] = "deleted"
        elif line.startswith("rename from "):
            current["old_path"] = line[12:]
            current["status"] = "renamed"
        elif line.startswith("rename to "):
            current["path"] = line[10:]
        match = hunk.match(line)
        if match and current:
            start_old, old_count, start_new, new_count = [int(match.group(i) or ("1" if i in (2,4) else "0")) for i in range(1,5)]
            if new_count:
                current["new_ranges"].append([start_new, start_new + new_count - 1])
            if old_count:
                current["old_ranges"].append([start_old, start_old + old_count - 1])
        if current:
            # Include metadata and diff text, with per-file cap to bound stored reports.
            if len(current["patch"]) < 16000:
                current["patch"] += line + "\n"
    return [r for r in results if r["path"] or r["old_path"]]


def _github_graphql(query: str, variables: dict) -> dict:
    """Call GitHub GraphQL through the user's authenticated GitHub CLI."""
    if not shutil.which("gh"):
        raise RepoError("GitHub CLI (`gh`) is not installed. Install it to sync viewed-file status.")
    payload = json.dumps({"query": query, "variables": variables})
    try:
        response = command(["gh", "api", "graphql", "--hostname", "github.com", "--input", "-"],
                           input=payload, timeout=30)
    except RepoError as exc:
        detail = str(exc)
        if "not logged in" in detail.lower() or "authentication" in detail.lower():
            detail = "Sign in to GitHub CLI with `gh auth login`, then retry."
        raise RepoError(f"GitHub CLI could not update review status: {detail}") from exc
    try:
        result = json.loads(response)
    except ValueError as exc:
        raise RepoError("GitHub CLI returned an invalid GraphQL response.") from exc
    errors = result.get("errors") or []
    if errors:
        message = "; ".join(str(error.get("message") or "GraphQL request failed") for error in errors[:3])
        raise RepoError(f"GitHub GraphQL request failed: {message[:700]}")
    data = result.get("data")
    if not isinstance(data, dict):
        raise RepoError("GitHub GraphQL response did not contain pull request data.")
    return data


def github_viewed_file_states(owner: str, repo: str, number: int) -> dict[str, str]:
    """Return current-user viewed state for every changed file in a pull request."""
    query = """query($owner:String!, $repo:String!, $number:Int!, $after:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          files(first:100, after:$after) {
            nodes { path viewerViewedState }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }"""
    states: dict[str, str] = {}
    after = None
    while True:
        data = _github_graphql(query, {"owner": owner, "repo": repo, "number": number, "after": after})
        pull_request = (data.get("repository") or {}).get("pullRequest")
        if not pull_request:
            raise RepoError("GitHub did not return this pull request. Check the URL and your `gh` account access.")
        connection = pull_request.get("files") or {}
        for item in connection.get("nodes") or []:
            path, state = item.get("path"), item.get("viewerViewedState")
            if isinstance(path, str) and state in {"VIEWED", "UNVIEWED", "DISMISSED"}:
                states[path] = state
        page_info = connection.get("pageInfo") or {}
        if not page_info.get("hasNextPage"):
            return states
        after = page_info.get("endCursor")
        if not after:
            raise RepoError("GitHub omitted the cursor while listing changed files.")


def set_github_file_viewed(owner: str, repo: str, number: int, path: str, viewed: bool) -> None:
    """Mark or unmark one changed file for the authenticated GitHub viewer."""
    pr_query = """query($owner:String!, $repo:String!, $number:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) { id }
      }
    }"""
    data = _github_graphql(pr_query, {"owner": owner, "repo": repo, "number": number})
    pull_request = (data.get("repository") or {}).get("pullRequest")
    pull_request_id = pull_request.get("id") if pull_request else None
    if not pull_request_id:
        raise RepoError("GitHub did not return this pull request. Check the URL and your `gh` account access.")
    mutation_name = "markFileAsViewed" if viewed else "unmarkFileAsViewed"
    mutation = f"""mutation($input:{'MarkFileAsViewedInput' if viewed else 'UnmarkFileAsViewedInput'}!) {{
      {mutation_name}(input:$input) {{ clientMutationId }}
    }}"""
    _github_graphql(mutation, {"input": {"pullRequestId": pull_request_id, "path": path}})
