"""Manual provider integration probe; invokes both installed provider CLIs on passive fixtures."""
import json, secrets, subprocess, tempfile, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from prism.harness import run_harness, QUESTION_SCHEMA, REVIEW_REPOSITORY_GUIDANCE

def probe(provider, root, head, base, context, expected):
    started=time.monotonic()
    prompt=('Passive access integration probe. Use only supplied read-only tools. '+REVIEW_REPOSITORY_GUIDANCE+
            'Recover four exact marker values absent from this prompt: '
            '1. Search the head repository for PROBE_MARKER and read the unchanged source where it occurs; '
            '2. Read legacy.py at revision=base (it is deleted at head); '
            '3. Read the full PR body from read_context section=meta; its REQUIREMENT marker is after character 13000; '
            '4. Read the complete diff for changing.txt and recover DIFF_TAIL near its end, beyond character 16000. '
            'You must follow pagination/continuation if needed. Return answer containing all four exact marker values and cite the source reads where possible. Do not execute any source.')
    try:
        result=run_harness(provider,'default','low',prompt,timeout=240,schema=QUESTION_SCHEMA,required_field='answer',
                           repository_root=root,repository_head=head,repository_base=base,repository_context=context)
        answer=result['answer']; matched={key:value in answer for key,value in expected.items()}
        return {'provider':provider,'seconds':round(time.monotonic()-started,1),'markers':matched,
                'all_recovered':all(matched.values()),'source_reads':len(result.get('__repository_sources',[]))}
    except Exception as exc:
        return {'provider':provider,'seconds':round(time.monotonic()-started,1),'error':str(exc)[:600]}

with tempfile.TemporaryDirectory(prefix='prism-workspace-proof-') as directory:
    root=Path(directory)
    def git(*args):return subprocess.check_output(['git','-C',directory,*args],text=True).strip()
    git('init','-q');git('config','user.email','probe@example.invalid');git('config','user.name','Passive probe')
    expected={key:secrets.token_hex(12) for key in ('unchanged','deleted','requirement','diff_tail')}
    (root/'unchanged.custom').write_text('PROBE_MARKER = '+expected['unchanged']+'\n')
    (root/'legacy.py').write_text('LEGACY = "'+expected['deleted']+'"\n')
    (root/'changing.txt').write_text('old\n')
    git('add','.');git('commit','-qm','base');base=git('rev-parse','HEAD')
    (root/'legacy.py').unlink()
    (root/'changing.txt').write_text(('padding\n'*3000)+'DIFF_TAIL = '+expected['diff_tail']+'\n')
    git('add','.');git('commit','-qm','head');head=git('rev-parse','HEAD')
    context={'meta':{'head':head,'merge_base':base,'base':base,'title':'Passive integration probe',
                     'body':'x'*13000+'\nREQUIREMENT = '+expected['requirement']}}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(probe,p,root,head,base,context,expected) for p in ('codex','claude')]
        results=[f.result() for f in futures]
    # Evidence is printed to stdout; fixture markers remain private to this process.
    for result in results:print(json.dumps(result),flush=True)
