#!/usr/bin/env python3
"""Audit original committed source on both sides of every retained preview PR.

No GitHub request, provider run or reviewed-code execution is performed.
The output records parser versions, revisions, paths and localized diagnostics.
"""
import argparse
from importlib.metadata import distributions
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from graphify import extract
from prism import settings
from prism.architecture import committed_sources
from prism.exploration.graphify_adapter import parse
from prism.exploration.service import revision_context


def diagnostics(tree, source):
    result=[]; stack=[tree.root_node]
    while stack:
        node=stack.pop()
        # Hidden missing tokens are sometimes surfaced as a zero-width named
        # wrapper with has_error, not as a visible is_missing child.
        if node.is_error or node.is_missing or node.has_error and not any(c.has_error for c in node.children):
            result.append({'type':node.type,'line':node.start_point.row+1,
                           'column':node.start_point.column,'end_line':node.end_point.row+1,
                           'text':source[node.start_byte:node.end_byte].decode()[:300]})
        stack.extend(reversed(node.children))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args(); rows=[]
    versions={p.metadata['Name']:p.version for p in distributions() if p.metadata['Name'].lower().replace('_','-').startswith('tree-sitter')}
    for report_path in sorted((settings.DATA_DIR / 'reports').glob('*.json')):
        report=json.loads(report_path.read_text())
        for side in ('old','new'):
            root,sha=revision_context(report,side); omissions=[]
            sources,_=committed_sources(root,sha,omissions=omissions)
            row={'report':report['id'],'repository':report['meta']['owner']+'/'+report['meta']['repo'],
                 'pr':report['meta']['number'],'side':side,'revision':sha,'files':len(sources),
                 'parsed':0,'issues':[],'omissions':omissions}
            with tempfile.TemporaryDirectory(prefix='prism-parser-audit-') as folder:
                for path,text in sources.items():
                    candidate=Path(folder)/path; candidate.parent.mkdir(parents=True,exist_ok=True); candidate.write_text(text)
                    provider=extract._get_extractor(candidate)
                    if provider is None: continue
                    source=text.encode()
                    try: tree,config=parse(source,candidate.suffix,provider.__name__)
                    except (ImportError,AttributeError,TypeError,ValueError) as exc:
                        row['issues'].append({'path':path,'exception':str(exc)}); continue
                    if tree is None: continue
                    row['parsed']+=1
                    if tree.root_node.has_error:
                        row['issues'].append({'path':path,'grammar':config.ts_module,'errors':diagnostics(tree,source)})
            rows.append(row)
            print(f'{row["repository"]} #{row["pr"]} {side}: {row["parsed"]} parsed, {len(row["issues"])} failing files',flush=True)
    output={'parser_versions':versions,'reports':rows,'summary':{'reports':len(rows)//2,
            'revisions':len(rows),'parsed_files':sum(r['parsed'] for r in rows),
            'failing_files':sum(len(r['issues']) for r in rows),
            'unique_failing_paths':len({(r['repository'],i['path']) for r in rows for i in r['issues']})}}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps(output['summary']))
    if output['summary']['failing_files']: sys.exit(1)


if __name__=='__main__': main()
