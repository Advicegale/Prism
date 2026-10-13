import json
import subprocess
import pytest
from prism.architecture_review import validate_discovery, discovery_prompt
from prism.architecture import committed_sources
from prism.repository_tools import RepositoryTools, RepositoryToolError


def report(*paths):
    return {'meta':{'title':'Change behavior','head':'a'*40,'merge_base':'b'*40},
            'files':[{'path':p,'old_path':p,'status':'modified','new_ranges':[[1,1]],'old_ranges':[[1,1]],'patch':''} for p in paths]}


def group(title,files,supporting=False,presentation='files'):
    return {'title':title,'focus':'','files':files,'supporting':supporting,'presentation':presentation}


@pytest.mark.parametrize('paths,titles',[
    (['Controller.java','Service.java','Repository.java'],['Request handling','Business rules','Persistence']),
    (['Main.tscn','Player.gd','Materials.tres'],['Scene composition','Player behavior','Shared resources']),
    (['Program.cs','Worker.cs','settings.toml'],['Entry point','Background work','Deployment configuration']),
])
def test_language_neutral_groups_and_cited_edges(paths,titles):
    source={p:f'// source of {p}\nreference to next file\n' for p in paths}
    sources={'head':source,'base':source}
    catalog={f'R{i+1}':{'path':p,'side':'head','line':1,'end_line':2} for i,p in enumerate(paths)}
    raw={'groups':[group(title,[p]) for title,p in zip(titles,paths)],'relationships':[
        {'source':paths[0],'target':paths[1],'label':'delegates to','reason':'Referenced implementation', 'fact_id':'',
         'citations':[{'source_id':'R1','line':2,'end_line':2},{'source_id':'R2','line':1,'end_line':2}]}], 'limitations':[]}
    result=validate_discovery(raw,report(paths[0],paths[2]),sources,catalog,{})
    assert [l['title'] for l in result['layers']]==titles
    assert len(result['nodes'])==3
    assert result['edges'][0]['confidence']=='LLM_INFERRED'
    assert result['edges'][0]['status']=='unclassified'
    assert result['edges'][0]['evidence'][0]['code']=='reference to next file'


def test_coverage_and_unread_context_cannot_be_fabricated():
    sources={'head':{'a.gd':'pass','b.gd':'pass'},'base':{}}
    with pytest.raises(ValueError,match='omitted'):
        validate_discovery({'groups':[group('One',['a.gd'])]},report('a.gd','b.gd'),sources,{}, {})
    with pytest.raises(ValueError,match='not inspected'):
        validate_discovery({'groups':[group('One',['a.gd','b.gd'])]},report('a.gd'),sources,{}, {})
    with pytest.raises(ValueError,match='more than one'):
        validate_discovery({'groups':[group('One',['a.gd']),group('Two',['a.gd'])]},report('a.gd'),sources,{}, {})


def test_bad_citations_are_discarded_and_known_facts_survive():
    source={'a.java':'a','b.java':'b'};sources={'head':source,'base':{}}
    fact={'source':'a.java','target':'b.java','relation':'imports','confidence':'RESOLVED','detail':'b','status':'unchanged','evidence':[]}
    raw={'groups':[group('Whatever',['a.java','b.java'])], 'relationships':[
        {'source':'a.java','target':'b.java','label':'calls','reason':'','fact_id':'',
         'citations':[{'source_id':'invented','line':1,'end_line':1}]},
        {'source':'a.java','target':'b.java','label':'imports','reason':'','fact_id':'unknown','citations':[]}], 'limitations':[]}
    result=validate_discovery(raw,report('a.java','b.java'),sources,{}, {'F1':fact})
    assert result['edges']==[fact]
    assert result['notes'][0].startswith('2 proposed relationships')


def test_prompt_does_not_supply_path_taxonomy():
    r=report('a.java')
    sources={'head':{'a.java':'class A {}'},'base':{'a.java':'class A {}'}}
    prompt,catalog,facts=discovery_prompt(r,sources,{'edges':[]})
    assert 'no mandatory categories' in prompt
    assert catalog['C1']['path']=='a.java'
    assert 'source_catalog' in prompt and not facts


def test_arbitrary_text_and_exact_base_are_available_to_tools(tmp_path):
    def git(*args):return subprocess.check_output(['git','-C',str(tmp_path),*args],text=True).strip()
    git('init');git('config','user.email','test@example.com');git('config','user.name','Test')
    (tmp_path/'Player.gd').write_text('extends Node\nvar speed = 1\n')
    (tmp_path/'project.godot').write_text('[application]\nname="Test"\n')
    (tmp_path/'unknown.customlang').write_text('source in an unknown language\n')
    (tmp_path/'picture.png').write_bytes(b'binary')
    git('add','.');git('commit','-m','base');base=git('rev-parse','HEAD')
    (tmp_path/'Player.gd').write_text('extends Node\nvar speed = 2\n')
    git('add','.');git('commit','-m','head');head=git('rev-parse','HEAD')
    (tmp_path/'Player.gd').write_text('local edit')
    tools=RepositoryTools(tmp_path,head,tmp_path/'audit.jsonl',base)
    assert 'unknown.customlang' in tools.list_files({})['files']
    assert 'picture.png' not in tools.list_files({})['files']
    assert not tools.list_symbols({'path':'Player.gd'})['symbols']
    read=tools.read_source({'path':'Player.gd','revision':'base','start_line':1,'end_line':2})
    assert 'speed = 1' in read['code'] and read['side']=='base'
    assert 'speed = 2' in tools.read_source({'path':'Player.gd','start_line':1,'end_line':2})['code']
    assert committed_sources(tmp_path,head)[0]['unknown.customlang']=='source in an unknown language\n'
    with pytest.raises(RepositoryToolError):tools.read_source({'path':'../outside','start_line':1,'end_line':1})
    assert json.loads((tmp_path/'audit.jsonl').read_text().splitlines()[0])['side']=='base'


def test_renamed_node_accepts_evidence_at_its_original_base_path():
    r=report('New.java','Other.java')
    r['files'][0].update(old_path='Old.java',status='renamed')
    sources={'head':{'New.java':'new','Other.java':'other'},'base':{'Old.java':'old','Other.java':'other'}}
    catalog={'R1':{'path':'Old.java','side':'base','line':1,'end_line':1},'R2':{'path':'Other.java','side':'base','line':1,'end_line':1}}
    raw={'groups':[group('Implementation',['New.java','Other.java'])], 'relationships':[
        {'source':'New.java','target':'Other.java','label':'previously referenced','reason':'Base reference', 'fact_id':'',
         'citations':[{'source_id':'R1','line':1,'end_line':1},{'source_id':'R2','line':1,'end_line':1}]}], 'limitations':[]}
    g=validate_discovery(raw,r,sources,catalog,{})
    assert g['edges'][0]['evidence'][0]['path']=='Old.java'
    assert g['edges'][0]['evidence'][0]['side']=='base'


def test_large_discovery_keeps_coverage_and_evidence_with_bounded_utf8_seeds():
    from prism.architecture_review import PROMPT_BYTE_BUDGET
    paths=[f'feature/{i}.customlang' for i in range(240)]
    r=report(*paths)
    for file in r['files']:
        file.update(patch='変更🙂'*1000,new_ranges=[[i,i+1] for i in range(1,2001)])
    source={p:('変更🙂'*60+'\n')*40 for p in paths}
    edges=[{'source':paths[i%240],'target':paths[(i+1)%240],
            'relation':f'reference {i}','status':'added','confidence':'SOURCE_MATCH',
            'detail':'large detail'*1000,
            'evidence':[{'path':paths[i%240],'line':1,'side':'head','code':'proof'*1000}]}
           for i in range(600)]
    prompt,catalog,facts=discovery_prompt(r,{'head':source,'base':source},{'edges':edges})
    payload=json.loads(prompt.split('\n',1)[1])
    assert len(prompt.encode('utf-8'))<=PROMPT_BYTE_BUDGET
    assert [f['path'] for f in payload['changed_files']]==paths
    assert len(facts)==600 and facts['F1']['evidence']==edges[0]['evidence']
    assert len(payload['extracted_relationships'])<600
    assert all('evidence' not in f for f in payload['extracted_relationships'])
    assert set(catalog)=={ref['source_id'] for ref in payload['source_catalog']}
    # Seeds omitted from the prompt still survive as full facts in the map.
    result=validate_discovery({'groups':[group('Feature',paths)],'relationships':[],
                               'limitations':[]},r,{'head':source,'base':source},catalog,facts)
    assert len(result['nodes'])==240 and len(result['edges'])==600
