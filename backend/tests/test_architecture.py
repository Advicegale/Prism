from prism.architecture import build_architecture, committed_sources
import subprocess


def changes(*paths):
    return [{'path':path,'old_path':path,'status':'modified'} for path in paths]


def triples(graph):
    return {(e['source'],e['target'],e['relation']) for e in graph['edges']}


def test_markup_css_fixture_and_entrypoint_form_connected_review():
    source = {
        'viewer/index.html':'<div class="rail"><span id="progress"></span></div>\n<script src="/src/main.js"></script>',
        'viewer/src/styles.css':'.rail { display: grid; }',
        'viewer/src/main.js':'import "./styles.css"; import { app } from "./app.js";',
        'viewer/src/app.js':'const el = document.getElementById("progress");',
        'viewer/src/app.test.js':'import { app } from "./app.js"; import { dom } from "./test/dom.js"; el.closest(".rail");',
        'viewer/src/test/dom.js':'const html = readFileSync(resolve("viewer/index.html"), "utf8");',
        'viewer/src/unrelated.js':'// document.getElementById("progress")\nconst x = "./app.js";',
    }
    graph = build_architecture(changes('viewer/index.html','viewer/src/styles.css','viewer/src/app.js','viewer/src/app.test.js'), source, source)
    assert len(graph['nodes']) == 6
    assert len(graph['edges']) == 9
    assert ('viewer/src/styles.css','viewer/index.html','styles') in triples(graph)
    assert ('viewer/src/app.test.js','viewer/index.html','DOM binding') in triples(graph)
    assert not any('unrelated' in e['source'] for e in graph['edges'])
    assert all(e['status']=='unchanged' for e in graph['edges'])
    assert all(e['evidence'][0]['line']>=1 and e['evidence'][0]['code'] for e in graph['edges'])


def test_cross_layer_alias_http_sql_and_context_selection():
    sources = {
        'tsconfig.json':'{/* JSONC */ "compilerOptions":{"paths":{"@/*":["./src/*"]}},}',
        'src/screens/Tasks.tsx':'import { Provider } from "@/context/Provider"; import { Widget } from "@/components/Widget";',
        'src/components/Widget.tsx':'import { Provider } from "@/context/Provider"; import { Button } from "./Button";',
        'src/components/Button.tsx':'export const Button = () => null;',
        'src/context/Provider.tsx':'import { sync } from "@/services/sync"; import { Widget } from "@/components/Widget";',
        'src/services/sync.ts':'import { cookie } from "./auth"; fetch(`${url}/api/households/${encodeURIComponent(id)}/workspace/sync`, {method:"POST"});',
        'src/services/auth.ts':'export const cookie = "";',
        'server/src/app.ts':'import { apply } from "./workspace.js"; import { tx } from "./db.js"; app.post("/api/households/:householdId/workspace/sync", handler);',
        'server/src/workspace.ts':'import { Client } from "./db.js"; client.query(`insert into upkeep_rooms (id) values ($1)`);',
        'server/src/db.ts':'export const tx = () => {};',
        'server/migrations/0022.sql':'CREATE TABLE upkeep_rooms (id text);',
        'server/migrations/0000.sql':'CREATE TABLE unrelated (id text);',
        'server/src/other.ts':'app.get("/api/households/:householdId/workspace/sync", handler);',
    }
    changed=changes('src/screens/Tasks.tsx','src/components/Widget.tsx','src/context/Provider.tsx','src/services/sync.ts','server/src/workspace.ts','server/migrations/0022.sql')
    g=build_architecture(changed,sources,sources)
    assert {n['path'] for n in g['nodes'] if n['status']=='context'}=={'src/services/auth.ts','server/src/app.ts','server/src/db.ts'}
    assert ('src/services/sync.ts','server/src/app.ts','HTTP request') in triples(g)
    assert ('server/src/workspace.ts','server/migrations/0022.sql','SQL table use') in triples(g)
    assert ('src/screens/Tasks.tsx','src/context/Provider.tsx','imports') in triples(g)
    assert not any(e['target']=='server/src/other.ts' for e in g['edges'])
    assert not any(e['target'].endswith('0000.sql') for e in g['edges'])


def test_deleted_relationship_retains_base_evidence():
    base={'a.js':'import "./b.js";', 'b.js':'export const b = 1;'}
    head={'a.js':'export const a = 1;', 'b.js':'export const b = 1;'}
    g=build_architecture(changes('a.js','b.js'),head,base)
    e=g['edges'][0]
    assert e['status']=='removed'
    assert e['evidence'][0]['side']=='base'


def test_commit_reader_ignores_working_tree_edits_and_symlinks(tmp_path):
    def git(*args):return subprocess.check_output(['git','-C',str(tmp_path),*args],text=True).strip()
    git('init');git('config','user.email','test@example.com');git('config','user.name','Test')
    (tmp_path/'a.js').write_text('export const original = 1;')
    (tmp_path/'linked.js').symlink_to('a.js')
    git('add','.');git('commit','-m','source');sha=git('rev-parse','HEAD')
    (tmp_path/'a.js').write_text('edited locally')
    sources,notes=committed_sources(tmp_path,sha)
    assert sources=={'a.js':'export const original = 1;'}
    assert not notes


def test_all_changed_files_are_preserved_without_relationships():
    g=build_architecture(changes('README.md','styles.css','schema.sql'),{})
    assert len(g['nodes'])==3 and not g['edges']
    assert {n['layer'] for n in g['nodes']}=={'source-files'}
    assert g['method']=='source'


def test_relationship_evidence_prioritizes_actual_changed_selectors():
    head={'index.html':'<div class="other"></div>\n<div class="progress" id="progress"></div>',
          'styles.css':'/* comment mentioning .fake */\n.other { color: red; }\n.progress { color: blue; }'}
    changed=changes('index.html','styles.css')
    changed[0]['new_ranges']=[[2,2]];changed[1]['new_ranges']=[[3,3]]
    edge=build_architecture(changed,head,head)['edges'][0]
    assert edge['detail']=='.progress'
    assert edge['evidence'][0]['line']==3
    assert edge['evidence'][0]['code'].startswith('.progress')
    assert edge['evidence'][1]['line']==2
