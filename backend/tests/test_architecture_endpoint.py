import time
from fastapi.testclient import TestClient
from prism import app as api
from prism.architecture import VERSION


def setup_report(monkeypatch,tmp_path):
    monkeypatch.setattr(api.settings,'DATA_DIR',tmp_path)
    monkeypatch.setattr(api,'head_worktree',lambda report:tmp_path)
    report={'id':'c'*24,'demo':False,'meta':{'head':'a'*40,'merge_base':'b'*40,'title':'Keep this title'},
            'files':[],'groups':[],'overview':{'nodes':[],'edges':[]},'evidence':{},'topics_version':5,
            'architecture':{'version':VERSION,'method':'source','nodes':[],'edges':[],'layers':[],'notes':[],'omitted_context':0}}
    api.save_report(report)
    return report


def wait(client,id):
    for _ in range(100):
        job=client.get('/api/jobs/'+id).json()
        if job['state'] in {'completed','failed'}:return job
        time.sleep(.01)
    raise AssertionError('Local mocked job did not finish')


def test_discovery_updates_map_without_invoking_prose_model(monkeypatch,tmp_path):
    r=setup_report(monkeypatch,tmp_path)
    def discovery(report,root,harness,model,effort,progress):
        assert (harness,model,effort)==('codex','default','high')
        return {**report['architecture'],'method':'semantic'}
    monkeypatch.setattr(api,'discover_architecture',discovery)
    client=TestClient(api.app)
    response=client.post('/api/reports/'+r['id']+'/architecture',json={'harness':'codex','model':'default','effort':'high'})
    assert response.status_code==202
    assert wait(client,response.json()['job_id'])['state']=='completed'
    saved=api.read_report(r['id'])
    assert saved['architecture']['method']=='semantic'
    assert saved['meta']['title']=='Keep this title'
    assert 'ai' not in saved


def test_invalid_discovery_preserves_previously_saved_map(monkeypatch,tmp_path):
    r=setup_report(monkeypatch,tmp_path)
    def failed(*args):raise ValueError('The architecture result omitted changed files.')
    monkeypatch.setattr(api,'discover_architecture',failed)
    client=TestClient(api.app)
    result=client.post('/api/reports/'+r['id']+'/architecture',json={'harness':'codex'}).json()
    job=wait(client,result['job_id'])
    assert job['state']=='failed' and 'omitted changed files' in job['error']
    assert api.read_report(r['id'])['architecture']==r['architecture']
