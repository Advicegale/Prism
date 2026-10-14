"""Behavioral tests select source positions, never seeded production IDs."""
import json
import subprocess
import time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from prism.exploration.analyzer import analyze
from prism.exploration.model import Facts, Ref
from prism.exploration.query import Index, Query
from prism.exploration import service
from prism import settings
from prism.app import app

SHA='a'*40


def select(index,path,name,nth=0):
    text=index.facts.sources[path]; offset=-1
    for _ in range(nth+1): offset=text.index(name,offset+1)
    prefix=text[:offset]; line=prefix.count('\n')+1
    column=len(prefix.rsplit('\n',1)[-1].encode('utf-16-le'))//2
    return index.select(path,line,column)


def complete(index,root,changed=None,changed_only=False,direction='consumers'):
    query=Query(index,root,direction,changed_only,set(changed or index.facts.sources),'new')
    result=query.expand(initial=True)
    for _ in range(30):
        if not result['has_more']: return result
        result=query.expand()
    pytest.fail('Cycle did not terminate')


def sources_for(ext):
    if ext=='py':
        return {
          'prefs.py':'settings = {"network": {"attempts": 3}, "logging": {"level": "info"}}\n',
          'bridge.py':'from prefs import settings as options\nchannel = assemble(options["network"])\nbackup = assemble(options["network"])\nlogger = assemble(options["logging"])\nrevision = 1\n',
          'policy.py':'from prefs import settings\npolicy = assemble(settings["network"])\n',
          'shell.py':'from bridge import channel as wire\nfrom policy import policy as rules\nservice = {"wire": wire, "rules": rules}\n',
          'work.py':'from bridge import channel\nresponse = channel.send(order)\ndef send_order(order):\n    channel.send(order)\n',
          'responses.py':'from work import response, send_order\nresult = {"response": response, "action": send_order}\n',
          'logging.py':'from bridge import logger, revision\nnoise = {"logger": logger, "revision": revision}\n',
        }
    if ext=='java':
        return {
          'Prefs.java':'package sample;\npublic class Prefs { public static final Network network = new Network(3); public static final Logging logging = new Logging(); }\nclass Network { public final int attempts; public Network(int amount) { this.attempts = amount; } }\nclass Logging { public int level; }\n',
          'Bridge.java':'package sample;\nimport sample.Prefs;\npublic class Bridge { public static Object channel = Factory.assemble(Prefs.network); public static Object backup = Factory.assemble(Prefs.network); public static Object logger = Factory.assemble(Prefs.logging); }\n',
          'Policy.java':'package sample;\nimport sample.Prefs;\npublic class Policy { public static Object policy = Factory.assemble(Prefs.network); }\n',
          'Shell.java':'package sample;\nimport static sample.Bridge.channel;\nimport static sample.Policy.policy;\npublic class Shell { public Object wire = channel; public Object rules = policy; }\n',
          'Work.java':'package sample;\nimport static sample.Bridge.channel;\npublic class Work { public Object response = channel.send(order); public void sendOrder(Object order) { channel.send(order); } }\n',
          'Responses.java':'package sample;\nimport static sample.Work.response;\npublic class Responses { public Object result = response; }\n',
          'LoggingUse.java':'package sample;\nimport static sample.Bridge.logger;\npublic class LoggingUse { public Object noise = logger; }\n',
        }
    return {f'{path}.{ext}':text for path,text in {
      'prefs':'export const settings = { network: { attempts: 3 }, logging: { level: "info" } };\n',
      'bridge':'import { settings as options } from "./prefs";\nexport const channel = assemble(options.network);\nexport const backup = assemble(options.network);\nexport const logger = assemble(options.logging);\nexport const revision = 1;\n',
      'policy':'import { settings } from "./prefs";\nexport const policy = assemble(settings.network);\n',
      'shell':'import { channel as wire } from "./bridge";\nimport { policy as rules } from "./policy";\nexport const service = { wire, rules };\n'+('export const panel = <Panel client={wire}>literal text</Panel>;\n' if ext=='tsx' else ''),
      'work':'import { channel } from "./bridge";\nexport const response = channel.send(order);\nexport function sendOrder(order) { channel.send(order); }\n',
      'responses':'import { response, sendOrder } from "./work";\nexport const result = { response, sendOrder };\n',
      'logging':'import { logger, revision } from "./bridge";\nexport const noise = { logger, revision };\n',
    }.items()}


@pytest.mark.parametrize('ext',['js','ts','tsx','py','java'])
def test_field_construction_import_wrapping_and_exclusions(ext):
    sources=sources_for(ext); index=Index(analyze(sources,SHA))
    root_file='Prefs.java' if ext=='java' else 'prefs.'+ext
    # Java named value field plus nested declared instance field, not type-only recognition.
    name='network' if ext=='java' else 'attempts'
    chosen=select(index,root_file,name); assert chosen['status']=='resolved'
    result=complete(index,chosen['root'])
    paths={n['path'] for n in result['nodes']}
    assert {'Bridge.java','Policy.java','Shell.java','Work.java'}<=paths if ext=='java' else {f'{n}.{ext}' for n in ['bridge','policy','shell','work']}<=paths
    assert ('Responses.java' if ext=='java' else 'responses.'+ext) not in paths
    assert ('LoggingUse.java' if ext=='java' else 'logging.'+ext) not in paths
    symbols=[s['name'] for n in result['nodes'] for s in n['symbols']]
    assert not any('logger' in s or 'revision' in s for s in symbols)
    assert any(b['kind']=='usage' for b in result['boundaries'])
    bridge='Bridge.java' if ext=='java' else 'bridge.'+ext
    alias=select(index,bridge,'network',0)
    assert alias['status']=='resolved'
    # Selecting the same field at any alias occurrence preserves global identity.
    if ext!='java':
        direct=select(index,root_file,'network'); assert alias['root']['id']==direct['root']['id']
    else: assert alias['root']['id']==chosen['root']['id']
    if ext=='py': assert select(index,bridge,'settings',0)['root']['name']=='settings'
    sibling=select(index,bridge,'channel',0); scoped=complete(index,sibling['root'])
    assert not any('backup' in s['name'] for n in scoped['nodes'] for s in n['symbols'])
    origins=complete(index,sibling['root'],direction='origins')
    assert root_file in {n['path'] for n in origins['nodes']}
    assert not any('backup' in s['name'] for n in origins['nodes'] for s in n['symbols'])


@pytest.mark.parametrize('ext',['js','ts','tsx','py','java'])
def test_changed_bridge_merging_and_stopping_states(ext):
    index=Index(analyze(sources_for(ext),SHA)); first='Prefs.java' if ext=='java' else 'prefs.'+ext
    last='Shell.java' if ext=='java' else 'shell.'+ext
    root=select(index,first,'network' if ext=='java' else 'attempts')['root']
    query=Query(index,root,'consumers',True,{first,last},'new')
    initial=query.expand(initial=True)
    assert [n['path'] for n in initial['nodes']]==[first] and initial['has_more']
    result=query.expand()
    assert last in {n['path'] for n in result['nodes']}
    assert len([n for n in result['nodes'] if n['path']==last])==1
    incoming=[e for e in result['connections'] if e['target']==last]
    assert len(incoming)>=2 and all(e['indirect'] and e['hidden_paths'] for e in incoming)
    assert any('Bridge.java' in e['hidden_paths'] if ext=='java' else 'bridge.'+ext in e['hidden_paths'] for e in incoming)
    result=complete(index,root,{first,last},True)
    assert result['status']=='no_further_changed_files'
    empty=complete(index,root,{first},True); assert empty['status']=='no_further_changed_files'
    assert len(empty['nodes'])==1
    all_files=complete(index,root); assert all_files['status']=='no_further_eligible_connections'


@pytest.mark.parametrize('ext',['js','ts','tsx','py','java'])
def test_ordinary_roots_and_shadowing(ext):
    src={
      'py':'count = 1\ndef compute(argument):\n    count = argument\n    return count\nclass Gadget:\n    def move(self, distance):\n        self.position = distance\n',
      'java':'class Gadget { int count; void compute(int argument) { int count = argument; } void move(int distance) { this.count = distance; } }\n',
      'js':'const count = 1; function compute(argument) { let count = argument; return count; } class Gadget { position = 1; move(distance) { this.position = distance; } }\n',
      'ts':'type Size = number; const count = 1; function compute(argument: Size) { let count = argument; return count; } class Gadget { position = 1; move(distance: Size) { this.position = distance; } }\n',
      'tsx':'const count = 1; function compute(argument: number) { let count = argument; return <span>{count}</span>; } class Gadget { position = 1; move(distance: number) { this.position = distance; } }\n',
    }[ext]
    if ext in {'js','ts','tsx'}: src+='const gadget = new Gadget(); compute(count); gadget.move(count); gadget.position;\n'
    elif ext=='py': src+='callback = compute\n'
    path='roots.'+ext; index=Index(analyze({path:src},SHA))
    for name in ['count','compute','argument','Gadget','move','distance','position' if ext!='java' else 'count']:
        assert select(index,path,name)['status']=='resolved',name
    outer=select(index,path,'count',0); inner=select(index,path,'count',1)
    # Local count's alias to its parameter remains distinct from module/class count.
    assert outer['root']['id']!=inner['root']['id']
    if ext in {'js','ts','tsx'}:
        assert select(index,path,'compute',1)['root']['id']==select(index,path,'compute',0)['root']['id']
        assert select(index,path,'move',1)['root']['id']==select(index,path,'move',0)['root']['id']
        assert select(index,path,'position',2)['status']=='resolved'
    assert select(index,path,'class')['status']=='ignored'
    if ext!='java': assert select(index,path,'1')['status']=='ignored'


def test_alias_namespace_default_reexports_destructuring_field_isolation_and_cycle():
    src={
      'tsconfig.json':'{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}',
      'lib/preferences.ts':'const settings = { net: { tries: 2 }, log: { level: 3 } }; export default settings; export { settings };',
      'barrel.ts':'export { settings as prefs } from "@lib/preferences";',
      'relay.ts':'import * as bundle from "./barrel"; import direct from "./lib/preferences"; const { net: selected } = direct; export const channel = build(bundle.prefs.net); export const fallback = build(selected); export const logger = build(direct.log);',
      'screen.ts':'import { channel } from "./relay"; export const service = { channel };',
      'logger.ts':'import { logger } from "./relay"; export const noise = { logger };',
    }
    i=Index(analyze(src,SHA));r=select(i,'lib/preferences.ts','tries'); result=complete(i,r['root'])
    assert 'screen.ts' in {n['path'] for n in result['nodes']}
    assert 'logger.ts' not in {n['path'] for n in result['nodes']}
    assert select(i,'relay.ts','selected',0)['root']['name']=='settings.net'
    assert select(i,'relay.ts','net',1)['root']['name']=='settings.net'
    # Full serialization round trip retains exact roots/evidence.
    restored=Index(Facts.restore(json.loads(json.dumps(i.facts.dump()))))
    assert select(restored,'lib/preferences.ts','tries')==r


def test_dynamic_fields_returns_spreads_and_receiver_results_are_explicit_boundaries():
    src={'a.ts':'export const options = { net: { tries: 2 } }; const key = "net"; export const bad = make(options[key]); export const spread = {...options}; export function returning() { return {options}; }',
         'b.ts':'import {bad, spread, returning} from "./a"; export const out = {bad, spread, returning};'}
    i=Index(analyze(src,SHA));result=complete(i,select(i,'a.ts','tries')['root'])
    assert 'b.ts' not in {n['path'] for n in result['nodes']}
    assert any(b['kind']=='unresolved' and 'Computed' in b['reason'] for b in result['boundaries'])
    assert any(b['kind']=='unsupported' and 'pread' in b['reason'] for b in result['boundaries'])
    assert any(b['kind']=='unsupported' and 'Returned-object' in b['reason'] for b in result['boundaries'])


def test_unicode_crlf_comments_strings_tsx_text_and_budget():
    path='unicode.tsx'; text='// comment名字\r\nconst emoji = "😀";\tconst café = { amount: 3 };\r\nconst node = <Thing value={café.amount}>plain text</Thing>;\r\n'
    i=Index(analyze({path:text},SHA))
    assert select(i,path,'café',1)['status']=='resolved'
    assert select(i,path,'amount',1)['root']['name']=='café.amount'
    for ignored in ['comment名字','😀','plain text','const','3']:
        assert select(i,path,ignored)['status']=='ignored'
    root=select(i,path,'amount')['root'];q=Query(i,root,'consumers',False,{path},'new')
    result=q.expand(budget=0);assert result['status']=='partial' and result['has_more']
    defaults=Index(analyze({'a.ts':'export default { field: 4 }; export const named=2;',
                            'b.ts':'export * from "./a";'},SHA))
    for path,name in [('a.ts','4'),('a.ts','default'),('b.ts','export'),('b.ts','*')]:
        assert select(defaults,path,name)['status']=='ignored'


def git(root,*args):
    return subprocess.run(['git','-C',str(root),*args],check=True,capture_output=True,text=True).stdout.strip()


@pytest.fixture
def report_repo(tmp_path,monkeypatch):
    import hashlib
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path)
    key=hashlib.sha256(b'local/fixture').hexdigest()[:20]
    repo=tmp_path/'repos'/key/'repo';repo.mkdir(parents=True)
    git(repo,'init');git(repo,'config','user.email','fixture@example.invalid');git(repo,'config','user.name','Fixture')
    (repo/'before.ts').write_text('export const options = { retryOld: 3 };\n')
    git(repo,'add','.');git(repo,'commit','-m','before');old=git(repo,'rev-parse','HEAD')
    git(repo,'mv','before.ts','after.ts');(repo/'after.ts').write_text('export const options = { retryNew: 4 };\n')
    git(repo,'add','.');git(repo,'commit','-m','after');new=git(repo,'rev-parse','HEAD')
    worktree=repo.parent/'worktrees'/new;worktree.parent.mkdir();git(repo,'worktree','add',str(worktree),new)
    report={'id':'c'*24,'meta':{'owner':'local','repo':'fixture','head':new,'merge_base':old},
            'files':[{'path':'after.ts','old_path':'before.ts','status':'renamed'}]}
    reports=tmp_path/'reports';reports.mkdir();(reports/(report['id']+'.json')).write_text(json.dumps(report))
    with service.lock: service.builds.clear();service.queries.clear()
    return report,repo,worktree


def await_ready(report,side):
    job=service.index_job(report,side)
    deadline=time.monotonic()+10
    while job['status']=='indexing' and time.monotonic()<deadline: time.sleep(.01)
    assert job['status']=='ready',job
    return job


def test_api_revision_paths_exact_snippets_dedup_cache_and_validation(report_repo):
    report,repo,worktree=report_repo;client=TestClient(app);rid=report['id']
    old=await_ready(report,'old');new=await_ready(report,'new')
    assert service.index_job(report,'old') is old
    for side,name,sha in [('old','retryOld',report['meta']['merge_base']),('new','retryNew',report['meta']['head'])]:
        response=client.post(f'/api/reports/{rid}/exploration/resolve',json={'path':'after.ts','side':side,'line':1,'column':25})
        assert response.status_code==200,response.text
        data=response.json();assert data['status']=='resolved' and data['revision']==sha
        assert data['root']['name']=='options.'+name
        anchor=data['root']['definition'];source=client.get(f'/api/reports/{rid}/exploration/source',params={'path':anchor['path'],'side':side,'line':1}).json()
        assert source['revision']==sha and name in source['code']
        assert 'line clipped' not in source['code']
        expand={'side':side,'root_id':data['root']['id'],'direction':'origins','changed_only':False}
        assert client.post(f'/api/reports/{rid}/exploration/expand',json=expand).status_code==200
        assert client.post(f'/api/reports/{rid}/exploration/expand',json={**expand,'query_id':data['projection']['query_id']}).status_code==422
    assert client.post(f'/api/reports/{rid}/exploration/resolve',json={'path':'../x','side':'new','line':1,'column':0}).status_code==422
    assert client.post(f'/api/reports/{rid}/exploration/resolve',json={'path':'after.ts','side':'new','line':1,'column':35}).json()['status']=='ignored'
    # Mutable worktree edits never affect revision source.
    (worktree/'after.ts').write_text('bad mutable source')
    assert 'retryNew' in service.source(report,'after.ts','new',1)['code']
    with service.lock: service.builds.clear()
    assert await_ready(report,'new')['cache_hit'] is True


def test_missing_revision_and_partial_inventory_are_truthful(report_repo,monkeypatch):
    report,repo,_=report_repo
    missing={**report,'meta':{**report['meta'],'merge_base':'d'*40}}
    with pytest.raises(Exception,match='not retained'): service.index_job(missing,'old')
    monkeypatch.setattr(settings,'MAX_FILES',0)
    job=await_ready(report,'new');assert job['index'].facts.coverage['complete'] is False
    assert job['index'].facts.coverage['omitted']


def test_cycles_unknown_fields_and_ambiguous_barrels_do_not_invent_transfers():
    src={'a.ts':'export const config={net:{tries:2}}; export const duplicate=1;',
         'b.ts':'export const duplicate=2;',
         'barrel.ts':'export * from "./a"; export * from "./b";',
         'out.ts':'import {config} from "./a"; import {duplicate} from "./barrel"; let alias; alias=config; export const good={alias}; export const bad=make(config.missing);',
         'bad.ts':'import {bad} from "./out"; export const leak={bad};'}
    i=Index(analyze(src,SHA));r=select(i,'a.ts','tries');p=complete(i,r['root'])
    assert 'bad.ts' not in {n['path'] for n in p['nodes']}
    assert any(b['kind']=='unresolved' and 'ownership' in b['reason'] for b in p['boundaries'])
    assert select(i,'out.ts','duplicate')['status']=='unresolved'
    # A semantic cycle links an existing file; it must not unfold forever.
    i=Index(analyze({'cycle.ts':'export let loop; export const node={loop}; loop=node;'},SHA))
    cyclic=complete(i,select(i,'cycle.ts','node')['root'])
    assert len(cyclic['nodes'])==len({n['path'] for n in cyclic['nodes']})
    assert any(b['kind']=='cycle' for b in cyclic['boundaries'])


def test_java_instance_field_context_and_python_relative_namespace_bindings():
    java={'Prefs.java':'package example; public class Prefs { public static final Network network=new Network(3); public static final Log logging=new Log(); } class Network { int attempts; Network(int value) { this.attempts=value; } } class Log { int level; }',
          'Bridge.java':'package example; import example.Prefs; public class Bridge { public static Object channel=Factory.build(Prefs.network); public static Object logger=Factory.build(Prefs.logging); public int inspect() { return Prefs.network.attempts; } }',
          'Shell.java':'package example; import static example.Bridge.channel; public class Shell { Object service=channel; }'}
    i=Index(analyze(java,SHA));r=select(i,'Bridge.java','attempts');assert r['status']=='resolved'
    p=complete(i,r['root']);assert 'Shell.java' in {n['path'] for n in p['nodes']}
    assert not any('logger' in s['name'] for n in p['nodes'] for s in n['symbols'])
    field=select(i,'Prefs.java','attempts');assert field['status']=='resolved'
    assert 'Shell.java' in {n['path'] for n in complete(i,field['root'])['nodes']}
    py={'pkg/__init__.py':'','pkg/prefs.py':'options={"net":{"tries":2}}\n',
        'pkg/bridge.py':'from . import prefs as source\nchannel=assemble(source.options["net"])\n',
        'pkg/shell.py':'from .bridge import channel as wire\nservice={"wire":wire}\n'}
    i=Index(analyze(py,SHA));r=select(i,'pkg/prefs.py','tries')
    assert 'pkg/shell.py' in {n['path'] for n in complete(i,r['root'])['nodes']}


def test_pending_resolution_cannot_race_into_ready_without_root(report_repo,monkeypatch):
    report,_,_=report_repo
    job={'status':'indexing','message':'Working','revision':report['meta']['head'],'id':'job','index':None}
    monkeypatch.setattr(service,'index_job',lambda *_:job)
    original=service.job_response
    def race(data):
        data['status']='ready'
        return original(data)
    monkeypatch.setattr(service,'job_response',race)
    data=service.resolve_symbol(report,'after.ts','new',1,25)
    assert data['status']=='indexing'
    # A quoted key's delimiters are punctuation even during a cold build.
    from types import SimpleNamespace
    original_run=service.subprocess.run
    raw=b'export const options={"network":3};\n'
    def quoted_source(args,**kwargs):
        if 'show' in args:return SimpleNamespace(returncode=0,stdout=raw)
        return original_run(args,**kwargs)
    monkeypatch.setattr(service.subprocess,'run',quoted_source)
    job['status']='indexing'
    assert service.resolve_symbol(report,'after.ts','new',1,raw.index(b'"'))['status']=='ignored'


@pytest.mark.parametrize('ext',['ts','py','java'])
def test_external_factories_accept_explicit_inputs_without_implementation(ext):
    if ext=='ts':src={'a.ts':'import { assemble } from "external-library"; export const options={net:{tries:2}}; export const channel=assemble(options.net);',
                     'b.ts':'import {channel} from "./a"; export const service={channel};'}
    elif ext=='py':src={'a.py':'from external_library import assemble\noptions={"net":{"tries":2}}\nchannel=assemble(options["net"])\n',
                       'b.py':'from a import channel\nservice={"channel":channel}\n'}
    else:src={'A.java':'package example; import external.Factory; public class A { public static Object options=new Object(); public static Object channel=Factory.assemble(options); }',
              'B.java':'package example; import static example.A.channel; public class B { Object service=channel; }'}
    i=Index(analyze(src,SHA));first=next(iter(src));r=select(i,first,'tries' if ext!='java' else 'options');p=complete(i,r['root'])
    assert list(src)[1] in {n['path'] for n in p['nodes']}


def test_local_alias_of_external_input_and_unresolved_origins_keep_truthful_definitions():
    src={'inputs.ts':'import { external } from "unavailable-library"; export const copied=external; const config={known:2}; const key="known"; export const uncertain=build(config[key]); export const response=copied.send(order);'}
    i=Index(analyze(src,SHA))
    copied=select(i,'inputs.ts','copied')
    assert copied['status']=='resolved' and copied['root']['name']=='copied'
    assert copied['root']['definition']==copied['occurrence']
    external=select(i,'inputs.ts','external')
    assert external['status']=='unresolved'
    origins=complete(i,copied['root'],direction='origins')
    assert any(b['kind']=='unresolved' and 'Import' in b['reason'] for b in origins['boundaries'])
    uncertain=select(i,'inputs.ts','uncertain');assert uncertain['status']=='resolved'
    origins=complete(i,uncertain['root'],direction='origins')
    assert any(b['kind']=='unresolved' and 'Computed' in b['reason'] for b in origins['boundaries'])
    response=select(i,'inputs.ts','response');origins=complete(i,response['root'],direction='origins')
    assert any(b['kind']=='unresolved' and 'receiver ownership' in b['reason'] for b in origins['boundaries'])


def test_overloaded_members_stop_instead_of_selecting_the_last_declaration():
    src={'overloads.ts':'export class Worker { run(value:number):number; run(value:string):string; run(value) { return value; } } const worker=new Worker(); worker.run(input);'}
    i=Index(analyze(src,SHA));reference=select(i,'overloads.ts','run',3)
    assert reference['status']=='unresolved'
    definition=select(i,'overloads.ts','run',0)
    assert definition['status']=='resolved'
    projection=complete(i,definition['root'])
    assert any(b['kind']=='unresolved' and 'overload' in b['reason'] for b in projection['boundaries'])


def test_computed_key_name_resolves_as_variable_and_unknown_assignment_stops():
    src={'keys.ts':'const config={transport:{retries:2}}; function choose(section) { const client=build(config[section]); const container={}; container[section]=config.transport; }',
         'keys.py':'config={"network":{"attempts":2}}\ndef choose(section):\n    client=build(config[section])\n    container={}\n    container[section]=config["network"]\n'}
    i=Index(analyze(src,SHA))
    for path in src:
        declaration=select(i,path,'section',0);reference=select(i,path,'section',1)
        assert declaration['status']=='resolved' and reference['root']['id']==declaration['root']['id']
        root=select(i,path,'retries' if path.endswith('.ts') else 'attempts')['root']
        assert any(b['kind']=='unresolved' and 'Assignment target' in b['reason'] for b in complete(i,root)['boundaries'])
    offset=src['keys.py'].index('"network"')
    assert i.select('keys.py',1,offset)['status']=='ignored'


def test_owned_wrapper_fields_keep_definition_and_do_not_select_siblings_through_value():
    src={'client.ts':'export const client=assemble(options);',
         'wrapper.ts':'import {client} from "./client"; export const bundle={first:client,second:client};',
         'first.ts':'import {bundle} from "./wrapper"; export const view=assemble(bundle.first);',
         'second.ts':'import {bundle} from "./wrapper"; export const other=assemble(bundle.second);'}
    i=Index(analyze(src,SHA));selected=select(i,'wrapper.ts','first')
    assert selected['root']['name']=='bundle.first' and selected['root']['kind']=='field'
    assert selected['root']['definition']==selected['occurrence']
    assert select(i,'first.ts','first')['root']['id']==selected['root']['id']
    scoped=complete(i,selected['root']);paths={n['path'] for n in scoped['nodes']}
    assert 'first.ts' in paths
    assert not any(s['name']=='other' or s['name'].endswith('.second') for n in scoped['nodes'] for s in n['symbols'])
    value=select(i,'client.ts','client')['root']
    assert {'first.ts','second.ts'}<={n['path'] for n in complete(i,value)['nodes']}


def test_class_field_assignment_keeps_owner_and_wrapped_constructor_is_construction():
    src={'construct.ts':'export class Device { retries:number; constructor(amount:number) { this.retries=amount; } move(distance:number) {} } const family={Device}; const config={count:2}; export const instance=new family.Device(config.count); const service={instance}; service.instance.move(config.count);'}
    i=Index(analyze(src,SHA));field=select(i,'construct.ts','retries')
    assert field['root']['kind']=='field' and field['root']['name']=='retries'
    config=select(i,'construct.ts','count')['root'];projection=complete(i,config)
    assert any('instance' in s['name'] for n in projection['nodes'] for s in n['symbols'])
    assert select(i,'construct.ts','move',1)['status']=='resolved'
    python={'device.py':'class Device:\n    def __init__(self, amount):\n        self.retries=amount\n    def move(self, distance):\n        pass\ninstance=Device(options)\nservice={"instance":instance}\nservice["instance"].move(2)\n'}
    i=Index(analyze(python,SHA))
    assert select(i,'device.py','move',1)['status']=='resolved'
    assert any('instance' in s['name'] for n in complete(i,select(i,'device.py','Device')['root'])['nodes'] for s in n['symbols'])
    ambiguous=Index(analyze({'mixed.ts':'class First { move(){} } class Second { move(){} } let value=new First(); value=new Second(); value.move();'},SHA))
    assert select(ambiguous,'mixed.ts','move',2)['status']=='unresolved'
