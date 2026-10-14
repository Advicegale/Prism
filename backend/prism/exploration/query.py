"""Semantic traversal projected once per file, with retained indirect evidence."""
from __future__ import annotations
from collections import defaultdict, deque
from .model import Facts, Ref, identity

TRANSFERS = {'identity','import','wrapping','namespace'}


class Index:
    def __init__(self, facts: Facts):
        self.facts = facts
        self.relationships={r.id:r for r in facts.relationships}
        self.forward = defaultdict(list); self.reverse = defaultdict(list)
        for rel in facts.relationships:
            self.forward[rel.source.entity].append(rel)
            if rel.target: self.reverse[rel.target.entity].append(rel)

    def canonical(self, ref, seen=None):
        seen=set() if seen is None else seen
        if ref in seen or len(seen)>64: return ref
        seen.add(ref); candidates=[]
        for rel in self.reverse[ref.entity]:
            if rel.kind not in TRANSFERS: continue
            prefix=rel.target.fields
            if ref.fields==prefix and (rel.kind=='wrapping' or (rel.kind=='identity' and self.facts.entities[ref.entity].kind=='field')):continue
            if ref.fields[:len(prefix)]==prefix:
                candidates.append(Ref(rel.source.entity,rel.source.fields+ref.fields[len(prefix):]))
        if len(set(candidates))==1:
            canonical=self.canonical(candidates[0],seen)
            # An alias has a real local definition even when its external input
            # has none. Do not label an unresolved import as that definition.
            return ref if self.facts.entities[canonical.entity].imported else canonical
        return ref

    def definition(self, ref):
        canonical=self.canonical(ref)
        if canonical.fields:
            anchor=self.facts.fields.get(canonical)
            if anchor is None: return None
        else: anchor=self.facts.entities[canonical.entity].anchor
        return {"id":identity(self.facts.revision,canonical),"ref":{"entity":canonical.entity,"fields":list(canonical.fields)},
                "name":'.'.join([self.facts.entities[canonical.entity].name,*canonical.fields]),
                "kind":'field' if canonical.fields else self.facts.entities[canonical.entity].kind,
                "definition":anchor}

    def select(self, path, line, column):
        source=self.facts.sources.get(path)
        if source is None: raise ValueError('Source file was omitted or is unavailable on this revision.')
        lines=source.split('\n')
        if line<1 or line>len(lines): raise ValueError('Source line is outside this revision.')
        utf16=lines[line-1].encode('utf-16-le')
        if column<0 or column*2>len(utf16): raise ValueError('Source column is outside this revision.')
        try: prefix=utf16[:column*2].decode('utf-16-le')
        except UnicodeError: raise ValueError('Source column splits a Unicode character.')
        offset=sum(len(s.encode())+1 for s in lines[:line-1])+len(prefix.encode())
        matches=[o for o in self.facts.occurrences.get(path,[]) if o['anchor']['start_byte']<=offset<o['anchor']['end_byte']]
        if not matches:
            error=self.facts.coverage.get('provider_errors',{}).get(path)
            if error:return {'status':'partial','reason':f'Graphify provider could not extract this source: {error}'}
            if path not in self.facts.occurrences:
                return {'status':'unsupported','reason':'Graphify has no extraction provider for this source.'}
            return {'status':'ignored'}
        occurrence=min(matches,key=lambda o:o['anchor']['end_byte']-o['anchor']['start_byte'])
        a=occurrence['anchor'];raw=source.encode()[a['start_byte']:a['end_byte']]
        if raw[:1] in {b'"',b"'"} and offset in {a['start_byte'],a['end_byte']-1}:return {'status':'ignored'}
        if not occurrence['ref']: return {'status':'unresolved','reason':occurrence['reason'],'occurrence':occurrence['anchor'],'name':occurrence['name']}
        ref=Ref(occurrence['ref']['entity'],tuple(occurrence['ref']['fields']))
        root=self.definition(ref)
        if root is None: return {'status':'unresolved','reason':'Static field ownership or definition could not be resolved.','occurrence':occurrence['anchor'],'name':occurrence['name']}
        entity=self.facts.entities[root['ref']['entity']]
        if entity.imported and root['ref']['entity']==ref.entity:
            return {'status':'unresolved','reason':'Imported name has no unambiguous retained definition.','occurrence':occurrence['anchor'],'name':occurrence['name']}
        return {'status':'resolved','root':root,'occurrence':occurrence['anchor'],
                'focus_ref':{'entity':ref.entity,'fields':list(ref.fields)}}

    def transitions(self, ref, direction):
        relations=self.forward[ref.entity] if direction=='consumers' else [*self.reverse[ref.entity],*(r for r in self.forward[ref.entity] if r.target is None)]
        for rel in relations:
            if rel.target is None:
                if rel.boundary_direction not in {direction,'both'}: continue
                source=rel.source; target=None
            else:
                source=rel.source if direction=='consumers' else rel.target
                target=rel.target if direction=='consumers' else rel.source
            a,b=ref.fields,source.fields
            if a[:len(b)]==b: suffix=a[len(b):]
            elif b[:len(a)]==a: suffix=()
            else: continue
            if target:
                state=Ref(target.entity,target.fields+(suffix if rel.kind in TRANSFERS | {'field_projection'} else ()))
            else: state=None
            yield rel,state


class Query:
    def __init__(self,index,root,direction,changed_only,changed,side,focus_ref=None,focus_anchor=None):
        self.index=index; self.root=root; self.direction=direction; self.changed_only=changed_only
        self.changed=changed; self.side=side; self.id=identity(root,direction,changed_only,side)
        self.nodes={}; self.connections={}; self.boundaries={}; self.visited=set(); self.incomplete=False
        self.ref=Ref(root['ref']['entity'],tuple(root['ref']['fields']))
        path=root['definition']['path']; self.add_node(self.ref,root['definition'])
        self.frontier=[(self.ref,path,())]
        self.history={self.ref:frozenset()}
        self.focus_ref=focus_ref; self.focus_anchor=focus_anchor

    def reveal_focus(self,budget=12000):
        """Reveal the proven carrier path to the clicked occurrence.

        The investigation still traces the canonical selected entity in each
        direction. Revealing its clicked alias must not fan out from its inputs
        into sibling constructions. Hidden intermediaries keep edge evidence.
        """
        if not self.focus_ref or not self.focus_anchor:return
        focus=self.focus_ref; anchor=self.focus_anchor
        self.add_node(focus,anchor)
        parents={self.ref:None}; queue=deque([self.ref])
        while queue and focus not in parents and len(parents)<=budget:
            state=queue.popleft()
            for rel,target in self.index.transitions(state,'consumers'):
                if target is None or target in parents:continue
                parents[target]=(state,rel.id);queue.append(target)
                if target==focus:break
        if focus not in parents:
            # A visible occurrence is source-backed even if no complete carrier
            # path can be proven; never draw an invented connection to it.
            return
        chain=[];state=focus
        while parents[state] is not None:
            previous,relationship=parents[state];chain.append((state,relationship));state=previous
        chain.reverse();path=self.root['definition']['path'];trail=[]
        for state,relationship in chain:
            trail.append(relationship)
            entity=self.index.facts.entities[state.entity];destination=entity.anchor['path']
            visible=not self.changed_only or destination in self.changed or destination in {anchor['path'],self.root['definition']['path']}
            if visible and destination!=path:
                self.add_node(state,entity.anchor)
                if self.direction=='consumers':self.connect(path,destination,tuple(trail))
                else:self.connect(destination,path,tuple(reversed(trail)))
                path=destination;trail=[]
        if self.direction=='consumers' and focus not in self.visited:
            self.frontier.append((focus,anchor['path'],()))
            self.frontier=list(dict.fromkeys(self.frontier))

    def add_node(self,ref,anchor):
        entity=self.index.facts.entities[ref.entity]; path=anchor['path']
        node=self.nodes.setdefault(path,{'id':path,'path':path,'changed':path in self.changed,'symbols':[]})
        annotation={'name':'.'.join(ref.fields if entity.kind=='module' and ref.fields else [entity.name,*ref.fields]),'anchor':anchor,'entity_id':ref.entity}
        if annotation not in node['symbols']: node['symbols'].append(annotation)

    def expand(self,initial=False,budget=12000):
        self.incomplete=False
        queue=deque(self.frontier); self.frontier=[]; seen=set(); work=0
        while queue:
            state,from_file,trail=queue.popleft()
            if state in seen: continue
            seen.add(state); work+=1
            if work>budget:
                self.frontier=[(state,from_file,trail),*queue,*self.frontier]; self.incomplete=True; break
            for rel,target in self.index.transitions(state,self.direction):
                evidence=(*trail,rel.id); anchor=rel.anchor
                history=self.history.get(state,frozenset())
                if rel.id in history:
                    key=identity('cycle',rel.id,state.entity)
                    self.boundaries[key]={'id':key,'kind':'cycle','reason':'This composition returns to an earlier relationship. The cycle is linked without unfolding it.',
                                          'anchor':anchor,'from':from_file,'hidden':self.changed_only and anchor['path'] not in self.changed,'evidence':list(evidence)}
                    continue
                if target: self.history.setdefault(target,history|{rel.id})
                entity=self.index.facts.entities[target.entity] if target else None
                to_file=entity.anchor['path'] if self.direction=='origins' and entity else anchor['path']
                if target and self.direction=='consumers': to_file=entity.anchor['path']
                visible=not self.changed_only or to_file in self.changed or to_file==self.root['definition']['path'] or bool(self.focus_anchor and to_file==self.focus_anchor['path'])
                if target is None:
                    key=identity(state,rel.id,from_file)
                    self.boundaries[key]={'id':key,'kind':rel.kind,'reason':rel.reason,'anchor':anchor,
                                          'from':from_file,'hidden':not visible,'evidence':list(evidence)}
                    if visible:
                        self.add_node(state,anchor)
                        if to_file!=from_file: self.connect(from_file,to_file,evidence)
                    continue
                if to_file==from_file:
                    if visible: self.add_node(target,anchor if self.direction=='consumers' else entity.anchor)
                    if target not in self.visited: queue.append((target,from_file,evidence))
                elif visible:
                    self.add_node(target,anchor if self.direction=='consumers' else entity.anchor)
                    self.connect(from_file,to_file,evidence)
                    if target not in self.visited and target not in seen:
                        self.frontier.append((target,to_file,()))
                elif initial:
                    self.frontier.append((target,from_file,evidence))
                elif target not in self.visited:
                    queue.append((target,from_file,evidence))
            self.visited.add(state)
        # Each context can be traversed once, while all incoming relationships
        # survive merging. Repeated contexts close cycles instead of unfolding.
        self.frontier=list(dict.fromkeys(item for item in self.frontier if item[0] not in self.visited))
        return self.projection()

    def connect(self,source,target,evidence):
        if source==target: return
        refs=self.index.relationships
        anchors=[refs[r].anchor for r in evidence]
        hidden=list(dict.fromkeys(a['path'] for a in anchors if a['path'] not in {source,target}))
        cid=identity(source,target,evidence)
        self.connections[cid]={'id':cid,'source':source,'target':target,'indirect':bool(hidden),
                               'hidden_paths':hidden,'evidence':[{'kind':refs[r].kind,'anchor':refs[r].anchor,
                                                                'id':r} for r in evidence]}

    def projection(self):
        status='partial' if self.incomplete or not self.index.facts.coverage['complete'] else 'expandable' if self.frontier else 'no_further_changed_files' if self.changed_only else 'no_further_eligible_connections'
        return {'query_id':self.id,'root':self.root,'revision':self.index.facts.revision,'side':self.side,
                'direction':self.direction,'changed_only':self.changed_only,'nodes':list(self.nodes.values()),
                'connections':list(self.connections.values()),'boundaries':list(self.boundaries.values()),
                'has_more':bool(self.frontier),'status':status,'coverage':self.index.facts.coverage}
