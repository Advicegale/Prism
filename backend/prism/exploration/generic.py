"""Shared AST-shape enrichment, independent of a language allowlist.

Graphify owns parser and module resolution. Common declaration/initializer/
member conventions add ordinary bindings and selected-field compositions.
Unrecognized syntax stops at a source-backed boundary instead of guessing.
"""
from .analyzer import FileAdapter, Scope, Ref, NAMES, walk, identity
import re
from .graphify_adapter import generic_config

TRANSPARENT={'expression_list','argument','literal_element','parenthesized_expression',
             'reference_expression','pointer_expression','borrow_expression','equals_value_clause',
             'as_expression','await_expression','value_argument'}
LITERALS={'string','string_literal','raw_string_literal','interpreted_string_literal','encapsed_string',
          'integer','integer_literal','int_literal','float','float_literal','number','true','false','nil','null','none',
          'boolean_literal','symbol','simple_symbol','hash_key_symbol','char_literal','character_literal','number_literal'}
OBJECTS={'object','dictionary','hash','table_constructor','struct_expression','composite_literal',
         'initializer_list','initializer_expression','dictionary_literal','map_literal','record_expression','array_creation_expression'}


def field(node, *names):
    if node is None:return None
    return next((value for name in names if name and (value:=node.child_by_field_name(name)) is not None),None)


class GenericFileAdapter(FileAdapter):
    def declare(self,node,scope):
        if not hasattr(self,'generic_ready'):
            self.config=generic_config(self.config);self.generic_ready=True
            self.indirect_assignments=[]
        self.scopes[node.id]=scope
        typ=node.type
        if typ in self.config.class_types | self.config.function_types:
            name=self.binding_name(field(node,self.config.name_field,'name','declarator'))
            if typ.endswith('_specifier') and not field(node,'body'):name=None
            if name:
                cls=self.nearest(scope,'class');kind='type' if typ in self.config.class_types else 'method' if cls else 'function'
                ref=self.add_entity(name,scope,kind,owner=cls.owner if cls else None)
                if kind=='type':self.class_nodes[ref.entity]=node
                inner=Scope(identity(self.path,node.start_byte,kind),scope,ref.entity,'class' if kind=='type' else 'function')
                for child in node.named_children:self.declare(child,scope if child==name else inner)
                return
        if typ in {'block','compound_statement','statement_block','function_body'}:
            scope=Scope(identity(self.path,node.start_byte,'block'),scope);self.scopes[node.id]=scope
        if typ in self.config.import_types:
            self.imports.append(node)
        # Prefer grammar fields. The same shape works for let/var/static/const,
        # ordinary assignments, declarators, parameters and owned value fields.
        declaration=any(word in typ for word in ('declaration','declarator','assignment','parameter','var_spec','const_spec','field_definition','field_initializer','property_definition')) or typ in {'const_item','static_item','binding','value_definition'}
        if declaration and typ not in self.config.import_types:
            target=field(node,'pattern','left','declarator','name')
            value=field(node,'right','value','initializer','default')
            if target and target.type=='init_declarator':target=None  # Its child owns the initializer.
            if typ=='assignment_statement':
                target=next((c for c in node.named_children if c.type=='variable_list'),target)
                value=next((c for c in node.named_children if c.type=='expression_list'),value)
            if target is None and typ in {'property_declaration','parameter','class_parameter'}:
                target=next((c for c in node.named_children if c.type in NAMES or c.type in {'variable_declaration','pattern'}),None)
            if value is None and target is not None:
                # Grammars such as C#/Swift/Kotlin expose an unnamed initializer.
                after=[c for c in node.named_children if c.start_byte>=target.end_byte and c.type not in {'type_identifier','type_annotation','user_type','predefined_type','modifiers'}]
                if any(c.type in {'=','==',':='} and self.text(c) in {'=',':='} for c in node.children) and after:value=after[-1]
            # A dereferenced write changes pointed-to memory, not the pointer
            # binding. Parsing it successfully must not invent value identity.
            operand=target
            while operand and operand.type=='parenthesized_expression' and len(operand.named_children)==1:
                operand=operand.named_children[0]
            if operand and operand.type in {'prefix_unary_expression','pointer_expression','unary_expression'} and self.text(operand).lstrip().startswith('*'):
                self.indirect_assignments.append(node);target=None
            if target:
                if self.member_parts(target):self.values.append((target,value,()))
                else:
                    names=self.binding_names(target)
                    rhs=value.named_children if value and value.type=='expression_list' else [value]
                    for i,name in enumerate(names):
                        if (name.start_byte,name.end_byte) in self.declarations:continue
                        existing=self.lookup(self.text(name),node) if 'assignment' in typ else None
                        cls=self.nearest(scope,'class')
                        is_field=cls and not self.nearest(scope,'function') and ('field' in typ or 'property' in typ or 'declarator' in typ)
                        kind='parameter' if 'parameter' in typ else 'field' if is_field else 'variable'
                        ref=existing or self.add_entity(name,scope,kind,owner=cls.owner if is_field else None,type_name=self.text(field(node,'type')) or None)
                        self.declarations[(name.start_byte,name.end_byte)]=ref
                        if value:self.values.append((ref,rhs[i] if len(names)==len(rhs) else value,() if len(names)==1 or len(names)==len(rhs) else ('?',)))
        for child in node.named_children:self.declare(child,scope)

    def enrich(self):
        super().enrich()
        for node in self.indirect_assignments:
            self.boundary_refs(node,'unsupported','Pointer writes require memory-alias analysis; this branch stops at the assignment.')

    def binding_name(self,node):
        if node is None:return None
        if node.type in NAMES or node.type=='word' and not node.named_children:return node
        return self.binding_name(field(node,'name','declarator','pattern','bound_identifier')) or next((n for n in node.named_children if n.type in NAMES),None)

    def binding_names(self,node):
        if node.type in NAMES:return [node]
        if node.type in {'expression_list','identifier_list','variable_list','pattern_list','tuple_pattern'}:
            return [n for child in node.named_children for n in self.binding_names(child)]
        name=self.binding_name(node)
        return [name] if name else []

    def collect_exports(self):
        self.exports={name:Ref(ids[0]) for name,ids in self.root.names.items() if len(ids)==1 and
                      not self.facts.entities[ids[0]].imported and not self.facts.entities[ids[0]].owner}
        if not hasattr(self,'default_export'):
            returned=next((n for n in self.tree.root_node.named_children if n.type=='return_statement'),None)
            if returned and returned.named_children:
                value=returned.named_children[-1]
                ref=self.expression(value)
                if ref:self.default_export=ref
                elif value.type in OBJECTS:
                    self.default_export=self.add_entity(value,self.root,'variable',name='default')
                    self.values.append((self.default_export,value,()))
        if hasattr(self,'default_export'):self.exports['default']=self.default_export

    def member_parts(self,node):
        obj=field(node,self.config.call_accessor_object_field,'object','operand','receiver','scope','table')
        prop=field(node,self.config.call_accessor_field,'property','attribute','field','member')
        if node.type in self.config.call_accessor_node_types:
            obj=obj or field(node,'expression') or (node.named_children[0] if len(node.named_children)>1 else None)
            prop=prop or field(node,'name')
        if node.type in {'field_expression','scoped_identifier','qualified_identifier','navigation_expression'}:
            obj=obj or field(node,'value','path')
            prop=prop or field(node,'name')
            if len(node.named_children)>=2:
                obj=obj or node.named_children[0];prop=prop or node.named_children[-1]
        if node.type in {'subscript','subscript_expression','index_expression','element_access_expression','element_reference','bracket_index_expression'}:
            obj=obj or field(node,'value','argument','expression') or (node.named_children[0] if len(node.named_children)>1 else None)
            prop=field(node,'index','subscript') or (node.named_children[-1] if len(node.named_children)>1 else None)
            if prop and prop.type not in LITERALS-{'integer','integer_literal','number'}:return (obj,None)
        return (obj,prop) if obj else None

    def expression(self,node):
        if node is None:return None
        if node.type in TRANSPARENT:
            child=field(node,'value') or (node.named_children[-1] if node.named_children else None)
            return self.expression(child) if child else None
        if self.text(node) in {'this','self','cls'}:return super().expression(node)
        parts=self.member_parts(node)
        if parts:
            obj,prop=parts;base=self.expression(obj)
            if not base or not prop:return None
            name=self.binding_name(prop) or prop
            key=self.key(name);canonical=self.canonical(base)
            member=self.index.member(canonical,key)
            carrier=self.facts.entities[base.entity]
            # Keep the occurrence's module binding in the transfer path. Its
            # canonical definition still resolves through namespace/import
            # facts, without bypassing the actual import's source evidence.
            if member and (carrier.kind=='module' or carrier.type_name=='__module__'):return base.child(key)
            return member or base.child(key)
        role=node.parent and any(node.parent.child_by_field_name(name)==node for name in ('name','function','method','fun','declarator','bound_identifier'))
        return self.lookup(self.text(node),node) if node.type in NAMES or role and re.fullmatch(r'[\w$!?-]+',self.text(node)) else None

    def object_items(self,value):
        if value is None or value.type not in OBJECTS:return None
        body=field(value,'body') or value
        result=[]
        for item in body.named_children:
            key=field(item,'key','name','field','designator');child=field(item,'value')
            if not key and len(item.named_children)==2 and any(c.type=='=>' for c in item.children):key,child=item.named_children
            if not key and item.type in {'shorthand_field_initializer','shorthand_property_identifier'}:key=child=item
            if key and key.type=='literal_element' and len(key.named_children)==1:key=key.named_children[0]
            if key and ('designator' in key.type):key=self.binding_name(key)
            if key and (key.type in NAMES or key.type in {'hash_key_symbol','simple_symbol'} or key.type in LITERALS and 'string' in key.type and all('content' in n.type or not n.is_named for n in key.children)):result.append((key,child))
        return result

    def fields_for(self,target,value):
        if value and value.type in TRANSPARENT and value.named_children:
            self.fields_for(target,field(value,'value') or value.named_children[-1]);return
        items=self.object_items(value)
        if items is None:return
        for key,child in items:
            ref=target.child(self.key(key));self.facts.fields[ref]=self.anchor(key)
            self.declarations[(key.start_byte,key.end_byte)]=ref;self.fields_for(ref,child)

    def key(self,node):
        text=self.text(node)
        if node.type in {'hash_key_symbol','simple_symbol'}:return text.lstrip(':').rstrip(':')
        if 'string' in node.type and text[:1] in {'\"',"'"} and text[-1:]==text[:1]:return text[1:-1]
        return super().key(node)

    def compose(self,target,value,projection=()):
        if value is None:return
        if projection:self.boundary_refs(value,'unsupported','Destructuring has no unambiguous static field projection.',target);return
        if value.type in TRANSPARENT and value.named_children:self.compose(target,field(value,'value') or value.named_children[-1]);return
        items=self.object_items(value)
        if items is not None:
            self.fields_for(target,value)
            typ=self.expression(field(value,'type'))
            if typ and self.facts.entities[self.canonical(typ).entity].kind=='type':self.facts.types[target]=self.canonical(typ).entity
            for key,child in items:self.compose(target.child(self.key(key)),child)
            if not items and value.named_children:self.boundary_refs(value,'unsupported','Initializer lacks statically named owned fields.',target)
            return
        if value.type in self.config.call_types or value.type in {'new_expression','object_creation_expression'}:
            fn=field(value,self.config.call_function_field,'function','constructor','type','name') or (value.named_children[0] if value.named_children else None)
            args=field(value,'arguments') or next((c for c in walk(value) if 'arguments' in c.type or c.type=='argument_list'),None)
            parts=self.member_parts(fn) if fn else None
            receiver=self.expression(parts[0]) if parts else self.expression(field(value,'object'))
            receiver_value=self.canonical(receiver) if receiver else None
            entity=self.facts.entities.get(receiver_value.entity) if receiver_value else None
            callee=self.expression(fn);canonical=self.canonical(callee) if callee else None
            constructor=value.type in {'new_expression','object_creation_expression'} or bool(canonical and self.facts.entities[canonical.entity].kind=='type')
            if receiver and not constructor and entity.kind not in {'type','module'}:
                self.facts.add(receiver,None,'usage',self.anchor(value),'Tracked receiver operation; its result is outside composition scope.')
                if args:self.boundary_refs(args,'usage','Operation argument; result is outside composition scope.')
                self.facts.add(target,None,'usage',self.anchor(value),'Receiver operation result; origins stop here.','origins')
                return
            if args:
                for arg in args.named_children:self.inputs(arg,target,'construction')
            if constructor and callee:
                self.facts.add(callee,target,'construction',self.anchor(value))
                self.constructor_types[target].add(canonical.entity)
                if len(self.constructor_types[target])>1:
                    self.facts.types[target]='';self.facts.add(target,None,'unresolved',self.anchor(value),'Multiple constructor types make value ownership ambiguous.','both')
                else:self.facts.types[target]=canonical.entity
            return
        ref=self.expression(value)
        if ref:self.transfer(ref,target,'wrapping' if target.fields else 'identity',value)
        elif value.type not in LITERALS:self.boundary_refs(value,'unsupported',f'No static composition transfer for syntax {value.type}.',target)

    def inputs(self,node,target,kind):
        if node.type in TRANSPARENT and node.named_children:self.inputs(field(node,'value') or node.named_children[-1],target,kind);return
        ref=self.expression(node)
        if ref:self.transfer(ref,target,kind,node)
        elif self.object_items(node) is not None:
            for _,child in self.object_items(node):
                if child:self.inputs(child,target,kind)
        elif node.type not in LITERALS:self.boundary_refs(node,'unsupported',f'Indirect input syntax {node.type} has no static transfer.',target)

    def collect_occurrences(self):
        occurrences=[]
        for node in walk(self.tree.root_node):
            ref=self.declarations.get((node.start_byte,node.end_byte));parent=node.parent
            if parent and parent.type=='variable_name' and (parent.start_byte,parent.end_byte) in self.declarations:continue
            parts=self.member_parts(parent) if parent else None
            static_key=parts and parts[1]==node and node.type in {'simple_symbol','string','string_literal'}
            named_role=parent and any(parent.child_by_field_name(name)==node for name in ('name','function','method','fun','declarator','bound_identifier')) and re.fullmatch(r'[\w$!?-]+',self.text(node))
            if node.type not in NAMES and not ref and not static_key and not named_role and not (node.type=='word' and self.index.native.reference(self,node)):continue
            if any('comment' in n.type or n.type in LITERALS for n in self.ancestors(node)) and not ref:continue
            if ref is None:ref=self.expression(parent) if parts and parts[1] and (parts[1]==node or parts[1].start_byte<=node.start_byte<parts[1].end_byte) else self.expression(node)
            if ref is None:ref=self.index.native.reference(self,node)
            declaration=(node.start_byte,node.end_byte) in self.declarations
            occurrences.append({'anchor':self.anchor(node),'ref':{'entity':ref.entity,'fields':list(ref.fields)} if ref else None,'name':self.key(node),'reason':'No unambiguous lexical, module or owned-field binding.' if not ref else '', 'declaration':declaration})
            if ref and not declaration:self.facts.add(ref,None,'usage',self.anchor(node),'Source reference; no further composition from this occurrence.')
        self.facts.occurrences[self.path]=occurrences

    def ancestors(self,node):
        parent=node.parent
        while parent:
            yield parent;parent=parent.parent
