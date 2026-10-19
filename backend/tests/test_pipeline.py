import subprocess
from prism import app as api
from prism import graph


def git(path,*args):
    return subprocess.check_output(['git','-C',str(path),*args],text=True).strip()


def test_pipeline_caches_report_and_segments(monkeypatch,tmp_path):
    repo=tmp_path/'repo';repo.mkdir()
    git(repo,'init');git(repo,'config','user.email','a@example.com');git(repo,'config','user.name','A')
    code=repo/'sample.py';code.write_text('class Service:\n    def run(self):\n        return 1\n')
    git(repo,'add','.');git(repo,'commit','-m','base');base=git(repo,'rev-parse','HEAD')
    code.write_text('class Service:\n    def run(self):\n        return 2\n')
    git(repo,'add','.');git(repo,'commit','-m','head');head=git(repo,'rev-parse','HEAD')
    meta={'owner':'demo','repo':'repo','number':42,'title':'Change Service','body':'',
          'base':base,'head':head,'url':'https://github.com/demo/repo/pull/42'}
    monkeypatch.setattr(api,'pr_metadata',lambda *args:meta.copy())
    monkeypatch.setattr(api,'prepare_worktrees',lambda m:(repo,repo,repo,base))
    monkeypatch.setattr(api.settings,'DATA_DIR',tmp_path/'data')
    n={'id':'service','label':'Service','path':'sample.py','line':1,'kind':'class','status':'context'}
    def changed(root,path,ranges):
        return [{'name':'Service','qualified':'Service','path':path,'start':1,'end':3,'kind':'class','parent':None}]
    monkeypatch.setattr(graph,'changed_symbols',changed)
    monkeypatch.setattr(graph,'scan_symbols',lambda root,path:changed(root,path,[]))
    req=api.AnalyzeRequest(url='https://github.com/demo/repo/pull/42')
    rid=api.run_analysis(req,lambda _:None)
    result=api.read_report(rid)
    assert result['stats']['changed_files']==1
    assert result['stats']['changed_symbols']==1
    assert result['groups'][0]['changed_count']==1
    assert api.run_analysis(req,lambda _:None)==rid
