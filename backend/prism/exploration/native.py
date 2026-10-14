"""Lossless native Graphify facts for every registered extraction provider.

Native imports constrain cross-file bindings; references/calls are endpoints,
never invented identity transfers. Custom providers without an AST still expose
their proven declarations/imports with exact retained-source anchors.
"""
from collections import defaultdict
from pathlib import PurePosixPath
import posixpath
import re
from types import SimpleNamespace
from .model import Ref, Entity, identity
from .graphify_adapter import native_extract


class NativeFacts:
    def __init__(self,index):
        self.index=index;self.facts=index.facts
        self.graph={'nodes':[],'edges':[]};self.providers={};self.errors={};self.parser_errors={}
        self.refs={};self.exports=defaultdict(dict);self.modules={};self.dependencies=defaultdict(set)
        self.import_lines=defaultdict(set);self.packages={}

    def anchor(self,path,start,end):
        raw=self.facts.sources[path].encode();prefix=raw[:start];row=prefix.count(b'\n');column=len(prefix.rsplit(b'\n',1)[-1])
        tail=raw[:end];end_row=tail.count(b'\n');end_column=len(tail.rsplit(b'\n',1)[-1])
        return self.facts.anchor(path,SimpleNamespace(start_byte=start,end_byte=end,
            start_point=SimpleNamespace(row=row,column=column),end_point=SimpleNamespace(row=end_row,column=end_column)))

    def span(self,path,name,location):
        nums=[int(n) for n in re.findall(r'\d+',str(location))]
        if not nums:return None
        rows=self.facts.sources[path].splitlines(keepends=True);line=nums[0]
        if not 1<=line<=len(rows):return None
        # A native symbol's declaration range is authoritative. Do not search
        # elsewhere in the file for a same-spelled name.
        end=min(len(rows),nums[1] if len(nums)>1 else line)
        from graphify.extract import _lang_is_case_insensitive
        text=''.join(rows[line-1:end]);match=re.search(r'(?<![\w])'+re.escape(name)+r'(?![\w])',text,re.I if _lang_is_case_insensitive(path) else 0)
        if not match:return None
        start=len(''.join(rows[:line-1]).encode())+len(text[:match.start()].encode())
        return self.anchor(path,start,start+len(match[0].encode()))

    def extract(self):
        self.index.progress('Reading Graphify native language facts')
        self.graph,self.providers,self.errors=native_extract(self.facts.sources)

    def load(self):
        for path,provider in self.providers.items():
            if path in self.index.files:continue
            self.facts.occurrences[path]=[]
            module=Ref(identity(self.facts.revision,path,'module'))
            self.facts.entities[module.entity]=Entity(module.entity,PurePosixPath(path).stem,'module',self.anchor(path,0,0),identity(path,'module'))
            self.modules[path]=module
        file_nodes={}
        for raw in self.graph['nodes']:
            path=raw.get('source_file');label=str(raw.get('label',''))
            if path not in self.facts.sources:continue
            if label==PurePosixPath(path).name:
                file_nodes[raw['id']]=path;continue
            name=raw.get('metadata',{}).get('name') or label.rstrip('()').rsplit('.',1)[-1].rsplit('::',1)[-1].lstrip('-+').split('/')[0].split(':')[0]
            if not re.fullmatch(r'[$\w][\w$!?-]*',name):continue
            anchor=self.span(path,name,raw.get('source_location'))
            if not anchor:continue
            name=self.facts.sources[path].encode()[anchor['start_byte']:anchor['end_byte']].decode()
            file=self.index.files.get(path)
            candidates=[e for e in self.facts.entities.values() if e.anchor['path']==path and e.name==name and e.anchor['line']==anchor['line']]
            if len(candidates)==1:ref=Ref(candidates[0].id)
            elif file and file.family!='generic':continue  # Mature adapter owns exact lexical identity.
            else:
                kind=raw.get('metadata',{}).get('kind') or raw.get('type') or ('function' if label.endswith('()') else 'symbol')
                eid=identity(self.facts.revision,path,raw['id']);ref=Ref(eid)
                self.facts.entities[eid]=Entity(eid,name,kind,anchor,file.root.id if file else identity(path,'module'))
                if file:
                    file.root.names[name].append(eid)
                    file.declarations[anchor['start_byte'],anchor['end_byte']]=ref
                else:self.facts.occurrences[path].append(self.occurrence(ref,anchor,True))
            self.refs[raw['id']]=ref
            if file and file.family!='generic':continue
            if file and self.facts.entities[ref.entity].owner:continue
            if file:self.exports[path]=file.exports
            if name not in self.exports[path]:self.exports[path][name]=ref
            elif self.exports[path][name]!=ref:self.exports[path].pop(name,None)
        for path,file in self.index.files.items():
            self.modules[path]=file.module;self.exports[path]=file.exports
            package=next((file.text(n.child_by_field_name('name') or n).split('{',1)[0].strip() for n in file.tree.root_node.named_children if n.type in {'package_clause','package_declaration','namespace_declaration'}),None)
            if package:self.packages[path]=(file.config.ts_module,package)
        for edge in self.graph['edges']:
            if edge.get('relation') not in {'imports','imports_from','includes','sources','requires'}:continue
            source=edge.get('source_file') or file_nodes.get(edge['source']);target=edge.get('target_file') or file_nodes.get(edge['target'])
            if not target and edge['target'] in self.refs:target=self.facts.entities[self.refs[edge['target']].entity].anchor['path']
            if source in self.providers and target in self.providers and source!=target:
                self.dependencies[source].add(target)
                nums=re.findall(r'\d+',str(edge.get('source_location','')))
                if nums:self.import_lines[source,int(nums[0])].add(target)
        # Graphify's public graph omits some value-only imports (e.g. Rust
        # constants and top-level require calls). Enrich explicit static module
        # syntax against the same immutable inventory, with unique path/name
        # candidates. This algorithm isn't gated by a language-name list.
        from .analyzer import walk
        for file in self.index.files.values():
            if file.family!='generic':continue
            for node in walk(file.tree.root_node):
                is_import=node.type in file.config.import_types
                fn=node.child_by_field_name(file.config.call_function_field) or node.child_by_field_name('function') or node.child_by_field_name('method') or node.child_by_field_name('name')
                module_call=node.type in file.config.call_types and file.text(fn) in {'require','require_relative','load','dofile','import','source'}
                if not is_import and not module_call:continue
                if module_call and node not in file.imports:file.imports.append(node)
                literals=[file.text(n).strip('\"\'') for n in walk(node) if n.type in {'string','string_literal','interpreted_string_literal','raw_string_literal'}]
                candidates=set()
                for spec in literals:
                    stem=spec.replace('::','/').replace('\\','/')
                    probes={posixpath.normpath(posixpath.join(posixpath.dirname(file.path),stem)),stem}
                    candidates.update(p for p in self.providers if p!=file.path and self.providers[p]==self.providers[file.path] and (p in probes or str(PurePosixPath(p).with_suffix('')) in probes))
                if not literals:
                    parts=[file.text(n) for n in walk(node) if not n.named_children and n.is_named and re.fullmatch(r'\w+',file.text(n))]
                    for p,exports in self.exports.items():
                        if p==file.path or self.providers.get(p)!=self.providers[file.path]:continue
                        stem=PurePosixPath(p).stem
                        if stem in parts and any(name in parts for name in exports):candidates.add(p)
                if len(candidates)==1:
                    self.dependencies[file.path].update(candidates)
                    self.import_lines[file.path,node.start_point.row+1].update(candidates)

    def occurrence(self,ref,anchor,declaration=False):
        return {'anchor':anchor,'ref':{'entity':ref.entity,'fields':list(ref.fields)},'name':self.facts.entities[ref.entity].name,'reason':'','declaration':declaration}

    def omissions(self):
        result=[{'path':path,'reason':f'Graphify {self.providers.get(path,"provider")}: {error}'} for path,error in self.errors.items()]
        result.extend({'path':path,'reason':f'Static syntax enrichment unavailable: {error}; native Graphify facts remain available.'} for path,error in self.parser_errors.items())
        return result

    def candidates(self,file,name):
        paths=set(self.dependencies[file.path])
        if file.path in self.packages:
            paths.update(p for p,package in self.packages.items() if p!=file.path and package==self.packages[file.path])
        return set(self.exports[path][name] for path in paths if name in self.exports[path])

    def lookup(self,file,name,node):
        candidates=self.candidates(file,name)
        return next(iter(candidates)) if len(candidates)==1 else self.reference(file,node) if not candidates else None

    def reference(self,file,node):
        refs={self.refs[e['target']] for e in self.graph['edges'] if e['target'] in self.refs and e.get('source_file')==file.path and
              str(node.start_point.row+1) in re.findall(r'\d+',str(e.get('source_location',''))) and self.facts.entities[self.refs[e['target']].entity].name==file.text(node)}
        return next(iter(refs)) if len(refs)==1 else None

    def link(self):
        from .analyzer import NAMES, walk
        linked=set()
        for file in self.index.files.values():
            if file.family!='generic':continue
            for node in file.imports:
                if any(n!=node and n.start_byte>=node.start_byte and n.end_byte<=node.end_byte for n in file.imports):continue
                destinations=set()
                for line in range(node.start_point.row+1,node.end_point.row+2):destinations.update(self.import_lines[file.path,line])
                if not destinations:continue
                names=[n for n in walk(node) if n.type in NAMES]
                fn=node.child_by_field_name(file.config.call_function_field) or node.child_by_field_name('function') or node.child_by_field_name('method') or node.child_by_field_name('name')
                if node.type in file.config.call_types and file.text(fn) in {'require','require_relative','load','dofile','import','source'}:
                    # Assignment of an explicit module result, with top-level
                    # returned values/objects as its source-visible export.
                    parent=node.parent
                    while parent and parent.type not in {'assignment','assignment_statement','variable_declarator'}:parent=parent.parent
                    if parent and len(destinations)==1:
                        left=parent.child_by_field_name('left') or parent.child_by_field_name('name') or next((c for c in parent.named_children if c.type=='variable_list'),None)
                        name=file.binding_name(left);local=file.lookup(file.text(name),parent) if name else None
                        dest=next(iter(destinations));target=self.exports[dest].get('default') or self.modules[dest]
                        if local:self.index.transfer(target,local,file.anchor(node),linked)
                    continue
                # Explicit namespace alias (Go, using/module alias) is backed
                # by the exact native module edge, not a guessed path.
                alias=node.child_by_field_name('alias') or node.child_by_field_name('name')
                quoted=any('string' in n.type or n.type=='string_literal' for n in walk(node))
                if len(destinations)==1 and (alias and quoted or not names and quoted):
                    dest=next(iter(destinations));other=self.index.files.get(dest)
                    package=next((n for n in other.tree.root_node.named_children if n.type=='package_clause'),None) if other else None
                    package_name=next((n for n in package.named_children if n.type in NAMES),None) if package else None
                    name=file.text(alias) if alias else other.text(package_name) if package_name else PurePosixPath(dest).parent.name
                    if name and name not in {'_','.'}:
                        ref=file.add_entity(alias or node,file.root,'import',name=name,type_name='__module__')
                        self.index.transfer(self.modules[dest],ref,file.anchor(alias or node),linked)
                        continue
                for name_node in names:
                    name=file.text(name_node);targets={self.exports[p][name] for p in destinations if name in self.exports[p]}
                    if len(targets)!=1:continue
                    alias_node=name_node.parent.child_by_field_name('alias') if name_node.parent else None
                    local=file.add_entity(alias_node or name_node,file.root,'import')
                    self.index.transfer(next(iter(targets)),local,file.anchor(alias_node or name_node),linked)
            file.collect_exports();self.exports[file.path]=file.exports
        for path,module in self.modules.items():
            if path in self.index.files:continue
            for name,ref in self.exports[path].items():self.facts.add(ref,module.child(name),'namespace',self.facts.entities[ref.entity].anchor)

    def enrich(self):
        for edge in self.graph['edges']:
            ref=self.refs.get(edge['target']);path=edge.get('source_file')
            if not ref or path not in self.facts.sources or edge.get('relation') in {'contains','defines','member_of'}:continue
            file=self.index.files.get(path)
            if file and file.family!='generic':continue
            name=self.facts.entities[ref.entity].name
            anchor=self.span(path,name,edge.get('source_location'))
            if not anchor:continue
            if not file:self.facts.occurrences[path].append(self.occurrence(ref,anchor))
            # Native call/reference evidence doesn't assert a returned value.
            self.facts.add(ref,None,'usage',anchor,f'Graphify {edge.get("relation","reference")} endpoint ({edge.get("context","source-visible reference")}).')
        # No AST provider-specific value guesses: explicit limits on declarations
        # coexist with real native importer/reference evidence.
        for path in self.providers:
            if path in self.index.files or path in self.errors:continue
            for ref in self.exports[path].values():
                self.facts.add(ref,None,'unsupported',self.facts.entities[ref.entity].anchor,
                    'Native Graphify declarations/references are available; this provider does not expose a static initializer/member AST for additional composition enrichment.','both')
