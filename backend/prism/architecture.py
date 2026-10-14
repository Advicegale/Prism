"""A bounded file graph with evidence, independent of symbol segmentation.

Imports are resolved against tracked files and explicit TS aliases. DOM selectors,
HTTP endpoints and SQL objects are associations with source evidence, never calls
invented by a language model. Source is read from exact Git commits, not edits in
retained worktrees. The old symbol graph remains available for drill-down.
"""
from __future__ import annotations
from collections import defaultdict, Counter
from html.parser import HTMLParser
import importlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
from . import settings
from .symbols import LANGUAGES
from .sourcefiles import eligible_path

VERSION = 4
# Source-only fallback has one neutral group. Architectural roles are discovered
# by architecture_review; no project/language-specific taxonomy is imposed here.


def committed_sources(root: Path, sha: str, omissions: list[dict] | None = None) -> tuple[dict[str, str], list[str]]:
    """Read bounded non-symlink tracked blobs in two Git batch operations."""
    if not re.fullmatch(r'[0-9a-f]{40}', sha): raise ValueError('Invalid graph revision')
    env = {**os.environ, 'GIT_NO_LAZY_FETCH': '1', 'GIT_NO_REPLACE_OBJECTS': '1'}
    def git(args, data=None):
        return subprocess.run(['git', '-C', str(root), *args], input=data, capture_output=True,
                              timeout=60, check=True, env=env).stdout
    inventory = git(['ls-tree', '-rlz', sha])
    chosen = []; total = 0; notes = []
    for row in inventory.split(b'\0'):
        if not row: continue
        header, path = row.split(b'\t', 1)
        mode, kind, oid, size = header.decode().split()
        path = os.fsdecode(path)
        if mode not in {'100644', '100755'} or kind != 'blob': continue
        if not eligible_path(path): continue
        size = int(size)
        if size > settings.MAX_FILE_BYTES:
            if omissions is not None: omissions.append({'path':path,'reason':'Source exceeds PRISM_MAX_FILE_BYTES.'})
            notes.append('Some oversized files could not be inspected.'); continue
        if len(chosen) >= settings.MAX_FILES or total + size > settings.MAX_TOTAL_BYTES:
            notes.append('Source inventory reached the configured analysis limit.')
            if omissions is not None:
                omissions.append({'path':path,'reason':'Source inventory reached PRISM_MAX_FILES / PRISM_MAX_TOTAL_BYTES.'})
                continue
            break
        total += size; chosen.append((path, oid))
    if not chosen: return {}, notes
    data = git(['cat-file', '--batch'], ('\n'.join(oid for _, oid in chosen) + '\n').encode())
    sources = {}; offset = 0
    for path, oid in chosen:
        end = data.index(b'\n', offset); header = data[offset:end].split(); size = int(header[2])
        if header[0].decode() != oid or header[1] != b'blob': raise ValueError('Unexpected Git blob response')
        raw = data[end+1:end+1+size]; offset = end + 2 + size
        if b'\0' in raw:
            if omissions is not None:
                from graphify.extract import _DISPATCH
                if Path(path).suffix.lower() in _DISPATCH:omissions.append({'path':path,'reason':'Source contains binary data.'})
            continue
        try: sources[path] = raw.decode('utf-8')
        except UnicodeError:
            if omissions is not None: omissions.append({'path':path,'reason':'Source is not valid UTF-8.'})
            notes.append('Some non-text files could not be inspected.')
    return sources, sorted(set(notes))


class Markup(HTMLParser):
    def __init__(self, path):
        super().__init__(); self.path = path; self.ids = {}; self.classes = {}; self.assets = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs); line = self.getpos()[0]
        if attrs.get('id'): self.ids[attrs['id']] = line
        for cls in attrs.get('class', '').split(): self.classes[cls] = line
        if tag == 'script' and attrs.get('src'): self.assets.append((attrs['src'], line, 'loads module'))
        if tag == 'link' and attrs.get('rel') == 'stylesheet' and attrs.get('href'): self.assets.append((attrs['href'], line, 'loads stylesheet'))


def js_facts(path: str, text: str) -> list[tuple[str, str, int]]:
    """Extract import and call literal facts from syntax trees, ignoring comments."""
    definition = LANGUAGES.get(Path(path).suffix)
    if not definition or Path(path).suffix not in {'.js', '.jsx', '.ts', '.tsx'}: return []
    from tree_sitter import Language, Parser
    mod = importlib.import_module(definition[0]); source = text.encode()
    tree = Parser(Language(getattr(mod, definition[1])())).parse(source)
    facts = []
    def raw(node): return source[node.start_byte:node.end_byte].decode()
    def literals(node):
        if node.type in {'string', 'template_string'}: return [(raw(node)[1:-1], node.start_point.row+1)]
        return [item for child in node.named_children for item in literals(child)]
    def visit(node):
        if node.type in {'import_statement', 'export_statement'}:
            target = node.child_by_field_name('source')
            if target: facts.append(('imports', raw(target)[1:-1], target.start_point.row+1))
        if node.type == 'call_expression':
            function = node.child_by_field_name('function'); args = node.child_by_field_name('arguments')
            name = raw(function) if function else ''; vals = literals(args) if args else []
            if name in {'require', 'import', 'jest.mock', 'vi.mock'} and vals:
                facts.append(('mocks' if '.mock' in name else 'imports', *vals[0]))
            if name.endswith(('.getElementById', '.querySelector', '.querySelectorAll', '.closest', '.matches')) and vals:
                kind = 'dom_id' if name.endswith('.getElementById') else 'selector'
                facts.append((kind, *vals[0]))
            if name in {'fetch', 'axios.get', 'axios.post', 'axios.put', 'axios.delete'} and vals:
                method = 'POST' if re.search(r"method\s*:\s*['\"]POST['\"]", raw(args)) else name.split('.')[-1].upper() if name.startswith('axios.') else 'GET'
                facts.append(('http:'+method, *vals[0]))
            if (re.fullmatch(r'[\w.]+\.(get|post|put|patch|delete)', name) and not name.startswith('axios.')
                    and vals and vals[0][0].startswith('/') and args and len(args.named_children)>1
                    and args.named_children[1].type in {'arrow_function','function_expression','identifier'}):
                facts.append(('route:'+name.split('.')[-1].upper(), *vals[0]))
            if name.endswith(('.query', '.execute')):
                for value, line in vals:
                    if re.search(r'\b(select|insert|update|delete)\b', value, re.I): facts.append(('sql', value, line))
            if re.search(r'(?:^|\.)(?:readFileSync|readFile|open)$', name):
                for value, line in vals: facts.append(('reads file', value, line))
        for child in node.named_children: visit(child)
    visit(tree.root_node)
    return facts


def json_config(text: str) -> dict:
    # Strip JSONC comments outside strings (aliases/globs may contain /*).
    output = []; index = 0; quoted = False; escaped = False
    while index < len(text):
        char = text[index]
        if quoted:
            output.append(char)
            if escaped: escaped = False
            elif char == "\\": escaped = True
            elif char == '"': quoted = False
            index += 1; continue
        if char == '"': quoted = True
        if text[index:index+2] == '//':
            end = text.find('\n', index); index = len(text) if end < 0 else end; continue
        if text[index:index+2] == '/*':
            end = text.find('*/', index+2); index = len(text) if end < 0 else end+2; continue
        output.append(char); index += 1
    return json.loads(re.sub(r',\s*([}\]])', r'\1', ''.join(output)))


def aliases(sources: dict[str, str]) -> list[tuple[str, str, str]]:
    result = []
    for path, text in sources.items():
        if PurePosixPath(path).name not in {'tsconfig.json', 'jsconfig.json'}: continue
        try:
            config = json_config(text)
        except (ValueError, TypeError): continue
        opts = config.get('compilerOptions', {}); base = posixpath.normpath(posixpath.join(posixpath.dirname(path), opts.get('baseUrl', '.')))
        for key, targets in opts.get('paths', {}).items():
            for target in targets:
                result.append((posixpath.dirname(path), key, posixpath.normpath(posixpath.join(base, target))))
    return sorted(result, key=lambda item: -len(item[0]))


def resolve(source: str, target: str, sources: dict[str, str], mapping: list) -> str | None:
    target = target.split('?')[0].split('#')[0]
    candidates = []
    if target.startswith('.'):
        candidates.append(posixpath.normpath(posixpath.join(posixpath.dirname(source), target)))
    elif target.startswith('/'):
        # HTML web roots are usually the directory containing index.html.
        candidates.extend([posixpath.join(posixpath.dirname(source), target.lstrip('/')), target.lstrip('/')])
    elif target in sources: candidates.append(target)
    for scope, key, mapped in mapping:
        if scope not in {'.', ''} and not source.startswith(scope+'/'): continue
        if '*' in key:
            prefix, suffix = key.split('*', 1)
            if target.startswith(prefix) and target.endswith(suffix):
                value = target[len(prefix):len(target)-len(suffix) if suffix else None]
                candidates.append(mapped.replace('*', value))
        elif key == target: candidates.append(mapped)
    for candidate in candidates:
        variants = [candidate]
        if Path(candidate).suffix in {'.js', '.jsx', '.mjs'}:
            variants.extend([str(PurePosixPath(candidate).with_suffix(ext)) for ext in ['.ts', '.tsx']])
        variants.extend(candidate+ext for ext in ['.ts','.tsx','.js','.jsx','.css','.scss','.html','.py'])
        variants.extend(candidate+'/index'+ext for ext in ['.ts','.tsx','.js','.jsx'])
        for item in variants:
            if item in sources: return item
    return None


def endpoint(value: str) -> str:
    value = re.sub(r'^\$\{[^}]+\}', '', value)
    value = re.sub(r'^https?://[^/]+', '', value)
    value = re.sub(r'\$\{[^}]+\}|:[\w]+', ':param', value)
    return value.split('?')[0].rstrip('/')


def sql_tables(text: str) -> list[str]:
    text = re.sub(r'--[^\n]*|/\*.*?\*/', '', text, flags=re.S)
    return re.findall(r'\b(?:from|join|update|insert\s+into|delete\s+from|(?:create|alter)\s+table(?:\s+if\s+not\s+exists)?)\s+["`]?([\w]+)', text, re.I)


def extract(sources: dict[str, str], structural: dict | None = None, side='head', focus: dict | None = None) -> list[dict]:
    edges = {}; mapping = aliases(sources); html = {}; css = {}; facts = {}; routes = defaultdict(list); tables = defaultdict(list)
    def evidence(path, line):
        rows = sources[path].splitlines()
        return {'path':path, 'line':line, 'side':side, 'code':rows[line-1].strip()[:240] if 0 < line <= len(rows) else ''}
    def add(src, dst, relation, line, target_line=1, detail='', contract=False):
        if src == dst: return
        key = (src,dst,relation)
        item = edges.setdefault(key, {'source':src,'target':dst,'relation':relation,
                                     'confidence':'SOURCE_MATCH' if contract else 'RESOLVED', 'detail':detail, 'evidence':[]})
        pair=[evidence(src,line), evidence(dst,target_line)]
        examples=item.setdefault('_examples', [])
        def rank(refs):
            return sum(any(start<=ref['line']<=end for start,end in (focus or {}).get(ref['path'],[])) for ref in refs)
        if pair not in examples:
            if examples and rank(pair)>rank(examples[0]): item['detail']=detail
            examples.append(pair)
            examples.sort(key=lambda refs:-rank(refs))
            del examples[3:]
        item['evidence']=[ref for refs in examples for ref in refs]
    for path, text in sources.items():
        ext = Path(path).suffix.lower()
        if ext in {'.html', '.htm'}:
            parser = Markup(path); parser.feed(text); html[path] = parser
        if ext in {'.css', '.scss'}:
            # Selectors, not declarations or comment prose.
            clean = re.sub(r'/\*.*?\*/', lambda m:re.sub(r'[^\n]', ' ', m.group()), text, flags=re.S)
            css[path] = [(m.group(1).strip(), clean.count('\n',0,m.start()+len(m.group(1))-len(m.group(1).lstrip()))+1) for m in re.finditer(r'([^{}]+)\{', clean)]
        if ext == '.sql':
            clean = re.sub(r'--[^\n]*|/\*.*?\*/', '', text, flags=re.S)
            for m in re.finditer(r'\b(?:create|alter)\s+table(?:\s+if\s+not\s+exists)?\s+["`]?([\w]+)', clean, re.I):
                # Find line in original rather than relying on comment-stripped offsets.
                line = next((i for i,row in enumerate(text.splitlines(),1) if re.search(r'\b'+re.escape(m.group(1))+r'\b',row,re.I)),1)
                tables[m.group(1).lower()].append((path,line))
        fs = js_facts(path, text); facts[path] = fs
        for kind, value, line in fs:
            if kind.startswith('route:'): routes[(kind[6:],endpoint(value))].append((path,line))
    for path, parser in html.items():
        for target, line, relation in parser.assets:
            dest = resolve(path,target,sources,mapping)
            if dest: add(path,dest,relation,line)
    for path, selectors in css.items():
        for selector,line in selectors:
            classes = re.findall(r'\.([\w-]+)', selector); ids = re.findall(r'#([\w-]+)',selector)
            for dest, parser in html.items():
                matches = [('.'+cls,parser.classes[cls]) for cls in classes if cls in parser.classes] + [('#'+id,parser.ids[id]) for id in ids if id in parser.ids]
                if matches: add(path,dest,'styles',line,matches[0][1],matches[0][0],True)
    for path, fs in facts.items():
        for kind, value, line in fs:
            if kind in {'imports','mocks','reads file'}:
                dest = resolve(path,value,sources,mapping)
                if dest: add(path,dest,kind,line,detail=value)
            elif kind in {'dom_id','selector'}:
                ids = [value] if kind == 'dom_id' else re.findall(r'#([\w-]+)',value)
                classes = re.findall(r'\.([\w-]+)',value) if kind == 'selector' else []
                for dest, parser in html.items():
                    matches = [('#'+id,parser.ids[id]) for id in ids if id in parser.ids]+[('.'+cls,parser.classes[cls]) for cls in classes if cls in parser.classes]
                    if matches: add(path,dest,'DOM binding',line,matches[0][1],matches[0][0],True)
            elif kind.startswith('http:'):
                for dest,dline in routes.get((kind[5:],endpoint(value)),[]):
                    add(path,dest,'HTTP request',line,dline,kind[5:]+' '+endpoint(value),True)
            elif kind == 'sql':
                for table in sql_tables(value):
                    for dest,dline in tables.get(table.lower(),[]): add(path,dest,'SQL table use',line,dline,table,True)
    if structural:
        nodes = {node['id']:node for node in structural.get('nodes',[])}
        for edge in structural.get('edges',[]):
            if edge.get('relation') in {'contains','defines','defined_in'}: continue
            a,b = nodes.get(edge['source'],{}),nodes.get(edge['target'],{})
            src,dst=a.get('path'),b.get('path')
            if src in sources and dst in sources and src != dst and not any(k[:2] == (src,dst) for k in edges):
                add(src,dst,edge.get('relation','references'),a.get('line',1),b.get('line',1),contract=True)
    for edge in edges.values(): edge.pop('_examples', None)
    return list(edges.values())


def build_architecture(files: list[dict], head: dict[str,str], base: dict[str,str] | None = None,
                       structural: dict | None = None, include_all_edges: bool = False) -> dict:
    changed = {f.get('path') or f['old_path']:f for f in files}
    new = extract(head,structural,focus={f.get('path'):f.get('new_ranges',[]) for f in files})
    old = extract(base or {},side='base',focus={f.get('old_path'):f.get('old_ranges',[]) for f in files})
    renamed={f.get('old_path'):f.get('path') for f in files if f.get('status')=='renamed' and f.get('old_path')}
    old=[{**e,'source':renamed.get(e['source'],e['source']),'target':renamed.get(e['target'],e['target'])} for e in old]
    key = lambda e:(e['source'],e['target'],e['relation'])
    old_keys={key(e) for e in old}; new_keys={key(e) for e in new}
    edges=[{**e,'status':'unchanged' if key(e) in old_keys else 'added'} for e in new]
    edges.extend({**e,'status':'removed'} for e in old if key(e) not in new_keys)
    all_sources={**(base or {}),**head}; neighbors=defaultdict(set)
    for edge in edges:
        neighbors[edge['source']].add(edge['target']); neighbors[edge['target']].add(edge['source'])
    scores=Counter(); bridges=set()
    http_clients={e['source'] for e in edges if e['relation']=='HTTP request'}
    for nb in set(neighbors) - changed.keys():
        if nb.endswith('.sql'): continue  # avoid unrelated migration history
        incoming = {e['source'] for e in edges if e['target']==nb and e['source'] in changed}
        outgoing = {e['target'] for e in edges if e['source']==nb and e['target'] in changed}
        if incoming and outgoing:
            bridges.add(nb); scores[nb] += 10
        if incoming & http_clients: scores[nb] += 6
    # An immediate dependency joining an existing bridge and changed source is
    # useful context without interpreting its filename as an architectural role.
    for nb in set(neighbors) - changed.keys() - bridges:
        if not nb.endswith('.sql') and neighbors[nb] & bridges and neighbors[nb] & changed.keys(): scores[nb] += 6
    # HTML fixtures / entrypoints are important even without a second changed neighbor.
    for edge in edges:
        if edge['relation'] in {'reads file','loads module','loads stylesheet','HTTP request'}:
            if edge['source'] in changed and edge['target'] not in changed: scores[edge['target']]+=5
            if edge['target'] in changed and edge['source'] not in changed: scores[edge['source']]+=5
    context=sorted(scores,key=lambda p:(p not in bridges,-scores[p],p))[:12]
    included=set(changed)|set(context)
    nodes=[]
    for path in sorted(included):
        f=changed.get(path); group='source-files'
        nodes.append({'id':path,'path':path,'label':PurePosixPath(path).name,'layer':group,
                      'status':f['status'] if f else 'context', 'available':path in all_sources})
    selected=[e for e in edges if e['source'] in included and e['target'] in included]
    result = {'version':VERSION,'nodes':nodes,'edges':sorted(selected,key=key),
            'layers':[{'id':'source-files','title':'Source relationships','supporting':False,'presentation':'files'}] if nodes else [],
            'notes':[], 'omitted_context':max(0,len(scores)-len(context)), 'method':'source'}
    if include_all_edges: result['all_edges']=edges
    return result



def report_architecture(report: dict, root: Path, include_all_edges: bool = False) -> dict:
    head, notes=committed_sources(root,report['meta']['head'])
    base, old_notes=committed_sources(root,report['meta']['merge_base'])
    result=build_architecture(report.get('files',[]),head,base,report.get('overview'),include_all_edges)
    result['notes']=sorted(set(notes+old_notes))
    return result
