"""Background exploration prefetch: queues only, never raises, runs before AI steps."""
import json
import subprocess
import threading
from fastapi.testclient import TestClient
import pytest
from prism import app as api
from prism import graph
from prism import settings
from prism.architecture import VERSION as ARCHITECTURE_VERSION
from prism.exploration import service
from prism.repository_tools import RepositoryToolError

URL='https://github.com/demo/repo/pull/42'
FAILURES=[RepositoryToolError('missing revision'),OSError('worktree gone'),ValueError('bad sha'),
          subprocess.TimeoutExpired('git',1)]


def git(path,*args):
    return subprocess.check_output(['git','-C',str(path),*args],text=True).strip()


@pytest.fixture
def pr_repo(tmp_path,monkeypatch):
    repo=tmp_path/'repo';repo.mkdir()
    git(repo,'init');git(repo,'config','user.email','a@example.com');git(repo,'config','user.name','A')
    code=repo/'sample.py';code.write_text('class Service:\n    def run(self):\n        return 1\n')
    git(repo,'add','.');git(repo,'commit','-m','base');base=git(repo,'rev-parse','HEAD')
    code.write_text('class Service:\n    def run(self):\n        return 2\n')
    git(repo,'add','.');git(repo,'commit','-m','head');head=git(repo,'rev-parse','HEAD')
    meta={'owner':'demo','repo':'repo','number':42,'title':'Change Service','body':'',
          'base':base,'head':head,'url':URL}
    monkeypatch.setattr(api,'pr_metadata',lambda *args:meta.copy())
    monkeypatch.setattr(api,'prepare_worktrees',lambda m:(repo,repo,repo,base))
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path/'data')
    n={'id':'service','label':'Service','path':'sample.py','line':1,'kind':'class','status':'context'}
    monkeypatch.setattr(api,'snapshot',lambda *args:{'nodes':[n],'edges':[],'files_indexed':1})
    def changed(root,path,ranges):
        return [{'name':'Service','qualified':'Service','path':path,'start':1,'end':3,'kind':'class','parent':None}]
    monkeypatch.setattr(graph,'changed_symbols',changed)
    monkeypatch.setattr(graph,'scan_symbols',lambda root,path:changed(root,path,[]))
    return repo


def record_calls(monkeypatch):
    events=[]
    def prefetch(report):
        events.append(('prefetch',report['id']))
    def architecture(report,*args):
        events.append(('architecture',None))
        return report.get('architecture')
    def explain(report,*args,**kwargs):
        assert args[-1].is_dir()  # every AI analysis receives the prepared head checkout
        assert report['meta']['head'] and report['meta']['merge_base']
        assert api.read_report(report['id'])['files'] == report['files']
        events.append(('explain',None))
        return {'topics':[]}
    monkeypatch.setattr(service,'prefetch',prefetch)
    monkeypatch.setattr(api,'discover_architecture',architecture)
    monkeypatch.setattr(api,'explain',explain)
    return events


@pytest.mark.parametrize('error',FAILURES,ids=lambda e:type(e).__name__)
@pytest.mark.parametrize('failing',['new','old'])
def test_prefetch_attempts_new_then_old_and_survives_each_side_failure(monkeypatch,failing,error):
    calls=[]
    def index_job(report,side):
        calls.append(side)
        if side==failing: raise error
        return {'status':'indexing'}
    monkeypatch.setattr(service,'index_job',index_job)
    assert service.prefetch({'id':'a'*24}) is None
    assert calls==['new','old']


def test_prefetch_never_raises_when_both_sides_fail(monkeypatch):
    calls=[]
    def index_job(report,side):
        calls.append(side)
        raise RepositoryToolError('missing revision')
    monkeypatch.setattr(service,'index_job',index_job)
    assert service.prefetch({'id':'a'*24}) is None
    assert calls==['new','old']


def test_prefetch_without_retained_worktree_is_a_quiet_noop(tmp_path,monkeypatch):
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path)
    report={'id':'a'*24,'meta':{'owner':'o','repo':'r','head':'b'*40,'merge_base':'c'*40}}
    assert service.prefetch(report) is None


def test_run_analysis_prefetches_once_before_ai_for_new_report(pr_repo,monkeypatch):
    events=record_calls(monkeypatch)
    rid=api.run_analysis(api.AnalyzeRequest(url=URL,harness='claude'),lambda _:None)
    assert [name for name,_ in events]==['prefetch','explain','architecture']
    assert events[0]==('prefetch',rid)


def test_run_analysis_prefetches_once_before_ai_for_existing_report(pr_repo,monkeypatch):
    events=record_calls(monkeypatch)
    rid=api.run_analysis(api.AnalyzeRequest(url=URL),lambda _:None)
    assert [name for name,_ in events]==['prefetch']
    events.clear()
    assert api.run_analysis(api.AnalyzeRequest(url=URL,harness='claude'),lambda _:None)==rid
    assert [name for name,_ in events]==['prefetch','explain','architecture']
    assert events[0]==('prefetch',rid)


def write_report(tmp_path,report_id,demo):
    base={'meta':{'owner':'o','repo':'r','number':1,'head':'a'*40,'merge_base':'b'*40},
          'stats':{},'created_at':'2026-01-01T00:00:00+00:00','files':[],'groups':[],'overview':{},
          'topics':[],'topics_version':5,'evidence':{},'ai':None,'demo':demo,
          'architecture':{'version':ARCHITECTURE_VERSION,'nodes':[],'edges':[]}}
    reports=tmp_path/'reports';reports.mkdir(exist_ok=True)
    (reports/f'{report_id}.json').write_text(json.dumps({**base,'id':report_id}))


def test_get_report_prefetches_normal_report_and_not_demo(tmp_path,monkeypatch):
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path)
    calls=[]
    monkeypatch.setattr(service,'prefetch',lambda report:calls.append(report['id']))
    normal,demo='1'*24,'2'*24
    write_report(tmp_path,normal,demo=False);write_report(tmp_path,demo,demo=True)
    client=TestClient(api.app)
    assert client.get(f'/api/reports/{normal}').status_code==200
    assert calls==[normal]
    assert client.get(f'/api/reports/{demo}').status_code==200
    assert calls==[normal]


def test_get_report_survives_real_prefetch_without_worktree(tmp_path,monkeypatch):
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path)
    write_report(tmp_path,'3'*24,demo=False)
    response=TestClient(api.app).get('/api/reports/'+'3'*24)
    assert response.status_code==200 and response.json()['id']=='3'*24


def test_snapshot_holds_graphify_extraction_lock_during_extract(tmp_path,monkeypatch):
    from graphify import extract as graphify_extract
    from prism.exploration.graphify_adapter import extraction_lock
    root=tmp_path/'repo';root.mkdir()
    (root/'sample.py').write_text('x = 1\n')
    seen=[]
    def probe():
        got=extraction_lock.acquire(blocking=False)
        if got: extraction_lock.release()
        seen.append(got)
    def stub_extract(files,root):
        worker=threading.Thread(target=probe);worker.start();worker.join()
        return {'nodes':[],'edges':[]}
    monkeypatch.setattr(graphify_extract,'extract',stub_extract)
    graph.snapshot(root,tmp_path/'cache','a'*40)
    assert seen==[False]
    assert extraction_lock.acquire(blocking=False)
    extraction_lock.release()


def test_explain_rerun_resolves_report_checkout(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'DATA_DIR', tmp_path)
    rid = '4' * 24
    write_report(tmp_path, rid, demo=False)
    saved=api.read_report(rid);saved['diff_version']=1;api.save_report(saved)
    calls = []
    def root(report):
        calls.append(('root', report['id']))
        return tmp_path
    def explain(report, *args, **kwargs):
        assert args[-1] == tmp_path
        calls.append(('explain', report['id']))
        return {'topics': []}
    def job(kind, work):
        work(lambda _: None)
        return {'job_id': 'test'}
    monkeypatch.setattr(api, 'head_worktree', root)
    monkeypatch.setattr(api, 'explain', explain)
    monkeypatch.setattr(api, '_job', job)
    response = TestClient(api.app).post(f'/api/reports/{rid}/explain', json={'harness': 'codex'})
    assert response.status_code == 202
    assert calls == [('root', rid), ('explain', rid)]


def test_reanalysis_archives_guide_before_mapping_upgrade(pr_repo):
    req=api.AnalyzeRequest(url=URL)
    rid = api.run_analysis(req, lambda _: None)
    report = api.read_report(rid)
    report['ai'] = {'overview': 'saved paid guide', 'topics': report['topics']}
    report['symbol_mapping_version'] = 1
    api.save_report(report)
    assert api.run_analysis(req, lambda _: None) == rid
    migrated = api.read_report(rid)
    assert migrated['symbol_mapping_version'] == 2
    assert migrated['ai'] is None
    assert migrated['previous_ai'][-1]['ai']['overview'] == 'saved paid guide'


def test_fresh_report_published_before_any_model(pr_repo, monkeypatch):
    events = record_calls(monkeypatch)
    def progress(message): pass
    def ready(report_id):
        assert api.read_report(report_id)['files']
        assert all(name not in ('explain', 'architecture') for name, _ in events)
        events.append(('ready', report_id))
    progress.report_ready = ready
    report_id = api.run_analysis(api.AnalyzeRequest(url=URL, harness='codex'), progress)
    assert [name for name, _ in events] == ['prefetch', 'ready', 'explain', 'architecture']
    assert events[1][1] == report_id
