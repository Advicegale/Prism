"""Deduplicated background indexing, atomic revision cache and report sessions."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import threading
import time
import uuid
from .. import settings
from ..architecture import committed_sources
from ..repository_tools import head_worktree, RepositoryToolError
from .analyzer import analyze
from .model import Facts, SCHEMA, ADAPTER_VERSION
from .query import Index, Query

pool=ThreadPoolExecutor(max_workers=2,thread_name_prefix='prism-exploration')
lock=threading.RLock()
builds=OrderedDict(); queries=OrderedDict()


def prune_builds():
    """Called under lock; expired cursors cannot keep evicted indexes alive."""
    completed=[key for key,job in builds.items() if job['status']!='indexing']
    for key in completed[:-6]:
        index=builds.pop(key)['index']
        for token,(_,query,_) in list(queries.items()):
            if query.index is index: queries.pop(token)


def revision_context(report,side):
    sha=report.get('meta',{}).get('merge_base' if side=='old' else 'head','')
    if not re.fullmatch('[a-f0-9]{40}',sha): raise RepositoryToolError('This report is missing the selected source revision.')
    root=head_worktree(report)
    check=subprocess.run(['git','-C',str(root),'cat-file','-e',sha+'^{commit}'],capture_output=True,timeout=10)
    if check.returncode: raise RepositoryToolError('The selected revision is not retained in the cached repository.')
    return root,sha


def side_path(report,path,side):
    pure=PurePosixPath(path)
    if pure.is_absolute() or '..' in pure.parts or '\\' in path: raise ValueError('Choose a repository-relative source path.')
    for file in report.get('files',[]):
        if path in {file.get('path'),file.get('old_path')}:
            return (file.get('old_path') if side=='old' else file.get('path')) or path
    return path


def cache_key(root,sha):
    parser_versions={}
    from importlib.metadata import distributions
    from .graphify_adapter import registry
    for package in distributions():
        name=package.metadata.get('Name','').lower().replace('_','-')
        if name in {'graphifyy','tree-sitter'} or name.startswith('tree-sitter-'):parser_versions[name]=package.version
    providers=sorted((ext,fn.__module__,fn.__qualname__) for ext,fn in registry().items())
    signature=hashlib.sha256(repr((SCHEMA,ADAPTER_VERSION,sorted(parser_versions.items()),providers,settings.MAX_FILES,settings.MAX_FILE_BYTES,settings.MAX_TOTAL_BYTES)).encode()).hexdigest()[:16]
    return str(root.parent.parent),sha,signature


def index_job(report,side):
    root,sha=revision_context(report,side); key=cache_key(root,sha)
    with lock:
        if key in builds: builds.move_to_end(key); return builds[key]
        job={'id':uuid.uuid4().hex,'status':'indexing','message':'Reading retained committed source','revision':sha,'index':None,'error':None}
        builds[key]=job
        prune_builds()
    def work():
        started=time.perf_counter()
        try:
            cache=Path(key[0])/'graphs'/f'exploration-v{SCHEMA}-{sha}-{key[2]}.json'
            hit=False
            if cache.is_file() and not cache.is_symlink():
                try:
                    data=json.loads(cache.read_text()); facts=Facts.restore(data)
                    if data['schema']!=SCHEMA or facts.revision!=sha: raise ValueError('Invalid cache')
                    hit=True
                except (ValueError,KeyError,TypeError): hit=False
            if not hit:
                omitted=[]
                sources,notes=committed_sources(root,sha,omissions=omitted)
                facts=analyze(sources,sha,omitted or [{'path':None,'reason':n} for n in notes],lambda msg:job.update(message=msg))
                cache.parent.mkdir(parents=True,exist_ok=True)
                tmp=cache.with_name(cache.name+'.'+uuid.uuid4().hex+'.tmp')
                try: tmp.write_text(json.dumps(facts.dump(),ensure_ascii=False)); tmp.replace(cache)
                finally: tmp.unlink(missing_ok=True)
            job.update(index=Index(facts),status='ready',message='Ready',timing_ms=round((time.perf_counter()-started)*1000,2),cache_hit=hit)
        except Exception as exc: job.update(status='failed',error=str(exc),message='Source indexing failed')
        finally:
            with lock: prune_builds()
    pool.submit(work)
    return job


def job_response(job):
    return {k:v for k,v in job.items() if k!='index'}


def resolve_symbol(report,path,side,line,column):
    # First classify just the clicked syntax. A comment/literal click doesn't
    # open a loading investigation while the repository index is being built.
    path=side_path(report,path,side); root,sha=revision_context(report,side)
    job=index_job(report,side)
    if job['status']=='failed': return job_response(job)
    if job['status']!='ready':
        from .graphify_adapter import parse
        from .analyzer import walk, NAMES
        result=subprocess.run(['git','-C',str(root),'show',f'{sha}:{path}'],capture_output=True,timeout=15)
        if result.returncode: raise RepositoryToolError('The selected source path is unavailable on this revision.')
        if len(result.stdout)>settings.MAX_FILE_BYTES: return {'status':'partial','reason':'Source file exceeds the configured size limit.'}
        try:
            lines=result.stdout.decode().split('\n'); prefix=lines[line-1].encode('utf-16-le')[:column*2].decode('utf-16-le')
            offset=sum(len(row.encode())+1 for row in lines[:line-1])+len(prefix.encode())
        except (UnicodeError,IndexError): raise ValueError('Invalid source position.')
        try:tree,config=parse(result.stdout,PurePosixPath(path).suffix)
        except (ImportError,AttributeError,ValueError,TypeError):tree=None
        if tree is None:
            # Native/custom providers finish classification from their exact
            # extracted spans. A missing enrichment grammar isn't a language gate.
            return {**job_response(job),'status':'indexing','side':side}
        leaf=tree.root_node.descendant_for_byte_range(offset,offset)
        eligible=leaf.type in NAMES
        ancestor=leaf
        while ancestor and ancestor.type not in {'program','module'}:
            if leaf.is_named and re.fullmatch(r'[\w$!?-]+',result.stdout[leaf.start_byte:leaf.end_byte].decode()):
                for name in ('name','function','method','fun','declarator','bound_identifier'):
                    named=ancestor.child_by_field_name(name)
                    if named and named.start_byte<=leaf.start_byte and named.end_byte>=leaf.end_byte:eligible=True
            if ancestor.type in {'pair','subscript','subscript_expression'}:
                key=ancestor.child_by_field_name('key') or ancestor.child_by_field_name('index') or ancestor.child_by_field_name('subscript')
                if key and key.start_byte<=offset<key.end_byte and key.type in {'string','string_literal','hash_key_symbol','simple_symbol'}:
                    if result.stdout[key.start_byte:key.start_byte+1] in {b'"',b"'"} and offset in {key.start_byte,key.end_byte-1}:
                        eligible=False;break
                    eligible=True
            if ancestor.type in {'comment','jsx_text'}: eligible=False; break
            ancestor=ancestor.parent
        if not eligible: return {'status':'ignored'}
        # The build can finish during click classification. This response is
        # still pending resolution; never expose a bare "ready" without a root.
        return {**job_response(job),'status':'indexing','side':side}
    selected=job['index'].select(path,line,column)
    selected.update(revision=sha,side=side)
    if selected['status']=='resolved':
        selected.update(revision=sha,side=side,coverage=job['index'].facts.coverage)
        selected['projection']=create_query(report,job['index'],selected['root'],'consumers',True,side)
    return selected


def create_query(report,index,root,direction,changed_only,side):
    changed={f.get('old_path') if side=='old' else f.get('path') for f in report.get('files',[])}
    query=Query(index,root,direction,changed_only,changed,side)
    result=query.expand(initial=True); token=uuid.uuid4().hex
    query.id=token; result['query_id']=token
    with lock:
        queries[token]=(report['id'],query,threading.Lock())
        while len(queries)>100: queries.popitem(last=False)
    return result


def expand(report,side,root_id,direction,changed_only,query_id=None):
    job=index_job(report,side)
    if job['status']!='ready': return job_response(job)
    if query_id:
        with lock: entry=queries.get(query_id)
        if not entry: raise ValueError('Exploration session expired; select the symbol again.')
        report_id,query,query_lock=entry
        if (report_id!=report['id'] or query.side!=side or query.root['id']!=root_id or query.direction!=direction
                or query.changed_only!=changed_only or query.index.facts.revision!=job['revision']):
            raise ValueError('Exploration cursor does not match this root, revision or filter.')
        with query_lock: return query.expand()
    # Root IDs are opaque, server-derived; accept only roots of this report.
    with lock:
        root=next((q.root for rid,q,_ in queries.values() if rid==report['id'] and q.root['id']==root_id and q.side==side),None)
    if root is None: raise ValueError('Unknown exploration root; select a source symbol first.')
    return create_query(report,job['index'],root,direction,changed_only,side)


def source(report,path,side,line,end_line=None):
    path=side_path(report,path,side); job=index_job(report,side)
    if job['status']!='ready': return job_response(job)
    text=job['index'].facts.sources.get(path)
    if text is None: raise RepositoryToolError('This source file was omitted or is unavailable on the selected revision.')
    rows=text.splitlines(keepends=True)
    if line<1 or line>len(rows): raise ValueError('Source line is outside this revision.')
    start=max(1,line-4); end=min(len(rows),end_line or line+8)
    if end<line or end-start>100: raise ValueError('Choose a source range of at most 100 lines.')
    anchors=list({(o['anchor']['start_byte'],o['anchor']['end_byte']):o['anchor']
                  for o in job['index'].facts.occurrences.get(path,[]) if start<=o['anchor']['line']<=end}.values())
    return {'status':'ready','revision':job['revision'],'side':side,'path':path,'start_line':start,
            'end_line':end,'code':''.join(rows[start-1:end]),'anchors':anchors,'bounded':start>1 or end<len(rows)}
