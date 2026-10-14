#!/usr/bin/env python3
"""Create a passive two-revision local report for reproducible desktop QA.

Run with backend/.venv/bin/python. No reviewed code, providers or GitHub calls
are executed. Use the printed isolated PRISM_DATA_DIR with start.sh.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import argparse

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from prism.gitops import diff_files
from prism.architecture import build_architecture
from prism.topics import build_topics

parser=argparse.ArgumentParser();parser.add_argument('--language',choices=['ts','go'],default='ts')
parser.add_argument('--clicked-alias',action='store_true',help='TS alias with further upstream and downstream levels')
args=parser.parse_args()
if args.clicked_alias and args.language!='ts':parser.error('--clicked-alias requires --language ts')

data=Path(tempfile.mkdtemp(prefix='prism-exploration-qa-'))
key=hashlib.sha256(b'local/exploration').hexdigest()[:20]
repo=data/'repos'/key/'repo';repo.mkdir(parents=True)
def git(*args):return subprocess.run(['git','-C',str(repo),*args],check=True,capture_output=True,text=True).stdout.strip()
git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Passive source fixture')
sources={
 'config.ts':'// Click a name; comments and literal values stay ordinary source.\nexport const config = { transport: { retries: 3 }, logging: { level: "info" } };\n',
 'client.ts':'import { config as preferences } from "./config";\nexport const primary = make(preferences.transport);\nexport const secondary = make(preferences.transport);\nexport const logger = make(preferences.logging);\n',
 'policy.ts':'import { config } from "./config";\nexport const retryPolicy = build(config.transport);\n',
 'screen.ts':'import { primary as client } from "./client";\nimport { retryPolicy } from "./policy";\nexport const service = { client, retryPolicy };\nexport const version = 1;\n',
 'operations.ts':'import { primary } from "./client";\nexport const response = primary.send(order);\nexport function sendOrder(order) { primary.send(order); }\n',
 'responses.ts':'import { response, sendOrder } from "./operations";\nexport const outputs = { response, sendOrder };\nexport const version = 1;\n',
 'logger.ts':'import { logger } from "./client";\nexport const logService = { logger };\nexport const version = 1;\n',
}
if args.language=='go':
    sources={
      'go.mod':'module fixture\ngo 1.24\n',
      'prefs/config.go':'package prefs\ntype Network struct { Retries int }\ntype Logging struct { Level string }\nvar Config = struct { Transport Network; Logging Logging }{Transport: Network{Retries: 3}, Logging: Logging{Level: "info"}}\n',
      'client/client.go':'package client\nimport prefs "fixture/prefs"\nvar Primary = makeClient(prefs.Config.Transport)\nvar Secondary = makeClient(prefs.Config.Transport)\nvar Logger = makeClient(prefs.Config.Logging)\n',
      'policy/policy.go':'package policy\nimport prefs "fixture/prefs"\nvar RetryPolicy = build(prefs.Config.Transport)\n',
      'screen/screen.go':'package screen\nimport client "fixture/client"\nimport policy "fixture/policy"\ntype Service struct { Client any; RetryPolicy any }\nvar Current = Service{Client: client.Primary, RetryPolicy: policy.RetryPolicy}\nconst Version = 1\n',
      'operations/operations.go':'package operations\nimport client "fixture/client"\nvar Response = client.Primary.Send(order)\n',
      'responses/responses.go':'package responses\nimport ops "fixture/operations"\nvar Output = Envelope{Response: ops.Response}\nconst Version = 1\n',
      'logger/logger.go':'package logger\nimport client "fixture/client"\nvar Output = Envelope{Logger: client.Logger}\nconst Version = 1\n',
      'native_helper.dart':'int helper() { return 1; }\n',
    }
def write_sources(values):
    for path,text in values.items():
        dest=repo/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(text)
write_sources(sources)
git('add','.');git('commit','-m','Before');old=git('rev-parse','HEAD')
if args.language=='go':
    head={p:t.replace('Retries','Attempts').replace('Retries: 3','Attempts: 4').replace('Attempts: 3','Attempts: 4').replace('Version = 1','Version = 2') for p,t in sources.items()}
    head['native_helper.dart']=sources['native_helper.dart'].replace('return 1','return 2')
else:
    head={**sources,'config.ts':sources['config.ts'].replace('retries: 3','attempts: 4')}
    for name in ['screen.ts','responses.ts','logger.ts']:head[name]=head[name].replace('version = 1','version = 2')
    if args.clicked_alias:
        head['screen.ts']=head['screen.ts'].replace('primary as client','primary as transportClient').replace('{ client, retryPolicy }','{ client: transportClient, retryPolicy }')
        head['tuning.ts']='export const tuning = { tries: 4 };\n'
        head['config.ts']='import { tuning } from "./tuning";\nexport const config = { transport: { attempts: tuning.tries }, logging: { level: "info" } };\n'
        head['consumer.ts']='import { service } from "./screen";\nexport const middle = { service };\n'
        head['end.ts']='import { middle } from "./consumer";\nexport const display = { middle };\n'
write_sources(head)
git('add','.');git('commit','-m','After');new=git('rev-parse','HEAD')
worktree=repo.parent/'worktrees'/new;worktree.parent.mkdir();git('worktree','add',str(worktree),new)
files=diff_files(repo,old,new);changed={f['path'] for f in files}
nodes=[{'id':p,'path':p,'label':p,'kind':'file','line':1,'status':'modified'} for p in sorted(changed)]
graph={'nodes':nodes,'edges':[],'truncated':False}
group={'id':'fixture','title':'Source configuration and composed services','changed_count':len(files),
       'files':sorted(changed),'changed_ids':sorted(changed),'graph':graph}
report={'id':'f'*24,'created_at':'2026-10-13T19:00:00+00:00','demo':False,
        'meta':{'owner':'local','repo':'exploration','number':1,'title':'Local source-backed exploration fixture',
                'url':'','body':'Passive local Git revisions. No provider analysis.','head':new,'merge_base':old,'author':'Local'},
        'files':files,'groups':[group],'topics':build_topics([group],graph),
        'overview':graph,'architecture':build_architecture(files,head,sources),'ai':None,'evidence':{},
        'stats':{'changed_files':len(files),'changed_symbols':len(nodes),'groups':1,'indexed_files':len(sources),
                 'total_graph_nodes':len(nodes),'total_graph_edges':0}}
reports=data/'reports';reports.mkdir();(reports/(report['id']+'.json')).write_text(json.dumps(report))
print(json.dumps({'data_dir':str(data),'report_id':report['id'],'old':old,'new':new}))
