"""Review preparation is restricted to diff paths; deep indexes require a request."""
from collections import OrderedDict
from fastapi.testclient import TestClient
from prism import app as api, graph, settings
from prism.exploration import service
from test_exploration_prefetch import pr_repo, URL


def test_review_never_extracts_full_graph_or_reads_unchanged_source(pr_repo, monkeypatch):
    # A large unchanged corpus must not affect declaration work or trigger a size limit.
    for i in range(100): (pr_repo/f'unchanged{i}.py').write_text('def unrelated():\n    return 1\n')
    monkeypatch.setattr(settings, 'MAX_FILES', 1)
    from graphify import extract as native
    def forbidden(*args, **kwargs): raise AssertionError('whole-repository extraction/indexing is forbidden before review')
    monkeypatch.setattr(native, 'collect_files', forbidden)
    monkeypatch.setattr(native, 'extract', forbidden)
    monkeypatch.setattr(service, 'index_job', forbidden)
    original = graph.scan_symbols
    paths = []
    def scan(root, path):
        paths.append(path)
        assert path == 'sample.py'
        return original(root, path)
    monkeypatch.setattr(graph, 'scan_symbols', scan)
    rid = api.run_analysis(api.AnalyzeRequest(url=URL), lambda _: None)
    report = api.read_report(rid)
    assert paths and set(paths) == {'sample.py'}
    assert report['structure']['scope'] == 'changed_files'
    assert report['structure']['relationships_complete'] is False
    assert report['architecture']['method'] == 'manifest'
    assert len(report['architecture']['nodes']) == len(report['files']) == 1
    assert report['groups'][0]['changed_ids'] and report['evidence']
    previous = report.copy()
    client = TestClient(api.app)
    for _ in range(3): assert client.get('/api/reports/'+rid).status_code == 200
    assert api.run_analysis(api.AnalyzeRequest(url=URL), lambda _: None) == rid
    assert api.read_report(rid)['groups'] == previous['groups']


def test_only_requested_exploration_side_is_queued_and_deduplicated(pr_repo, monkeypatch):
    rid = api.run_analysis(api.AnalyzeRequest(url=URL), lambda _: None)
    monkeypatch.setattr(service, 'head_worktree', lambda report: pr_repo)
    monkeypatch.setattr(service, 'builds', OrderedDict())
    queued = []
    monkeypatch.setattr(service.pool, 'submit', lambda work: queued.append(work))
    client = TestClient(api.app)
    assert client.get('/api/reports/'+rid).status_code == 200
    assert queued == []
    def resolve(side):
        response = client.post('/api/reports/'+rid+'/exploration/resolve',
                               json={'path': 'sample.py', 'side': side, 'line': 2, 'column': 9})
        assert response.status_code == 200
        assert response.json()['status'] == 'indexing'
    resolve('new')
    assert len(queued) == 1 and len(service.builds) == 1
    resolve('new')
    assert len(queued) == 1
    resolve('old')
    assert len(queued) == 2 and len(service.builds) == 2


def test_diff_only_anchors_cover_rename_deletion_binary_and_config(tmp_path):
    before=tmp_path/'old';after=tmp_path/'new';before.mkdir();after.mkdir()
    (before/'old.py').write_text('def run():\n    return 1\n')
    (after/'new.py').write_text('def run():\n    return 2\n')
    (before/'gone.py').write_text('def removed():\n    return 0\n')
    (after/'settings.json').write_text('{"enabled": true}')
    (after/'asset.bin').write_bytes(b'\0\xff')
    files=[{'path':'new.py','old_path':'old.py','status':'renamed','new_ranges':[[2,2]],'old_ranges':[[2,2]],'patch':''},
           {'path':'gone.py','old_path':'gone.py','status':'deleted','new_ranges':[],'old_ranges':[[1,2]],'patch':''},
           {'path':'settings.json','old_path':'settings.json','status':'added','new_ranges':[[1,1]],'old_ranges':[],'patch':''},
           {'path':'asset.bin','old_path':'asset.bin','status':'added','new_ranges':[],'old_ranges':[],'patch':''}]
    nodes,edges,changed,groups,overview=api._changed_structure(files,before,after,lambda _:None)
    assert {n['path'] for n in nodes} == {f['path'] for f in files}
    assert next(n for n in nodes if n['path']=='gone.py')['status']=='deleted'
    assert next(n for n in nodes if n['path']=='new.py')['status']=='modified'
    assert {p for g in groups for p in g['files']} == {f['path'] for f in files}
    assert len(changed)==4 and edges==[]


def test_old_mapping_migration_uses_diff_paths_and_archives_saved_guide(pr_repo,monkeypatch):
    rid=api.run_analysis(api.AnalyzeRequest(url=URL),lambda _:None)
    report=api.read_report(rid)
    report.update(symbol_mapping_version=1,ai={'overview':'Keep my previous paid guide'})
    api.save_report(report)
    from graphify import extract as native
    monkeypatch.setattr(native,'extract',lambda *a,**kw: (_ for _ in ()).throw(AssertionError('Graphify must stay lazy')))
    assert api.run_analysis(api.AnalyzeRequest(url=URL),lambda _:None)==rid
    saved=api.read_report(rid)
    assert saved['ai'] is None
    assert saved['previous_ai'][-1]['ai']['overview']=='Keep my previous paid guide'
    assert saved['structure']['scope']=='changed_files'


def test_opening_saved_semantic_map_does_not_hydrate_full_source(pr_repo,monkeypatch):
    rid=api.run_analysis(api.AnalyzeRequest(url=URL),lambda _:None)
    saved=api.read_report(rid)
    saved['architecture'].update(method='semantic',facts_version=0)
    saved['ai']={'overview':'Paid guide stays intact'}
    api.save_report(saved)
    monkeypatch.setattr(api,'head_worktree',lambda *a: (_ for _ in ()).throw(AssertionError('no whole source hydration')))
    response=TestClient(api.app).get('/api/reports/'+rid)
    assert response.status_code==200
    assert response.json()['architecture']==saved['architecture']
    assert response.json()['ai']==saved['ai']
