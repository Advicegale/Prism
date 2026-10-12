from pathlib import Path
from prism import graph


def sym(path,name,start,end,kind='class'):
    return {'path':path,'name':name,'qualified':name,'kind':kind,'start':start,'end':end,'parent':None}


def test_added_symbol_and_class_relations(monkeypatch,tmp_path):
    def scanner(root,path):
        if root.name=='new':
            return [sym(path,'AuthService',2,15),sym(path,'TokenValidator',17,30)]
        return [sym(path,'AuthService',2,14)]
    monkeypatch.setattr(graph,'scan_symbols',scanner)
    monkeypatch.setattr(graph,'changed_symbols',lambda root,path,ranges:
                        [scanner(root,path)[1]] if root.name=='new' else [])
    (tmp_path/'new').mkdir();(tmp_path/'old').mkdir()
    nodeA={'id':'a','label':'AuthService','path':'auth.py','line':2,'kind':'class','status':'context'}
    nodeB={'id':'b','label':'TokenValidator','path':'auth.py','line':17,'kind':'class','status':'context'}
    old={'nodes':[nodeA],'edges':[]}
    new={'nodes':[nodeA,nodeB],'edges':[{'source':'a','target':'b','relation':'calls','confidence':'EXTRACTED'}]}
    files=[{'path':'auth.py','old_path':'auth.py','status':'modified','new_ranges':[[17,30]],'old_ranges':[]}]
    nodes,edges,ids=graph.identify_changes(files,tmp_path/'old',tmp_path/'new',old,new)
    assert 'b' in ids
    assert next(n for n in nodes if n['id']=='b')['status']=='added'
    assert edges[0]['status']=='added'
    groups,overall=graph.segment(nodes,edges,ids,files)
    assert len(groups)==1
    assert overall['nodes']


def test_deletion_inside_surviving_class_is_not_deleted(monkeypatch,tmp_path):
    (tmp_path/'old').mkdir();(tmp_path/'new').mkdir()
    monkeypatch.setattr(graph,'scan_symbols',lambda root,path:[sym(path,'AuthService',1,12)])
    monkeypatch.setattr(graph,'changed_symbols',lambda root,path,ranges:
                        [sym(path,'AuthService',1,12)] if root.name=='old' else [])
    node={'id':'a','label':'AuthService','path':'auth.py','line':1,'kind':'class','status':'context'}
    f=[{'path':'auth.py','old_path':'auth.py','status':'modified','new_ranges':[], 'old_ranges':[[4,4]]}]
    nodes,edges,ids=graph.identify_changes(f,tmp_path/'old',tmp_path/'new',{'nodes':[node],'edges':[]},{'nodes':[node],'edges':[]})
    assert ids==['a']
    assert next(n for n in nodes if n['id']=='a')['status']=='modified'


def test_removed_edge_remains_visible(monkeypatch,tmp_path):
    for dirname in ('old','new'):(tmp_path/dirname).mkdir()
    monkeypatch.setattr(graph,'scan_symbols',lambda *_:[])
    monkeypatch.setattr(graph,'changed_symbols',lambda *_:[])
    a={'id':'a','label':'A','path':'a.py','line':1,'kind':'class','status':'context'}
    b={'id':'b','label':'B','path':'b.py','line':1,'kind':'class','status':'context'}
    f=[{'path':'a.py','old_path':'a.py','status':'modified','new_ranges':[[5,5]],'old_ranges':[[5,5]]}]
    nodes,edges,ids=graph.identify_changes(f,tmp_path/'old',tmp_path/'new',
          {'nodes':[a,b],'edges':[{'source':'a','target':'b','relation':'calls','confidence':'EXTRACTED'}]},
          {'nodes':[a],'edges':[]})
    assert any(e['status']=='removed' for e in edges)
    assert 'b' in {n['id'] for n in nodes}


def test_clusters_separate_unconnected_files():
    nodes=[{'id':'a','label':'A','path':'one.py','line':1,'kind':'class','status':'modified'},
           {'id':'b','label':'B','path':'two.py','line':1,'kind':'class','status':'modified'}]
    groups,_=graph.segment(nodes,[],['a','b'],[])
    assert len(groups)==2
