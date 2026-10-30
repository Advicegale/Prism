"""Real Git fixtures establish lossless access independently of model behavior."""
import base64
import copy
import json
import subprocess
import urllib.request
from pathlib import Path
from types import SimpleNamespace
import pytest
from prism import harness, settings, symbols
from prism.repository_tools import RepositoryTools, RepositoryToolError, TOOL_NAMES
from prism.github_context import read_github, GitHubReadError, _GitHubRedirect


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


@pytest.fixture
def workspace(tmp_path):
    git(tmp_path, 'init', '-q'); git(tmp_path, 'config', 'user.email', 'test@example.invalid')
    git(tmp_path, 'config', 'user.name', 'Test')
    (tmp_path / 'old.py').write_text('def old():\n    return "OLD_ONLY"\n')
    (tmp_path / 'long.txt').write_text('before\n')
    (tmp_path / 'unchanged.custom').write_text('callback = "needle"\n')
    git(tmp_path, 'add', '.'); git(tmp_path, 'commit', '-qm', 'base')
    base = git(tmp_path, 'rev-parse', 'HEAD')
    (tmp_path / 'old.py').rename(tmp_path / 'renamed.py')
    (tmp_path / 'vendor').mkdir(); (tmp_path / 'vendor' / 'data.custom').write_text('needle in vendor\n')
    (tmp_path / 'long.txt').write_bytes(('é' * 600 + 'needle' + 'x' * 700_000 + '\r\nTAIL\r\n').encode())
    (tmp_path / 'empty.txt').write_text('')
    (tmp_path / 'image.png').write_bytes(b'\x89PNG\0\xff\n')
    (tmp_path / 'odd\nname ü.txt').write_text('needle\n')
    (tmp_path / 'link').symlink_to('/etc/passwd')
    git(tmp_path, 'add', '.'); git(tmp_path, 'commit', '-qm', 'head')
    head = git(tmp_path, 'rev-parse', 'HEAD')
    meta = {'owner': 'owner', 'repo': 'repo', 'number': 12, 'head': head, 'merge_base': base, 'base': base,
            'body': 'x' * 13000 + 'FULL_REQUIREMENT'}
    tools = RepositoryTools(tmp_path, head, tmp_path / 'audit.jsonl', base, {'meta': meta})
    return tools, tmp_path, base, head


def pages(call, **args):
    offset = 0; text = ''
    while True:
        result = call(dict(args, offset=offset, limit=3000))
        text += result['text']
        if result['next_offset'] is None: return text
        assert result['next_offset'] > offset
        offset = result['next_offset']


def test_inventory_ignores_analysis_limits_and_keeps_special_files(workspace, monkeypatch):
    tools, root, base, head = workspace
    monkeypatch.setattr(settings, 'MAX_FILES', 1)
    monkeypatch.setattr(settings, 'MAX_FILE_BYTES', 1)
    monkeypatch.setattr(settings, 'MAX_TOTAL_BYTES', 1)
    tools = RepositoryTools(root, head, root / 'audit2.jsonl', base)
    offset = 0; paths = []
    while True:
        result = tools.list_files({'offset': offset, 'limit': 2})
        paths += result['files']
        assert result['inventory_limited'] is False
        if result['next_offset'] is None: break
        offset = result['next_offset']
    assert {'long.txt', 'vendor/data.custom', 'image.png', 'empty.txt', 'link', 'odd\nname ü.txt'} <= set(paths)
    assert base64.b64decode(tools.read_blob({'path': 'link'})['data']) == b'/etc/passwd'
    assert base64.b64decode(tools.read_blob({'path': 'image.png'})['data']) == (root / 'image.png').read_bytes()
    assert tools.read_source({'path': 'empty.txt'})['total_lines'] == 0


def test_lossless_source_continuations_and_immutable_reads(workspace):
    tools, root, base, head = workspace
    original = (root / 'long.txt').read_bytes().decode()
    (root / 'long.txt').write_text('dirty worktree contents')
    assert pages(tools.read_text, path='long.txt') == original
    first = tools.read_source({'path': 'long.txt', 'start_line': 1, 'end_line': 1})
    assert 'needle' in first['code']
    assert first['next_range']['start_column'] > 300
    tail = tools.read_source({'path': 'long.txt', **first['next_range']})
    assert 'x' * 500 in tail['code']
    assert tools.read_source({'path': 'old.py', 'revision': 'base'})['revision'] == base
    assert 'OLD_ONLY' in tools.read_source({'path': 'old.py', 'revision': base})['code']
    assert tools.list_symbols({'path': 'old.py', 'revision': 'base'})['symbols'][0]['name'] == 'old'
    with pytest.raises(RepositoryToolError): tools.read_source({'path': '../outside'})
    with pytest.raises(RepositoryToolError): tools.read_source({'path': '/etc/passwd'})
    with pytest.raises(RepositoryToolError): tools.list_files({'revision': '--help'})


def test_complete_diff_search_and_history_across_both_revisions(workspace):
    tools, root, base, head = workspace
    patch = pages(tools.read_diff)
    assert 'TAIL' in patch and len(patch) > 700000
    expected = subprocess.check_output(['git', '-C', str(root), 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
                                        '--find-renames', '--unified=3', base, head, '--']).decode('utf-8')
    assert patch == expected
    changed = []; offset = 0
    while True:
        result = tools.list_changes({'offset': offset, 'limit': 2}); changed += result['files']
        if result['next_offset'] is None: break
        offset = result['next_offset']
    assert any(f['old_path'] == 'old.py' and f['path'] == 'renamed.py' and f['status'].startswith('R') for f in changed)
    result = tools.search_source({'query': 'needle', 'limit': 1})
    assert result['total'] == 4 and result['next_offset'] == 1
    hits = [tools.search_source({'query': 'needle', 'offset': i, 'limit': 1})['matches'][0] for i in range(4)]
    assert {h['path'] for h in hits} == {'long.txt', 'unchanged.custom', 'vendor/data.custom', 'odd\nname ü.txt'}
    hit = next(h for h in hits if h['path'] == 'long.txt')
    assert hit['column'] == 601 and 'needle' in hit['text']
    assert tools.search_source({'query': 'OLD_ONLY', 'revision': 'base'})['matches'][0]['path'] == 'old.py'
    history = tools.read_history({'limit': 1})
    assert history['commits'][0]['sha'] == head and history['next_offset'] == 1
    assert tools.read_history({'limit': 1, 'offset': 1})['commits'][0]['sha'] == base


def test_full_body_and_cross_pass_context_are_retrievable(workspace):
    tools, root, base, head = workspace
    assert 'FULL_REQUIREMENT' in pages(tools.read_context, section='meta')
    assert set(TOOL_NAMES) == {s['name'] for s in tools._tool_specs()}
    assert not any(s['inputSchema'].get('additionalProperties', True) for s in tools._tool_specs())


def test_whole_file_addition_keeps_sibling_functions(tmp_path):
    (tmp_path / 'new.py').write_text('def first():\n    return 1\n\ndef second():\n    return 2\n\ndef third():\n    return 3\n')
    assert {s['name'] for s in symbols.changed_symbols(tmp_path, 'new.py', [[1, 8]])} == {'first', 'second', 'third'}


def test_prompt_shortening_is_structured_and_honest(monkeypatch):
    from test_harness import _facts_report
    report = _facts_report()
    report['meta']['body'] = 'B' * 15000
    monkeypatch.setattr(settings, 'MAX_DIFF_CHARS', 1)
    prompt = harness.build_prompt(report, [report['groups'][0]], True)
    data = json.loads(prompt.split('GROUPS:\n', 1)[1])
    assert data['changed_symbols'] and data['files_to_review']
    assert 'Context truncated: True' in prompt and 'full body: read_context section=meta' in prompt
    assert 'big.ts' in prompt and 'meaningful topics' in prompt


def test_guide_synthesis_preserves_notes_and_shares_prior_observations(monkeypatch, tmp_path):
    from test_harness import _explain_report, _group_result
    monkeypatch.setattr(settings, 'REVIEW_BATCH_SYMBOLS', 1)
    report = _explain_report(); report['meta'].update(head='a' * 40, merge_base='b' * 40)
    report['architecture'] = {'layers': [{'id': 'l1', 'title': 'Behavior thread'}]}
    calls = []
    def run(*args, **kwargs):
        calls.append((args[3], copy.deepcopy(kwargs)))
        if 'Synthesize' in args[3]: return {'groups': [], 'topics': []}
        gid = 'g0' if '"group_id": "g0"' in args[3] else 'g1'
        result = _group_result(gid); result['risks'] = ['single-symbol risk']
        result['changes'][0]['review_notes'] = [f'concrete note {i}' for i in range(4)]
        return {'groups': [result], '__repository_sources': [{'source_id': 'R1', 'path': 'file.py', 'line': 1, 'end_line': 2}]}
    monkeypatch.setattr(harness, 'run_harness', run)
    result = harness.explain(report, 'claude', '', '', repository_root=tmp_path)
    assert len(result['groups'][0]['changes'][0]['review_notes']) == 4
    assert result['groups'][0]['risks'] == ['single-symbol risk']
    assert 'concrete note 3' in calls[-1][0]
    assert calls[1][1]['repository_context']['review_state']['groups'][0]['id'] == 'g0'
    assert calls[-1][1]['repository_context']['architecture'] == report['architecture']
    assert len(result['review_state']['sources']) == 2
    assert result['review_state']['correctness_coverage'] == 'not_measured'


def test_question_uses_base_and_full_context_without_symbol_evidence(monkeypatch, tmp_path):
    report = {'meta': {'title': 'T', 'head': 'a' * 40, 'merge_base': 'b' * 40}, 'files': [], 'groups': []}
    def run(*args, **kwargs):
        assert kwargs['repository_head'] == 'a' * 40 and kwargs['repository_base'] == 'b' * 40
        assert kwargs['repository_context'] == report
        return {'answer': 'Explanation', 'citations': []}
    monkeypatch.setattr(harness, 'run_harness', run)
    assert harness.answer_question(report, 'codex', '', '', 'Explain old behavior', repository_root=tmp_path)['answer'] == 'Explanation'


def test_provider_tools_context_and_stdin_match_for_both_clis(monkeypatch, tmp_path):
    monkeypatch.setattr(harness.shutil, 'which', lambda x: '/fake/' + x)
    monkeypatch.setattr(harness, '_codex_user_mcp_override', lambda: None)
    def run(args, **kwargs):
        assert kwargs['input'] == 'prompt' and args[-1] != 'prompt'
        if args[0].endswith('claude'):
            allowed = args[args.index('--allowedTools') + 1]
            assert all('__' + name in allowed for name in TOOL_NAMES)
            config = json.loads(Path(args[args.index('--mcp-config') + 1]).read_text())
            server = next(iter(config['mcpServers'].values())); server_args = server['args']
            context = json.loads(Path(server_args[server_args.index('--context') + 1]).read_text())
            assert context['meta']['body'] == 'complete body'
            assert args[args.index('--max-turns') + 1] == str(settings.REVIEW_MAX_TURNS)
        else:
            assert any('enabled_tools=' in a and 'search_source' in a and 'read_github' in a for a in args)
        return SimpleNamespace(returncode=0, stdout=json.dumps({'groups': []}), stderr='')
    monkeypatch.setattr(harness.subprocess, 'run', run)
    for provider in ('claude', 'codex'):
        harness.run_harness(provider, '', '', 'prompt', repository_root=tmp_path, repository_head='a' * 40,
                            repository_base='b' * 40, repository_context={'meta': {'body': 'complete body'}})


class Response:
    def __init__(self, data, link=''):
        self.raw = json.dumps(data).encode(); self.headers = {'Link': link}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return self.raw


def test_github_get_allowlist_pagination_auth_and_stable_observations(monkeypatch):
    from prism import github_context
    seen = []
    def open_request(request, **kwargs):
        seen.append(request)
        return Response({'body': 'x' * 30000 + 'END'}, '<https://api.github.com/next>; rel="next"')
    monkeypatch.setattr(github_context, 'github_token', lambda: 'private-test-token')
    monkeypatch.setattr(github_context.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=open_request))
    meta = {'owner': 'owner', 'repo': 'repo', 'number': 12, 'head': 'a' * 40}
    cache = {}; args = {'resource': 'pr', 'field': 'body'}
    first = read_github(meta, args, cache)
    last = read_github(meta, dict(args, offset=first['next_offset']), cache)
    assert first['text'] + last['text'] == 'x' * 30000 + 'END'
    assert len(seen) == 1 and first['retrieved_at'] == last['retrieved_at']
    assert seen[0].get_method() == 'GET' and seen[0].get_header('Authorization') == 'Bearer private-test-token'
    assert 'private-test-token' not in json.dumps(first)
    comments = read_github(meta, {'resource': 'comments', 'page': 2}, cache)
    assert 'per_page=100&page=2' in comments['url'] and comments['next_page'] == 3
    source = read_github(meta, {'resource': 'file', 'path': 'dir/some file.ts'}, cache)
    assert 'ref=' + 'a' * 40 in source['url'] and 'some%20file.ts' in source['url']
    with pytest.raises(GitHubReadError): read_github(meta, {'resource': 'file', 'owner': 'other', 'repo': 'repo', 'path': 'file.ts'})
    with pytest.raises(GitHubReadError): read_github(meta, {'resource': 'file', 'path': '../secret'})
    with pytest.raises(GitHubReadError): read_github(meta, {'resource': 'file', 'owner': 'evil.test/x', 'path': 'file.ts'})
    with pytest.raises(GitHubReadError): read_github(meta, {'resource': 'https://evil.test/'})


def test_github_redirect_never_forwards_credentials_to_other_authorities():
    request = urllib.request.Request('https://api.github.com/repos/o/r/actions/jobs/1/logs', headers={'Authorization': 'Bearer TOKEN'})
    redirect = _GitHubRedirect().redirect_request(request, None, 302, '', {}, 'https://logs.example.test/file')
    assert redirect.get_header('Authorization') is None
    with pytest.raises(GitHubReadError): _GitHubRedirect().redirect_request(request, None, 302, '', {}, 'http://localhost/file')


def test_cached_patch_upgrade_uses_git_without_model_or_graph(workspace, monkeypatch):
    from prism import app as api
    tools, root, base, head = workspace
    saved = []
    monkeypatch.setattr(api, 'save_report', lambda r: saved.append(copy.deepcopy(r)))
    report = {'meta': tools.context['meta'], 'files': [{'path': 'long.txt', 'patch': 'short', 'patch_truncated': True}],
              'ai': {'overview': 'saved guide'}}
    api.ensure_complete_diff(report, root)
    assert report['diff_version'] == 1 and report['ai']['overview'] == 'saved guide'
    assert any('TAIL' in f['patch'] for f in report['files'])
    assert all(f['patch_truncated'] is False for f in report['files'])
    assert len(saved) == 1


def test_question_endpoint_cannot_disable_repository_access(monkeypatch, tmp_path):
    from prism import app as api
    report = {'meta': {}, 'files': [], 'groups': [], 'evidence': {}, 'topics_version': 5, 'diff_version': 1}
    monkeypatch.setattr(api, 'read_report', lambda _: report)
    monkeypatch.setattr(api, 'head_worktree', lambda r: tmp_path)
    monkeypatch.setattr(api, '_job', lambda kind, work, **kw: work(lambda _: None))
    def answer(*args):
        assert args[-1] == tmp_path
        return {'answer': 'Repository available'}
    monkeypatch.setattr(api, 'answer_question', answer)
    request = api.QuestionRequest(harness='codex', question='Explain', include_repository_context=False)
    assert api.ask_question('id', request)['answer'] == 'Repository available'


def test_git_line_coordinates_ignore_unicode_separators_and_fake_headers(workspace):
    from prism.gitops import diff_files
    from prism.sourcefiles import git_lines
    tools, root, base, old_head = workspace
    content = 'one\ntwo\ftthree\u2028still two\r@@ -1 +99 @@\nfour\r\nfive\n'
    (root / 'separators.txt').write_bytes(content.encode())
    (root / 'fake.txt').write_text('first\fdiff --git a/not-a-file b/not-a-file\nlast\n')
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'separators')
    head = git(root, 'rev-parse', 'HEAD')
    reader = RepositoryTools(root, head, root / 'separators-audit.jsonl', base)
    hit = reader.search_source({'query': 'four'})['matches'][0]
    assert hit['line'] == 3
    read = reader.read_source({'path': 'separators.txt', 'start_line': 3, 'end_line': 3})
    assert read['code'].startswith('    3: four\r')
    assert read['total_lines'] == len(git_lines(content)) == 4
    assert reader.read_source({'path': 'old.py', 'revision': base})['side'] == 'base'
    files = diff_files(root, base, head)
    added = next(f for f in files if f['path'] == 'separators.txt')
    assert added['new_ranges'] == [[1, 4]]
    expected = subprocess.check_output(['git', '-C', str(root), 'diff', '--no-ext-diff', '--no-textconv', '--unified=0', base, head, '--', 'separators.txt']).decode()
    assert added['patch'] == expected
    assert any(f['path'] == 'fake.txt' for f in files)


def test_tree_listing_in_partial_clone_does_not_fetch_every_blob(workspace, tmp_path):
    tools, root, base, head = workspace
    git(root, 'config', 'uploadpack.allowFilter', 'true')
    clone = root.parent / (root.name + '-partial')
    subprocess.check_output(['git', 'clone', '--quiet', '--filter=blob:none', '--no-checkout', root.as_uri(), str(clone)])
    packs = set((clone / '.git/objects/pack').iterdir())
    reader = RepositoryTools(clone, head, root / 'partial-audit.jsonl', base)
    assert 'long.txt' in reader.list_files({})['files']
    assert set((clone / '.git/objects/pack').iterdir()) == packs
    assert 'OLD_ONLY' in reader.read_source({'path': 'old.py', 'revision': 'base'})['code']


def test_github_commit_pagination_and_explicit_job_ids(monkeypatch):
    from prism import github_context
    seen = []
    def open_request(request, **kwargs):
        seen.append(request.full_url)
        return Response({'files': ['page']}, '<https://api.github.com/next>; rel="next"')
    monkeypatch.setattr(github_context, 'github_token', lambda: None)
    monkeypatch.setattr(github_context.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=open_request))
    meta = {'owner': 'o', 'repo': 'r', 'number': 7, 'head': 'a' * 40}
    first = read_github(meta, {'resource': 'commit'})
    second = read_github(meta, {'resource': 'commit', 'page': first['next_page']})
    assert 'page=1' in seen[0] and 'page=2' in seen[1]
    for resource in ('workflow_jobs', 'check_annotations', 'job_log'):
        with pytest.raises(GitHubReadError): read_github(meta, {'resource': resource})


def test_tool_server_survives_bad_arguments_and_non_utf8_filenames(workspace, monkeypatch):
    import io
    import os
    from prism import repository_tools
    tools, root, base, head = workspace
    raw_path = os.fsencode(root) + b'/file-\xff.custom'
    with open(raw_path, 'wb') as stream: stream.write(b'exact bytes\n')
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'non-UTF-8 filename')
    head = git(root, 'rev-parse', 'HEAD')
    messages = [
        {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'list_files', 'arguments': ['bad']}},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'list_files', 'arguments': {'offset': float('inf')}}},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'list_files', 'arguments': {}}},
    ]
    output = io.StringIO()
    monkeypatch.setattr(repository_tools.sys, 'stdin', io.StringIO('\n'.join(json.dumps(m) for m in messages)))
    monkeypatch.setattr(repository_tools.sys, 'stdout', output)
    repository_tools.serve(root, head, root / 'mcp-audit.jsonl', base)
    replies = [json.loads(line) for line in output.getvalue().splitlines()]
    assert replies[0]['result']['isError'] and replies[1]['result']['isError']
    assert replies[2]['result']['isError'] is False
    filename = os.fsdecode(b'file-\xff.custom')
    assert filename in replies[2]['result']['structuredContent']['files']
    reader = RepositoryTools(root, head, root / 'mcp-source-audit.jsonl', base)
    assert reader.read_text({'path': filename})['text'] == 'exact bytes\n'


def test_old_patch_hydration_preserves_concurrently_saved_guide(workspace, monkeypatch):
    from prism import app as api
    tools, root, base, head = workspace
    monkeypatch.setattr(api.settings, 'DATA_DIR', root / 'cache')
    report = {'id': 'e' * 24, 'meta': tools.context['meta'], 'ai': {'overview': 'original'}}
    api.save_report(report)
    real_diff = api.diff_files
    def diff(*args):
        newer = api.read_report(report['id']); newer['ai'] = {'overview': 'concurrent guide'}; api.save_report(newer)
        return real_diff(*args)
    monkeypatch.setattr(api, 'diff_files', diff)
    api.ensure_complete_diff(report, root)
    assert api.read_report(report['id'])['ai']['overview'] == 'concurrent guide'


def test_missing_checkout_inline_question_returns_actionable_conflict(monkeypatch):
    from fastapi.testclient import TestClient
    from prism import app as api
    report = {'meta': {'head': 'a' * 40, 'merge_base': 'b' * 40}}
    monkeypatch.setattr(api, 'read_report', lambda _: report)
    def missing(_): raise RepositoryToolError('Cached checkout unavailable; reanalyze this PR.')
    monkeypatch.setattr(api, 'head_worktree', missing)
    response = TestClient(api.app).post('/api/reports/' + 'e' * 24 + '/questions', json={
        'harness': 'codex', 'question': 'Explain', 'anchor': {'path': 'a.py', 'old_lines': [1], 'new_lines': []}})
    assert response.status_code == 409 and 'reanalyze' in response.json()['detail']
