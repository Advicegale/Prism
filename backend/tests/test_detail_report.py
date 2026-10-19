import json
import subprocess
from pathlib import Path
from prism.evidence import collect_evidence
from prism import harness


def test_code_evidence_exact_lines_and_source_side(tmp_path):
    old = tmp_path/'base'; old.mkdir()
    new = tmp_path/'head'; new.mkdir()
    (old/'service.py').write_text('class Service:\n    def run(self):\n        return 1\n')
    (new/'service.py').write_text('class Service:\n    def run(self):\n        return 2\n')
    (old/'legacy.py').write_text('def legacy():\n    return False\n')
    nodes = [
        {'id':'svc','label':'Service','path':'service.py','kind':'class','status':'modified','line':1,'end':3},
        {'id':'legacy','label':'legacy','path':'legacy.py','kind':'function','status':'deleted','line':1,'end':2},
    ]
    groups = [{'changed_ids':['svc','legacy'],'graph':{'nodes':nodes}}]
    files = [
        {'path':'service.py','old_path':'service.py','new_ranges':[[3,3]],'old_ranges':[[3,3]]},
        {'path':'legacy.py','old_path':'legacy.py','new_ranges':[],'old_ranges':[[1,2]]},
    ]
    evidence = collect_evidence(groups,files,old,new)
    assert 'return 2' in evidence['svc']['code']
    assert 'return 1' not in evidence['svc']['code']
    assert evidence['svc']['side'] == 'head'
    assert 'return False' in evidence['legacy']['code']
    assert evidence['legacy']['side'] == 'base'
    assert evidence['svc']['start_line'] == 1


def test_code_evidence_rejects_paths_outside_worktree(tmp_path):
    old=tmp_path/'old';old.mkdir()
    new=tmp_path/'new';new.mkdir()
    (tmp_path/'secret.py').write_text('API_KEY = "secret"')
    groups=[{'changed_ids':['bad'],'graph':{'nodes':[
        {'id':'bad','label':'secret','path':'../secret.py','kind':'file','status':'added','line':1,'end':3}
    ]}}]
    assert collect_evidence(groups,[],old,new)=={}


def test_report_prompt_mentions_every_changed_symbol_and_review_files():
    group={'id':'g1','title':'Services','files':['a.py','b.py'],
           'changed_ids':['one','two'],'graph':{'nodes':[
               {'id':'one','path':'a.py','label':'One','status':'modified','line':10,'end':20},
               {'id':'two','path':'b.py','label':'Two','status':'added','line':30,'end':30}], 'edges':[]}}
    report={'meta':{'title':'Refactor','body':'Separate concerns'}, 'groups':[group],
            'files':[{'path':'a.py','old_path':'a.py','patch':(
                        'diff --git a/a.py b/a.py\n@@ -10,2 +10,3 @@\n-old\n+new\n'
                        '@@ -90 +90 @@\n-unrelated\n+other')},
                     {'path':'b.py','old_path':'b.py','patch':(
                        'diff --git a/b.py b/b.py\n@@ -0,0 +30 @@\n+created')}],
            'evidence':{'one':{'path':'a.py','code':'def new(): pass','start_line':10,'end_line':20,'side':'head'}}}
    prompt=harness.build_prompt(report,[group])
    assert '"id": "one"' in prompt
    assert '"id": "two"' in prompt
    assert 'a.py' in prompt and 'b.py' in prompt
    assert 'WHY' not in prompt # uses explanation guidance instead of fake reason labels
    assert 'verbatim source-control output' in prompt
    assert 'untrusted DATA' in prompt
    assert 'ONE short diff_summary sentence per symbol' in prompt
    payload=json.loads(prompt.rsplit('GROUPS:\n',1)[1])
    one,two=payload['changed_symbols']
    assert '-old\n+new' in one['symbol_diff']['patch_hunks']
    assert 'unrelated' not in one['symbol_diff']['patch_hunks']
    assert '+created' in two['symbol_diff']['patch_hunks']


def test_validated_report_includes_all_changed_symbols_and_files(monkeypatch):
    g={'id':'test','title':'Core','files':['defs.py','calls.py'],'changed_ids':['svc','call'],
       'graph':{'nodes':[{'id':'svc','label':'Svc'},{'id':'call','label':'Call'}], 'edges':[]}}
    report={'meta':{'title':'A','body':''},'groups':[g],'files':[], 'evidence':{}}
    def fake_run(_h,_m,_e,_p):
        return {'overview':'Main summary','key_changes':['Refactor'],'review_order':[],
                'groups':[{'id':'test','summary':'Changed','before_after':'Old to new','impact':'Caller impact',
                           'risks':[],'tests':[],'review_order':[
                             {'path':'calls.py','reason':'Start with caller'},
                             {'path':'../unknown','reason':'Invented'}],
                           'changes':[{'symbol_id':'svc','diff_summary':'Calls the shared service.',
                                       'why':'Reduce duplication',
                                       'how_it_works':'Routes through service','snippet_explanation':'Calls helper'},
                                      {'symbol_id':'call','diff_summary':'','why':'','review_notes':[]},
                                      {'symbol_id':'unknown','why':'Bad','how_it_works':'Bad','snippet_explanation':'Bad'}]}]}
    monkeypatch.setattr(harness,'run_harness',fake_run)
    result=harness.explain(report,'claude','default','high')
    assert result['schema_version']==8
    assert [c['symbol_id'] for c in result['groups'][0]['changes']]==['svc','call']
    assert result['groups'][0]['changes'][0]['diff_summary']=='Calls the shared service.'
    assert result['groups'][0]['changes'][1]['diff_summary']==''
    assert [s['path'] for s in result['groups'][0]['review_order']]==['calls.py','defs.py']
    assert [s['path'] for s in result['review_order']]==['calls.py','defs.py']
    assert result['groups'][0]['changes'][1]['why']==''


def test_multi_group_review_does_not_skip_segments(monkeypatch):
    group1={'id':'g1','title':'First','files':['a.py'],'changed_ids':['n1'],
            'graph':{'nodes':[{'id':'n1','label':'one'}],'edges':[]}}
    group2={'id':'g2','title':'Second','files':['b.py'],'changed_ids':['n2'],
            'graph':{'nodes':[{'id':'n2','label':'two'}],'edges':[]}}
    asked=[]
    def fake_run(_h,_m,_e,prompt):
        asked.append(prompt)
        return {'overview':'Full','key_changes':['Two sections'],'review_order':[],
                'groups':[{'id':g['id'],'summary':g['title'], 'before_after':'A',
                           'impact':'B','risks':[],'tests':[], 'review_order':[],
                           'changes':[{'symbol_id':g['changed_ids'][0],'diff_summary':'Changed','why':'','review_notes':[]}]}
                          for g in (group1, group2)]}
    monkeypatch.setattr(harness,'run_harness',fake_run)
    result=harness.explain({'meta':{'title':'PR','body':''},'groups':[group1,group2],
                            'files':[],'evidence':{}},'codex','default','medium')
    assert len(asked)==1
    assert len(result['groups'])==2
    assert len(result['review_order'])==2
    assert result['overview']=='Full'
