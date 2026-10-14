"""Regressions derived from the failures in retained preview PRs.

Run setup.sh (or install-parser-fixes.py) to install the corrected grammars.
All fixtures are parsed as passive source, never compiled or executed.
"""
import pytest
from prism.exploration.analyzer import analyze, walk
from prism.exploration.graphify_adapter import parse
from prism.exploration.query import Index
from test_exploration import SHA, select, complete


@pytest.mark.parametrize('extension',['js','jsx','tsx'])
@pytest.mark.parametrize('text',[
    'Repeat & reminder', '& reminder', 'A & B & C', 'A&b',
    'A &amp; B &#38; C &#x26; D &unknown; E & F',
    'Português 🐱 & lembrete\r\nnext line',
])
def test_jsx_text_preserves_original_bytes_and_bindings(extension,text):
    path='screen.'+extension
    code=f'export const channel = assemble(4);\r\nconst panel = <><Text>{text}</Text>{{channel}}</>;\r\nexport const wrapper = {{ wire: channel }};\r\n'
    index=Index(analyze({path:code},SHA))
    assert index.facts.coverage['complete'],index.facts.coverage
    assert index.facts.sources[path]==code
    chosen=select(index,path,'channel',1)
    assert chosen['status']=='resolved'
    result=complete(index,chosen['root'])
    assert any(s['name']=='wrapper.wire' for n in result['nodes'] for s in n['symbols'])
    for occurrence in index.facts.occurrences[path]:
        anchor=occurrence['anchor']
        assert code.encode()[anchor['start_byte']:anchor['end_byte']].decode()==occurrence['name']
    prefix=code[:code.index(text)]
    assert index.select(path,prefix.count('\n')+1,len(prefix.rsplit('\n',1)[-1].encode('utf-16-le'))//2)['status']=='ignored'


SQL_CASES=[
    'DROP TRIGGER IF EXISTS member_clear ON public.member CASCADE;',
    'INSERT INTO calendar_participants (id) VALUES (1) ON CONFLICT (id) DO NOTHING;',
    'INSERT INTO calendar_participants (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = excluded.id;',
    'DELETE FROM calendar_participants participant USING calendar_blocks block WHERE participant.block_id = block.id;',
    'DELETE FROM calendar_participants AS participant USING calendar_blocks AS block WHERE participant.block_id = block.id;',
    "SELECT DISTINCT ON (job.household_id, job.mutation_id) 'legacy-' || md5(job.id) FROM jobs job;",
    'CREATE TABLE rooms (name text CHECK (length(btrim(name)) BETWEEN 1 AND 160));',
    'CREATE TABLE notes (name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160), text text);',
    'CREATE TABLE shares (percentage integer CHECK (percentage BETWEEN 1 AND 100), CHECK ((a IS NOT NULL)::integer + (b IS NOT NULL)::integer = 1));',
    'SELECT coalesce(array_agg(DISTINCT bill.id), ARRAY[]::text[]) FROM household_bills bill;',
    'SELECT ARRAY[1, 2], ARRAY(SELECT id FROM jobs);',
    'CREATE TABLE flags (active boolean CHECK (active));',
]


@pytest.mark.parametrize('statement',SQL_CASES)
def test_postgresql_constructs_keep_following_declarations(statement):
    code=statement+'\nCREATE TABLE helper (id INTEGER PRIMARY KEY);\n'
    tree,_=parse(code.encode(),'.sql')
    assert not tree.root_node.has_error,tree.root_node
    index=Index(analyze({'migration.sql':code},SHA))
    assert index.facts.coverage['complete'],index.facts.coverage
    chosen=select(index,'migration.sql','helper')
    assert chosen['status']=='resolved'
    anchor=chosen['root']['definition']
    assert code.encode()[anchor['start_byte']:anchor['end_byte']]==b'helper'


@pytest.mark.parametrize('lhs',['*(destination + i)','*destination','*(destination + i + 1)'])
def test_csharp_pointer_assignment_tree_and_memory_boundary(lhs):
    code=f'class Serializer {{ public static unsafe void WriteFixed(byte* destination, byte[] source, int i) {{ {lhs} = source[i]; }} }}'
    tree,_=parse(code.encode(),'.cs')
    assert not tree.root_node.has_error,tree.root_node
    assignment=next(n for n in walk(tree.root_node) if n.type=='assignment_expression')
    left=assignment.child_by_field_name('left');right=assignment.child_by_field_name('right')
    assert code.encode()[left.start_byte:left.end_byte].decode()==lhs
    assert code.encode()[right.start_byte:right.end_byte]==b'source[i]'
    index=Index(analyze({'Serializer.cs':code},SHA))
    assert index.facts.coverage['complete'],index.facts.coverage
    source=select(index,'Serializer.cs','source');assert source['status']=='resolved'
    result=complete(index,source['root'])
    assert not any(s['name']=='destination' for n in result['nodes'] for s in n['symbols'])
    assert any('memory-alias' in b['reason'] for b in result['boundaries'])


@pytest.mark.parametrize('extension,code',[
    ('tsx','const panel = <Text>Repeat & reminder {broken + }</Text>;'),
    ('jsx','const panel = <Text>A & B</Text>; const broken = ;'),
    ('sql','CREATE TABLE broken (id INTEGER CHECK (id BETWEEN 1 AND));'),
    ('sql','DROP TRIGGER missing_table ON;'),
    ('sql','DELETE FROM participants USING WHERE id = 1;'),
    ('cs','class S { unsafe void F(byte* d) { *(d + 1) = ; } }'),
])
def test_real_parser_failures_remain_explicit(extension,code):
    tree,_=parse(code.encode(),'.'+extension)
    assert tree.root_node.has_error
    index=Index(analyze({'broken.'+extension:code},SHA))
    assert not index.facts.coverage['complete']
    assert any('Parser could not fully analyze this syntax' in row['reason'] for row in index.facts.coverage['omitted'])
