"""Static enrichment over Graphify grammars/import facts, never target execution.

Relations carry a field projection on both ends. A factory creates a distinct
binding; identity and wrapper transfers retain the selected subobject. Calls on
tracked receivers, function bodies, computed keys and unsupported flow stop.
"""
from __future__ import annotations
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import PurePosixPath
import posixpath
import re
from .model import Entity, Facts, Ref, identity
from .graphify_adapter import parse, module_facts, configurations
from ..architecture import aliases, resolve, json_config

NAMES = {'identifier', 'type_identifier', 'property_identifier', 'shorthand_property_identifier',
         'shorthand_property_identifier_pattern', 'field_identifier', 'simple_identifier',
         'constant', 'variable_name', 'name', 'symbol', 'namespace_identifier','package_identifier'}
MEMBERS = {'member_expression', 'attribute', 'field_access', 'subscript_expression', 'subscript'}
OBJECTS = {'object', 'dictionary'}
CALLS = {'call_expression', 'new_expression', 'call', 'method_invocation', 'object_creation_expression'}
FUNCTIONS = {'arrow_function', 'function_expression', 'generator_function'}
WRAPS = {'parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion'}


def walk(node):
    yield node
    for child in node.named_children:
        yield from walk(child)


@dataclass
class Scope:
    id: str
    parent: Scope | None
    owner: str | None = None
    kind: str = 'block'
    names: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))


class FileAdapter:
    def __init__(self, index: Analyzer, path: str):
        self.index = index; self.facts = index.facts; self.path = path
        self.source = self.facts.sources[path].encode()
        self.tree, self.config = parse(self.source, PurePosixPath(path).suffix,index.native.providers.get(path))
        self.family = 'python' if self.config.ts_module=='tree_sitter_python' else 'java' if self.config.ts_module=='tree_sitter_java' else 'js' if self.config.ts_module in {'tree_sitter_javascript','tree_sitter_typescript'} else 'generic'
        self.root = Scope(identity(path, 'module'), None, kind='module')
        self.scopes = {}; self.declarations = {}; self.values = []; self.imports = []
        self.export_specs = []; self.exports = {}; self.ambiguous_exports=set(); self.members = defaultdict(dict)
        self.class_nodes = {}; self.parameter_nodes = set(); self.role_nodes = set()
        self.constructor_types=defaultdict(set)
        self.module = Ref(identity(self.facts.revision, path, 'module'))
        self.facts.entities[self.module.entity] = Entity(self.module.entity, PurePosixPath(path).stem,
            'module', self.anchor(self.tree.root_node), self.root.id)
        self.declare(self.tree.root_node, self.root)
        self.collect_exports()

    def text(self, node):
        return self.source[node.start_byte:node.end_byte].decode() if node is not None else ''

    def anchor(self, node): return self.facts.anchor(self.path, node)

    def add_entity(self, node, scope, kind='variable', name=None, owner=None, type_name=None):
        name = name or self.text(node)
        eid = identity(self.facts.revision, self.path, scope.id, name, node.start_byte)
        self.facts.entities[eid] = Entity(eid, name, kind, self.anchor(node), scope.id,
                                          owner, type_name, kind == 'import')
        if eid not in scope.names[name]: scope.names[name].append(eid)
        self.declarations[(node.start_byte, node.end_byte)] = Ref(eid)
        if owner:
            if name in self.members[owner]:
                previous=self.members[owner][name]
                reason=f'Multiple declarations of owned member {name}; overload/accessor binding is not resolved.'
                if previous:self.facts.add(Ref(previous),None,'unresolved',self.anchor(node),reason,'both')
                self.facts.add(Ref(eid),None,'unresolved',self.anchor(node),reason,'both')
                self.facts.add(Ref(owner,(name,)),None,'unresolved',self.anchor(node),reason,'both')
                self.members[owner][name]=None
            else:self.members[owner][name]=eid
        return Ref(eid)

    def lookup(self, name, node):
        scope = self.scopes.get(node.id, self.root)
        while scope:
            ids = scope.names.get(name, [])
            if len(ids) == 1: return Ref(ids[0])
            if len(ids) > 1:
                # JS var redeclarations/Python assignments share their binding;
                # overloads/multiple declarations are deliberately ambiguous.
                return None
            scope = scope.parent
        return self.index.native.lookup(self, name, node) if self.family=='generic' else None

    def nearest(self, scope, kind):
        while scope:
            if scope.kind == kind: return scope
            scope = scope.parent
        return None

    def pattern(self, node, scope, value, projection=(), kind='variable'):
        if node is None: return
        if node.type in NAMES:
            ref = self.add_entity(node, scope, kind)
            if value is not None: self.values.append((ref, value, projection))
        elif node.type in {'object_pattern', 'pattern_list', 'tuple_pattern', 'list_pattern'}:
            for child in node.named_children:
                if child.type == 'pair_pattern':
                    key = child.child_by_field_name('key'); target = child.child_by_field_name('value')
                    if key and target: self.pattern(target, scope, value, (*projection, self.key(key)), kind)
                elif child.type == 'shorthand_property_identifier_pattern':
                    self.pattern(child, scope, value, (*projection, self.text(child)), kind)
                else:
                    self.pattern(child, scope, value, (*projection, '?'), kind)
        elif node.type in {'required_parameter', 'optional_parameter', 'formal_parameter', 'spread_parameter',
                          'typed_parameter', 'default_parameter', 'typed_default_parameter', 'assignment_pattern'}:
            target = node.child_by_field_name('pattern') or node.child_by_field_name('name') or node.child_by_field_name('left')
            if target is None:
                target = next((c for c in node.named_children if c.type in NAMES or c.type == 'object_pattern'), None)
            self.pattern(target, scope, value, projection, kind)
            if target:
                ref = self.declarations.get((target.start_byte, target.end_byte)); typ = node.child_by_field_name('type')
                if ref and typ: self.facts.entities[ref.entity].type_name = self.text(typ).strip(': ').split('<')[0]

    def declare(self, node, scope):
        self.scopes[node.id] = scope
        typ = node.type
        if typ in self.config.class_types:
            name = node.child_by_field_name('name')
            if name:
                cls=self.nearest(scope,'class')
                ref = self.add_entity(name, scope, 'type',owner=cls.owner if cls else None); self.class_nodes[ref.entity] = node
                child_scope = Scope(identity(self.path, node.start_byte, 'class'), scope, ref.entity, 'class')
                for child in node.named_children:
                    self.declare(child, child_scope if child != name else scope)
                return
        if typ in self.config.function_types or typ in FUNCTIONS:
            name = node.child_by_field_name('name')
            cls = self.nearest(scope, 'class')
            ref = self.add_entity(name, scope, 'method' if cls else 'function', owner=cls.owner if cls else None) if name else None
            child_scope = Scope(identity(self.path, node.start_byte, 'function'), scope, ref.entity if ref else None, 'function')
            for child in node.named_children:
                self.declare(child, child_scope if child != name else scope)
            return
        if typ in {'statement_block', 'block', 'for_statement', 'catch_clause'} and self.family in {'js','java'}:
            scope = Scope(identity(self.path, node.start_byte, 'block'), scope)
            self.scopes[node.id] = scope
        if typ in self.config.import_types and (typ != 'export_statement' or node.child_by_field_name('source')):
            self.imports.append(node)
            if typ != 'export_statement': self.declare_import(node, scope)
        if typ in {'parameters', 'formal_parameters', 'lambda_parameters'}:
            for child in node.named_children:
                self.pattern(child, scope, None, kind='parameter')
                self.parameter_nodes.update(n.id for n in walk(child))
        elif typ == 'variable_declarator':
            name = node.child_by_field_name('name'); value = node.child_by_field_name('value')
            parent = node.parent
            cls = self.nearest(scope, 'class') if self.family == 'java' else None
            is_field = parent and parent.type == 'field_declaration'
            if name and is_field:
                typ_node = parent.child_by_field_name('type')
                ref = self.add_entity(name, scope, 'field', owner=cls.owner if cls else None,
                                      type_name=self.text(typ_node).split('<')[0])
                if value: self.values.append((ref, value, ()))
            else:
                binding_scope=(self.nearest(scope,'function') or self.root) if self.family=='js' and parent and parent.type=='variable_declaration' and any(c.type=='var' for c in parent.children) else scope
                self.pattern(name, binding_scope, value)
        elif typ in {'public_field_definition', 'field_definition', 'property_signature'}:
            name = node.child_by_field_name('name') or node.child_by_field_name('property'); value = node.child_by_field_name('value'); cls = self.nearest(scope, 'class')
            if name:
                ref = self.add_entity(name, scope, 'field', owner=cls.owner if cls else None,
                                      type_name=self.text(node.child_by_field_name('type')).strip(': '))
                if value: self.values.append((ref, value, ()))
        elif typ in {'assignment', 'named_expression','assignment_expression'}:
            left = node.child_by_field_name('left') or node.child_by_field_name('name'); right = node.child_by_field_name('right') or node.child_by_field_name('value')
            if left and left.type == 'identifier':
                name = self.text(left)
                existing=self.lookup(name,node) if self.family!='python' else Ref(scope.names[name][0]) if name in scope.names else None
                if existing:
                    ref = existing; self.declarations[(left.start_byte, left.end_byte)] = ref
                    if right: self.values.append((ref, right, ()))
                else: self.pattern(left, scope, right)
            elif left and left.type in MEMBERS:
                obj=left.child_by_field_name('object'); prop=left.child_by_field_name('attribute'); cls=self.nearest(scope,'class')
                if cls and self.text(obj) in {'self','cls'} and prop and self.text(prop) not in self.members[cls.owner]:
                    self.add_entity(prop,scope,'field',owner=cls.owner)
                self.values.append((left, right, ()))
            else: self.pattern(left, scope, right)
        elif typ in {'for_statement', 'for_in_statement', 'enhanced_for_statement'}:
            left = node.child_by_field_name('left') or node.child_by_field_name('name')
            if left and left.type in NAMES and self.lookup(self.text(left), node) is None:
                self.pattern(left, scope, None)
        for child in node.named_children: self.declare(child, scope)

    def declare_import(self, node, scope):
        if self.family == 'js':
            for item in walk(node):
                if item.type == 'import_specifier':
                    name = item.child_by_field_name('name'); alias = item.child_by_field_name('alias') or name
                    if alias: self.add_entity(alias, scope, 'import')
                if item.type == 'import_clause':
                    for c in item.named_children:
                        if c.type == 'identifier': self.add_entity(c, scope, 'import')
                if item.type == 'namespace_import':
                    for c in item.named_children:
                        if c.type == 'identifier': self.add_entity(c, scope, 'import',type_name='__module__')
        elif self.family == 'python':
            for item in node.named_children:
                if item.type == 'aliased_import':
                    name = item.child_by_field_name('alias') or item.child_by_field_name('name')
                    if name:
                        ref=self.add_entity(name, scope, 'import', name=self.text(name).split('.')[0],type_name='__module__' if node.type=='import_statement' else None)
                        original=item.child_by_field_name('name')
                        leaves=[n for n in walk(original) if n.type=='identifier'] if original else []
                        if leaves:self.declarations[(leaves[-1].start_byte,leaves[-1].end_byte)]=ref
                elif item.type == 'dotted_name' and item != node.child_by_field_name('module_name'):
                    name = next((c for c in item.named_children if c.type == 'identifier'), item)
                    self.add_entity(name, scope, 'import', name=self.text(item).split('.')[0],type_name='__module__' if node.type=='import_statement' else None)
        else:
            name = next((c for c in node.named_children if c.type in {'identifier','scoped_identifier'}), None)
            if name:
                leaf = list(walk(name))[-1]
                self.add_entity(leaf, scope, 'import', name=self.text(leaf),type_name=None if re.match(r'import\s+static\b',self.text(node)) else '__type__')

    def collect_exports(self):
        if self.family in {'python', 'java'}:
            self.exports = {name: Ref(ids[0]) for name, ids in self.root.names.items() if len(ids) == 1}
        else:
            from graphify.extractors import resolution as r
            for node in self.tree.root_node.named_children:
                if node.type != 'export_statement': continue
                for name in r._js_exported_declaration_names(node, self.source):
                    ref = self.lookup(name, node)
                    if ref: self.exports[name] = ref
                default = r._js_default_export_name(node, self.source)
                if default:
                    ref = self.lookup(default, node)
                    if ref: self.exports['default'] = ref
                if not node.child_by_field_name('source'):
                    for original, exposed in r._js_named_specifiers(node, self.source, 'export_specifier'):
                        ref = self.lookup(original, node)
                        if ref: self.exports[exposed] = ref
                        self.export_specs.append((node, original, exposed))
            # Anonymous default object/value gets a real distinct binding.
            for node in self.tree.root_node.named_children:
                if node.type == 'export_statement' and any(c.type == 'default' for c in node.children) and 'default' not in self.exports:
                    value = node.child_by_field_name('value')
                    if value:
                        ref = self.add_entity(value, self.root, 'variable', name='default')
                        self.exports['default'] = ref; self.values.append((ref, value, ()))

    def key(self, node):
        text = self.text(node)
        return text[1:-1] if node.type in {'string', 'string_literal'} else text

    def canonical(self, ref): return self.index.canonical(ref)

    def known(self,ref):
        canonical=self.canonical(ref)
        return not canonical.fields or canonical in self.facts.fields

    def transfer(self,source,target,kind,node):
        if self.known(source): self.facts.add(source,target,kind,self.anchor(node))
        else:
            self.facts.add(Ref(source.entity),None,'unresolved',self.anchor(node),
                           'Static field ownership cannot be resolved; this branch stops.')
            self.facts.add(target,None,'unresolved',self.anchor(node),
                           'Static field ownership of this composition input cannot be resolved.', 'origins')

    def expression(self, node):
        if node is None: return None
        if node.type in WRAPS:
            return self.expression(node.named_children[0]) if node.named_children else None
        if node.type in {'this', 'self'} or self.text(node) in {'this','self','cls'}:
            scope = self.nearest(self.scopes.get(node.id), 'class')
            return Ref(scope.owner) if scope and scope.owner else None
        if node.type in NAMES: return self.lookup(self.text(node), node)
        if node.type in MEMBERS or node.type == 'scoped_identifier':
            obj = node.child_by_field_name('object') or node.child_by_field_name('value') or node.child_by_field_name('scope')
            prop = node.child_by_field_name('property') or node.child_by_field_name('attribute') or node.child_by_field_name('field') or node.child_by_field_name('index') or node.child_by_field_name('subscript') or node.child_by_field_name('name')
            base = self.expression(obj)
            if not base or not prop: return None
            if node.type in {'subscript_expression','subscript'} and prop.type not in {'string', 'string_literal'}: return None
            key = self.key(prop); canonical = self.canonical(base)
            target = self.index.member(canonical, key)
            return target or base.child(key)
        return None

    def fields_for(self, target, value):
        if value is None or value.type not in OBJECTS: return
        for item in value.named_children:
            if item.type in {'pair', 'pair_pattern'}:
                key = item.child_by_field_name('key'); child = item.child_by_field_name('value')
                if key and key.type in NAMES | {'string','string_literal'}:
                    ref = target.child(self.key(key)); self.facts.fields[ref] = self.anchor(key)
                    self.declarations[(key.start_byte,key.end_byte)] = ref
                    self.fields_for(ref, child)
            elif item.type == 'shorthand_property_identifier':
                self.facts.fields[target.child(self.text(item))] = self.anchor(item)

    def compose(self, target, value, projection=()):
        if value is None: return
        typ = value.type
        if projection:
            source = self.expression(value)
            if source and '?' not in projection:
                for key in projection: source = source.child(key)
                self.transfer(source,target,'identity',value)
            else: self.boundary_refs(value, 'unresolved', 'Unsupported destructuring or dynamic position.',target)
            return
        if typ in WRAPS:
            if value.named_children: self.compose(target, value.named_children[0])
        elif typ in OBJECTS:
            for item in value.named_children:
                if item.type == 'pair':
                    key = item.child_by_field_name('key'); child = item.child_by_field_name('value')
                    if key and key.type in NAMES | {'string','string_literal'}:
                        self.compose(target.child(self.key(key)), child)
                    else: self.boundary_refs(item, 'unresolved', 'Computed object key cannot be resolved.',target)
                elif item.type == 'shorthand_property_identifier':
                    ref = self.lookup(self.text(item), item)
                    if ref: self.transfer(ref,target.child(self.text(item)),'wrapping',item)
                elif item.type in {'spread_element','dictionary_splat'}:
                    self.boundary_refs(item,'unsupported','Object spreads require unknown field ownership.',target)
                elif item.type in self.config.function_types:
                    self.boundary_refs(item,'unsupported','Returned/callback object flows are not modeled.',target)
        elif typ in CALLS:
            args = value.child_by_field_name('arguments')
            fn = value.child_by_field_name('function') or value.child_by_field_name('constructor') or value.child_by_field_name('type') or value.child_by_field_name('name')
            receiver = value.child_by_field_name('object') if typ == 'method_invocation' else fn.child_by_field_name('object') if fn and fn.type in MEMBERS else None
            receiver_ref = self.expression(receiver)
            receiver_entity = self.facts.entities.get(self.index.canonical(receiver_ref,preserve_owner=False).entity) if receiver_ref else None
            callee=self.expression(fn)
            callee_value=self.index.canonical(callee,preserve_owner=False) if callee else None
            # Java static methods / Python module functions are explicit factories
            # when assigned. Instance methods are operation endpoints.
            static_receiver=receiver_entity and (receiver_entity.kind in {'type','module'} or receiver_entity.type_name in {'__type__','__module__'})
            constructor=typ in {'new_expression','object_creation_expression'} or (self.family=='python' and callee_value and self.facts.entities[callee_value.entity].kind=='type')
            ambiguous_receiver=not constructor and receiver_entity and receiver_entity.imported and not static_receiver
            operation = not constructor and receiver_ref is not None and not static_receiver
            if ambiguous_receiver:
                self.facts.add(receiver_ref,None,'unresolved',self.anchor(value),'External receiver ownership cannot distinguish a factory from an instance operation.')
                if args:self.boundary_refs(args,'unresolved','External receiver ownership cannot distinguish a factory from an instance operation.',target)
            elif operation:
                self.facts.add(receiver_ref,None,'usage',self.anchor(value),'Tracked receiver operation; its result is outside composition scope.')
                if args: self.boundary_refs(args,'usage','Argument used by an operation; result is outside composition scope.')
                self.facts.add(target,None,'usage',self.anchor(value),'Receiver operation result; origins stop at this operation.', 'origins')
            else:
                if args:
                    for arg in args.named_children:
                        if arg.type in FUNCTIONS or arg.type in self.config.function_types:
                            self.boundary_refs(arg,'unsupported','Callback/return flow is not modeled.',target)
                        else: self.inputs(arg,target,'construction')
                if constructor:
                    ref = callee
                    if ref: self.facts.add(ref,target,'construction',self.anchor(value))
                    if not target.fields and fn: self.facts.entities[target.entity].type_name=self.text(fn).split('<')[0]
                    key=callee_value.entity if callee_value and self.facts.entities[callee_value.entity].kind=='type' else self.text(fn)
                    self.constructor_types[target].add(key)
                    if len(self.constructor_types[target])>1:
                        self.facts.types[target]=''
                        self.facts.add(target,None,'unresolved',self.anchor(value),'Multiple constructor types make this value ownership ambiguous.','both')
                    elif callee_value and self.facts.entities[callee_value.entity].kind=='type':self.facts.types[target]=callee_value.entity
        elif typ in FUNCTIONS or typ in self.config.function_types:
            self.boundary_refs(value,'usage','Function body uses the entity; function importers are outside composition scope.',target)
        else:
            ref = self.expression(value)
            if ref:
                self.transfer(ref,target,'wrapping' if target.fields else 'identity',value)
            elif typ in {'subscript_expression','subscript'}:
                obj = value.child_by_field_name('object') or value.child_by_field_name('value')
                source = self.expression(obj)
                if source: self.facts.add(source,None,'unresolved',self.anchor(value),'Computed field key cannot be resolved.')
                self.facts.add(target,None,'unresolved',self.anchor(value),'Computed field key cannot be resolved.', 'origins')
            elif typ not in {'string','string_literal','integer','float','number','true','false','none','null'}:
                self.boundary_refs(value,'unsupported','This expression does not have a supported static composition transfer.',target)

    def inputs(self, node, target, kind):
        ref = self.expression(node)
        if ref: self.transfer(ref,target,kind,node); return
        if node.type in OBJECTS:
            for item in node.named_children:
                child = item.child_by_field_name('value') if item.type == 'pair' else item
                if child: self.inputs(child,target,kind)
            return
        if node.type in {'subscript_expression','subscript'}:
            obj = node.child_by_field_name('object') or node.child_by_field_name('value')
            ref = self.expression(obj)
            if ref: self.facts.add(ref,None,'unresolved',self.anchor(node),'Computed field key cannot be resolved.')
            self.facts.add(target,None,'unresolved',self.anchor(node),'Computed input field key cannot be resolved.', 'origins')
            return
        if node.type in {'spread_element','dictionary_splat'}:
            self.boundary_refs(node,'unsupported','Spread field ownership is not modeled.',target); return
        if node.type in WRAPS and node.named_children: self.inputs(node.named_children[0],target,kind)
        elif node.type not in {'string','string_literal','integer','float','number','true','false','none','null'}:
            self.boundary_refs(node,'unsupported','Indirect argument/return flow is not modeled.',target)

    def boundary_refs(self, node, kind, reason, origin_target=None):
        if origin_target:self.facts.add(origin_target,None,kind,self.anchor(node),reason,'origins')
        refs = set()
        def visit(n):
            ref = self.expression(n)
            if ref: refs.add(ref); return
            if n.type in {'string','string_literal','comment','jsx_text'}: return
            for child in n.named_children: visit(child)
        visit(node)
        for ref in refs: self.facts.add(ref,None,kind,self.anchor(node),reason)

    def enrich(self):
        for target, value, projection in self.values:
            if isinstance(target, Ref): self.fields_for(target,value)
        for target,value,projection in self.values:
            target = target if isinstance(target,Ref) else self.expression(target)
            if target:self.compose(target,value,projection)
            elif value is not None:self.boundary_refs(value,'unresolved','Assignment target has computed or unresolved field ownership.')
        # Unassigned ordinary uses remain endpoints, including references in
        # exported operation functions. They never produce a call-graph edge.
        self.collect_occurrences()

    def collect_occurrences(self):
        occurrences = []
        for node in walk(self.tree.root_node):
            ref = self.declarations.get((node.start_byte,node.end_byte)); reason = ''
            # Synthetic barrel/default bindings may use an entire statement or
            # initializer as evidence, but that span must never activate its
            # keywords, punctuation or arbitrary literal contents.
            if node.type not in NAMES:
                if node.type not in {'string','string_literal'} or ref is None or not ref.fields or ref not in self.facts.fields: continue
            parent = node.parent
            if ref is None:
                if parent and parent.type in {'import_specifier','export_specifier'}:
                    alias = parent.child_by_field_name('alias') or parent.child_by_field_name('name')
                    ref = self.lookup(self.text(alias), node)
                    if parent.type == 'export_specifier': ref = self.lookup(self.text(parent.child_by_field_name('name')),node)
                elif parent and parent.type in MEMBERS:
                    prop = parent.child_by_field_name('property') or parent.child_by_field_name('attribute') or parent.child_by_field_name('field') or parent.child_by_field_name('subscript') or parent.child_by_field_name('index')
                    if prop == node and parent.type in {'subscript_expression','subscript'}:ref=self.expression(node)
                    elif prop == node: ref = self.expression(parent)
                    else: ref = self.expression(node)
                elif parent and parent.type == 'pair' and parent.child_by_field_name('key') == node: continue
                elif self.family == 'js' and parent and parent.type in {'jsx_attribute','jsx_opening_element','jsx_closing_element','jsx_self_closing_element'} and node.type == 'property_identifier': continue
                else: ref = self.expression(node)
                if ref is None: reason = 'No unambiguous local/import/member binding for this name.'
            anchor = self.anchor(node)
            occurrences.append({'anchor':anchor,'ref':{'entity':ref.entity,'fields':list(ref.fields)} if ref else None,
                                'name':self.key(node),'reason':reason,'declaration':(node.start_byte,node.end_byte) in self.declarations})
            if ref and not occurrences[-1]['declaration'] and not (parent and parent.type in {'import_specifier','export_specifier','dotted_name','aliased_import','scoped_identifier'}):
                full=node
                while full.parent and full.parent.type in MEMBERS: full=full.parent
                used=self.expression(full) or ref
                returned=full.parent
                while returned and returned.type not in self.config.function_boundary_types and returned.type!='return_statement':returned=returned.parent
                if returned and returned.type=='return_statement' and any(c.type in OBJECTS for c in returned.named_children):
                    reason='Returned-object composition is not modeled; this branch stops before function importers.'
                    self.facts.add(used,None,'unsupported',self.anchor(returned),reason)
                    function=self.nearest(self.scopes.get(node.id),'function')
                    if function and function.owner:self.facts.add(Ref(function.owner),None,'unsupported',self.anchor(returned),reason,'origins')
                else:self.facts.add(used,None,'usage',self.anchor(full),'Source reference; no further composition from this occurrence.')
        # Quoted static property accesses are named fields, unlike string values.
        for node in walk(self.tree.root_node):
            if node.type not in {'subscript_expression','subscript'}: continue
            key = node.child_by_field_name('index') or node.child_by_field_name('subscript')
            if key and key.type in {'string','string_literal'}:
                ref = self.expression(node)
                occurrences.append({'anchor':self.anchor(key),'ref':{'entity':ref.entity,'fields':list(ref.fields)} if ref else None,
                                    'name':self.key(key),'reason':'Unknown owned dictionary field.' if not ref else '', 'declaration':False})
        self.facts.occurrences[self.path] = sorted(occurrences,key=lambda o:o['anchor']['start_byte'])


class Analyzer:
    def __init__(self, sources, revision, omissions=None, progress=lambda _:None):
        self.facts = Facts(revision,sources); self.files = {}; self.mapping = aliases(sources)
        self.identities = defaultdict(list); self.modules = {}; self.progress = progress
        from .native import NativeFacts
        from .generic import GenericFileAdapter
        self.native=NativeFacts(self)
        self.native.extract()
        omitted = list(omissions or []); languages = defaultdict(int)
        for path in sources:
            ext = PurePosixPath(path).suffix.lower()
            if path not in self.native.providers:continue
            from .graphify_adapter import provider_config
            config=provider_config(self.native.providers[path],ext)
            if config:
                try:
                    adapter=FileAdapter if config.ts_module in {'tree_sitter_python','tree_sitter_javascript','tree_sitter_typescript','tree_sitter_java'} else GenericFileAdapter
                    self.files[path] = adapter(self,path); languages[ext] += 1
                except (ImportError,AttributeError,TypeError,ValueError) as exc:
                    self.native.parser_errors[path]=str(exc)
                    continue
                if self.files[path].tree.root_node.has_error:
                    omitted.append({'path':path,'reason':'Parser could not fully analyze this syntax; affected bindings may be incomplete.'})
        self.native.load()
        omitted.extend(self.native.omissions())
        self.facts.coverage = {'languages':dict(languages),'omitted':omitted,'complete':not omitted,
                               'providers':self.native.providers,
                               'provider_errors':self.native.errors,
                               'adapter':'Graphify native registry + Prism shared static composition enrichment'}

    def canonical(self, ref, seen=None, preserve_owner=True):
        if ref is None: return None
        seen = set() if seen is None else seen
        if ref in seen or len(seen)>64: return ref
        seen.add(ref)
        candidates=[]
        for rel in self.facts._identities.get(ref.entity,[]):
            p=rel.target.fields
            if preserve_owner and ref.fields==p and (rel.kind=='wrapping' or (rel.kind=='identity' and self.facts.entities[ref.entity].kind=='field')):continue
            if ref.fields[:len(p)] == p:
                candidates.append(Ref(rel.source.entity,rel.source.fields+ref.fields[len(p):]))
        if len(set(candidates)) == 1:
            canonical=self.canonical(candidates[0],seen,preserve_owner)
            return ref if preserve_owner and self.facts.entities[canonical.entity].imported else canonical
        return ref

    def member(self, ref, name):
        ref=self.canonical(ref,preserve_owner=False)
        entity = self.facts.entities[ref.entity]
        file = self.files.get(entity.anchor['path'])
        if not file: return self.native.exports[entity.anchor['path']].get(name) if entity.kind=='module' else None
        if entity.kind == 'module': return file.exports.get(name)
        if ref.child(name) in self.facts.fields:return ref.child(name)
        if not ref.fields and entity.kind == 'type' and file.members[ref.entity].get(name):
            return Ref(file.members[ref.entity][name])
        if ref in self.facts.types or (not ref.fields and entity.type_name):
            type_ref=Ref(self.facts.types[ref]) if self.facts.types.get(ref) else None if ref in self.facts.types else self.type_ref(entity)
            if type_ref:
                typ=self.canonical(type_ref); owner_file=self.files[self.facts.entities[typ.entity].anchor['path']]
                member=owner_file.members.get(typ.entity,{}).get(name)
                if member:
                    if self.facts.entities[member].kind=='method': return Ref(member)
                    self.facts.fields[ref.child(name)]=self.facts.entities[member].anchor
                    return ref.child(name)
        return None

    def type_ref(self,entity):
        file=self.files.get(entity.anchor['path'])
        if not file or not entity.type_name: return None
        names=entity.type_name.split('.')
        scope=next((s for s in file.scopes.values() if s.id==entity.scope),file.root)
        while scope:
            ids=scope.names.get(names[0],[])
            if len(ids)==1:
                ref=self.canonical(Ref(ids[0]))
                for name in names[1:]:
                    ref=self.member(ref,name)
                    if ref is None: break
                return self.canonical(ref,preserve_owner=False) if ref else None
            scope=scope.parent
        return None

    def module_path(self, path, spec, family):
        if family == 'js':
            direct=resolve(path,spec,self.facts.sources,self.mapping)
            if direct: return direct
            # Tracked workspace package exports, only a unique source candidate.
            matches=[]
            for manifest,text in self.facts.sources.items():
                if PurePosixPath(manifest).name != 'package.json': continue
                try: config=json_config(text)
                except (ValueError,TypeError): continue
                name=config.get('name','')
                if not name or not (spec==name or spec.startswith(name+'/')): continue
                suffix=spec[len(name):].lstrip('/'); exports=config.get('exports',{})
                target=exports.get('./'+suffix if suffix else '.',None) if isinstance(exports,dict) else exports
                if isinstance(target,dict): target=target.get('types') or target.get('import') or target.get('default')
                target=target or (suffix if suffix else config.get('module') or config.get('main'))
                if isinstance(target,str):
                    candidate=resolve(manifest,target if target.startswith('.') else './'+target,self.facts.sources,self.mapping)
                    if candidate: matches.append(candidate)
            return matches[0] if len(set(matches))==1 else None
        dots=len(spec)-len(spec.lstrip('.')); remainder=spec.lstrip('.').replace('.','/')
        if dots:
            base=posixpath.dirname(path)
            for _ in range(dots-1): base=posixpath.dirname(base)
            candidates=[posixpath.join(base,remainder)]
        else: candidates=[remainder, 'src/'+remainder]
        found=[p for c in candidates for p in [c+'.py',c+'/__init__.py'] if p in self.files]
        return found[0] if len(set(found))==1 else None

    def link(self):
        self.native.link()
        # Fixed point handles barrels and import/export cycles without recursion.
        linked=set()
        for _ in range(len(self.files)+1):
            changes=0
            for file in self.files.values():
                if file.family=='generic': continue  # Native Graphify module resolution.
                for node in file.imports:
                    if file.family == 'java':
                        text=file.text(node); match=re.match(r'import\s+(static\s+)?([\w.]+)',text)
                        if not match: continue
                        static=bool(match[1]); qualified=match[2]; parts=qualified.split('.')
                        owner=parts[-2] if static else parts[-1]; imported=parts[-1]
                        candidates=[]
                        for other in self.files.values():
                            if other.family!='java': continue
                            package=next((other.text(c).replace('package','',1).strip(' ;\r\n') for c in other.tree.root_node.named_children if c.type=='package_declaration'),'')
                            class_name=qualified.rsplit('.',1)[0] if static else qualified
                            if class_name != (package+'.' if package else '')+owner: continue
                            root=other.exports.get(owner)
                            if root and self.facts.entities[root.entity].kind=='type': candidates.append(self.member(root,imported) if static else root)
                        target=candidates[0] if len(candidates)==1 else None
                        local=file.lookup(imported,node)
                        if local and target: changes+=self.transfer(target,local,file.anchor(node),linked)
                        continue
                    facts=module_facts(node,file.source)
                    if not facts: continue
                    if file.family=='python' and node.type=='import_statement':
                        for original,local_name in facts['names']:
                            dest=self.module_path(file.path,original,'python'); local=file.lookup(local_name,node)
                            if dest and local: changes+=self.transfer(self.files[dest].module,local,file.anchor(node),linked)
                        continue
                    dest=self.module_path(file.path,facts['module'],file.family)
                    if not dest:
                        # `from . import module` can bind a submodule directly.
                        if file.family=='python':
                            for original,local_name in facts['names']:
                                sub=self.module_path(file.path,facts['module']+original,'python'); local=file.lookup(local_name,node)
                                if sub and local: changes+=self.transfer(self.files[sub].module,local,file.anchor(node),linked)
                        continue
                    other=self.files.get(dest)
                    if not other: continue
                    names=list(facts['names'])
                    if facts.get('default'): names.append(('default',facts['default']))
                    for original,local_name in names:
                        target=other.exports.get(original)
                        if not target: continue
                        if node.type=='export_statement':
                            local=file.exports.get(local_name)
                            if local is None:
                                alias_node=next((n for n in walk(node) if n.type in NAMES and file.text(n)==local_name),node)
                                local=file.add_entity(alias_node,file.root,'import',name=local_name)
                                file.exports[local_name]=local; changes+=1
                        else: local=file.lookup(local_name,node)
                        if local: changes+=self.transfer(target,local,file.anchor(node),linked)
                    if facts.get('star'):
                        for name,target in other.exports.items():
                            if name=='default' or name in file.ambiguous_exports: continue
                            current=file.exports.get(name)
                            if current is None:
                                local=file.add_entity(node,file.root,'import',name=name); file.exports[name]=local
                                changes+=self.transfer(target,local,file.anchor(node),linked)
                            elif self.canonical(current)!=self.canonical(target):
                                file.exports.pop(name,None)
                                file.ambiguous_exports.add(name)
                    if facts.get('namespace_export'):
                        name=facts['namespace_export'];local=file.exports.get(name)
                        if local is None:
                            name_node=next((n for n in walk(node) if n.type in NAMES and file.text(n)==name),node)
                            local=file.add_entity(name_node,file.root,'import',name=name);file.exports[name]=local
                        changes+=self.transfer(other.module,local,file.anchor(node),linked)
                    for ns in (n for n in walk(node) if n.type=='namespace_import'):
                        name_node=next((c for c in ns.named_children if c.type=='identifier'),None)
                        local=file.lookup(file.text(name_node),node)
                        if local: changes+=self.transfer(other.module,local,file.anchor(node),linked)
            if not changes: break
        # Java same-package classes resolve without explicit imports.
        for file in self.files.values():
            if file.family!='java': continue
            package=next((file.text(c) for c in file.tree.root_node.named_children if c.type=='package_declaration'),'')
            for other in self.files.values():
                if other.family!='java' or other==file: continue
                opackage=next((other.text(c) for c in other.tree.root_node.named_children if c.type=='package_declaration'),'')
                if package!=opackage: continue
                for name,ref in other.exports.items():
                    if name not in file.root.names: file.root.names[name]=[ref.entity]

    def transfer(self,source,target,anchor,linked):
        local=self.facts.entities[target.entity]
        if local.imported and local.anchor['path']==anchor['path']: anchor=local.anchor
        key=(source,target,anchor['path'],anchor['start_byte'])
        if key in linked: return 0
        linked.add(key); self.facts.add(source,target,'import',anchor)
        self.identities[target.entity].append(self.facts.relationships[-1]); return 1

    def build(self):
        self.progress('Resolving module bindings'); self.link()
        for file in self.files.values():
            for name,ref in file.exports.items():
                self.facts.add(ref,file.module.child(name),'namespace',self.facts.entities[ref.entity].anchor)
        for file in self.files.values():
            for target,value,_ in file.values:
                if isinstance(target,Ref): file.fields_for(target,value)
        # Identity facts before member resolution permit static aliases/nesting.
        for file in self.files.values():
            for target,value,projection in file.values:
                if isinstance(target,Ref) and value and (value.type in NAMES | MEMBERS | WRAPS) and not projection:
                    source=file.expression(value)
                    if source and file.known(source):
                        self.facts.add(source,target,'identity',file.anchor(value))
                        self.identities[target.entity].append(self.facts.relationships[-1])
        self.progress('Extracting fields and compositions')
        for file in self.files.values(): file.enrich()
        self.native.enrich()
        # Declared instance fields have value ownership separate from their type.
        # A type reference never aliases the entire instance. Selecting a field
        # through an instance keeps that particular owner and its field context.
        typed={Ref(e.id):self.type_ref(e) for e in list(self.facts.entities.values())}
        typed.update({ref:Ref(e) if e else None for ref,e in self.facts.types.items()})
        for ref,typ in typed.items():
            if not typ: continue
            owner_file=self.files.get(self.facts.entities[typ.entity].anchor['path'])
            if not owner_file: continue
            for name,member in owner_file.members.get(typ.entity,{}).items():
                if not member:continue
                field_entity=self.facts.entities[member]
                if field_entity.kind!='field': continue
                child=ref.child(name); self.facts.fields.setdefault(child,field_entity.anchor)
                self.facts.add(Ref(member),child,'field_projection',self.facts.fields.get(ref,self.facts.entities[ref.entity].anchor))
        # Unbound imports and parser issues stay explicit even if another branch
        # has resolved. Imported external factories still accept explicit inputs.
        for file in self.files.values():
            for e in list(self.facts.entities.values()):
                if e.anchor['path']!=file.path or not e.imported or e.id in self.identities: continue
                self.facts.add(Ref(e.id),None,'unresolved',e.anchor,'Import has no unambiguous retained definition (external or unsupported module).','both')
        unique={r.id:r for r in self.facts.relationships}
        self.facts.relationships=list(unique.values())
        return self.facts


def analyze(sources, revision, omissions=None, progress=lambda _:None):
    return Analyzer(sources,revision,omissions,progress).build()
