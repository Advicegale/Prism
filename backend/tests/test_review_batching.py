"""Whole-PR call topology, bounded large-PR outputs, and preservation of guide data."""
import copy
import json
import pytest
from prism import harness, settings


def make_report(count=36, symbols=1):
    groups = []
    for index in range(count):
        nodes = [{'id': f's{index}-{i}', 'path': f'file{index}.py', 'label': f'function{i}',
                  'line': i + 1, 'end': i + 1, 'status': 'modified', 'kind': 'function'} for i in range(symbols)]
        groups.append({'id': f'g{index}', 'title': f'Group {index}', 'files': [f'file{index}.py'],
                       'changed_ids': [n['id'] for n in nodes], 'graph': {'nodes': nodes, 'edges': []}})
    return {'meta': {'title': 'Change two related flows', 'body': '', 'head': 'a' * 40, 'merge_base': 'b' * 40},
            'files': [{'path': f'file{i}.py', 'old_path': f'file{i}.py', 'patch': '', 'status': 'modified'} for i in range(count)],
            'groups': groups, 'evidence': {}, 'overview': {'nodes': [], 'edges': []},
            'architecture': {'layers': [{'id': 'flow', 'title': 'Shared behavior'}]},
            'ai': {'overview': 'Existing guide'}}


def assignments(prompt):
    payload = json.loads(prompt.rsplit('GROUPS:\n', 1)[1])
    return payload if isinstance(payload, list) else [payload]


def response_for(items, report):
    return {'overview': 'Two related flows share a changed contract.', 'key_changes': [],
            'review_order': [{'path': f['path'], 'reason': 'Establish context'} for f in reversed(report['files'])],
            'topics': [{'title': 'Shared contract', 'focus': 'Understand how the consumers use the contract.',
                        'group_ids': [g['id'] for g in report['groups']]}],
            'groups': [{'id': item['group_id'], 'summary': '', 'before_after': '', 'impact': '',
                        'review_order': [], 'risks': [], 'tests': [],
                        'changes': [{'symbol_id': node['symbol']['id'], 'diff_summary': 'Changed behavior.',
                                     'why': '', 'review_notes': ['Understand this boundary.']}
                                    for node in item['changed_symbols']]} for item in items]}


def test_many_groups_use_one_guide_call_and_keep_global_plan(monkeypatch, tmp_path):
    report = make_report(); calls = []
    def run(*args, **kwargs):
        calls.append((args[3], kwargs))
        items = assignments(args[3])
        assert len(items) == 36
        assert 'complete whole-PR guide in this single response' in args[3]
        assert 'return topics as an empty array' not in args[3]
        assert kwargs['repository_context']['architecture'] == report['architecture']
        assert kwargs['repository_head'] == report['meta']['head']
        return response_for(items, report)
    monkeypatch.setattr(harness, 'run_harness', run)
    result = harness.explain(report, 'codex', 'default', 'low', repository_root=tmp_path)
    assert len(calls) == 1
    assert len(result['groups']) == 36
    assert len(result['review_order']) == 36
    assert result['review_order'][0]['path'] == 'file35.py'
    assert result['topics'][0]['source'] == 'ai'
    assert set(result['topics'][0]['group_ids']) == {g['id'] for g in report['groups']}
    state = result['review_state']
    assert state['strategy'] == 'whole_pr' and state['model_calls'] == state['batch_count'] == 1
    assert state['timings'][0]['groups'] == 36 and state['timings'][0]['symbols'] == 36
    assert state['elapsed_seconds'] >= 0 and state['timings'][0]['seconds'] >= 0


def test_oversized_group_is_split_and_all_explanations_survive_synthesis(monkeypatch, tmp_path):
    report = make_report(2, 7)
    monkeypatch.setattr(settings, 'REVIEW_BATCH_SYMBOLS', 3)
    calls = []; observed = []; contexts = []
    def run(*args, **kwargs):
        prompt = args[3]; calls.append(prompt); contexts.append(copy.deepcopy(kwargs['repository_context']))
        if prompt.startswith('Synthesize'):
            all_groups = contexts[-1]['review_state']['groups']
            assert len(all_groups) == 2 and sum(len(g['changes']) for g in all_groups) == 14
            assert 'before state' in prompt
            return response_for([], report)
        items = assignments(prompt)
        ids = [n['symbol']['id'] for item in items for n in item['changed_symbols']]
        assert len(ids) <= 3 and len({i['group_id'] for i in items}) == len(items)
        observed.extend(ids)
        result = response_for(items, report)
        for g in result['groups']:
            g['risks'] = [f'Concrete boundary {len(calls)}']
            g['before_after'] = f'before state {len(calls)} to changed state'
        return result
    monkeypatch.setattr(harness, 'run_harness', run)
    result = harness.explain(report, 'claude', '', '', repository_root=tmp_path)
    expected = [s for g in report['groups'] for s in g['changed_ids']]
    assert sorted(observed) == sorted(expected) and len(observed) == len(set(observed))
    assert [len(g['changes']) for g in result['groups']] == [7, 7]
    assert sum(len(g['risks']) for g in result['groups']) == len(calls) - 1
    assert sum('before state' in g['before_after'] for g in result['groups']) == 2
    assert result['review_state']['strategy'] == 'batched'
    assert result['review_state']['model_calls'] == result['review_state']['batch_count'] + 1 == len(calls)
    assert len(contexts[1]['review_state']['groups'][0]['changes']) == 3
    assert len(contexts[1]['review_state']['pending_symbols']) == 11
    assert len(result['topics'][0]['files']) == 2


def test_size_bounded_inputs_keep_every_assignment(monkeypatch):
    report = make_report(6)
    for group in report['groups']: group['graph']['nodes'][0]['label'] = 'x' * 600
    monkeypatch.setattr(settings, 'MAX_DIFF_CHARS', 2400)
    batches = harness.review_batches(report)
    assert len(batches) > 1
    seen = []
    for batch in batches:
        prompt = harness.build_prompt(report, batch, True, whole_pr=False)
        assert len(prompt.rsplit('GROUPS:\n', 1)[1]) <= 2400
        seen += [s['symbol']['id'] for item in assignments(prompt) for s in item['changed_symbols']]
    assert seen == [s for g in report['groups'] for s in g['changed_ids']]


@pytest.mark.parametrize('fault', ['missing_group', 'missing_symbol', 'duplicate_group', 'duplicate_symbol'])
def test_incomplete_response_does_not_trigger_hidden_extra_calls_or_replace_guide(monkeypatch, fault):
    report = make_report(2); before = copy.deepcopy(report); calls = []
    def run(*args, **kwargs):
        calls.append(args[3]); result = response_for(assignments(args[3]), report)
        if fault == 'missing_group': result['groups'].pop()
        elif fault == 'missing_symbol': result['groups'][0]['changes'] = []
        elif fault == 'duplicate_group': result['groups'].append(result['groups'][0])
        else: result['groups'][0]['changes'].append(result['groups'][0]['changes'][0])
        return result
    monkeypatch.setattr(harness, 'run_harness', run)
    with pytest.raises(RuntimeError, match='Incomplete review response|Duplicate review group|Duplicate review symbol'):
        harness.explain(report, 'codex', '', '')
    assert len(calls) == 1 and report == before


def test_invalid_or_impossible_budget_fails_before_model(monkeypatch):
    report = make_report(1)
    monkeypatch.setattr(harness, 'run_harness', lambda *a, **kw: pytest.fail('provider should not start'))
    monkeypatch.setattr(settings, 'REVIEW_BATCH_SYMBOLS', 0)
    with pytest.raises(RuntimeError, match='positive'): harness.explain(report, 'codex', '', '')
    monkeypatch.setattr(settings, 'REVIEW_BATCH_SYMBOLS', 100)
    monkeypatch.setattr(settings, 'MAX_DIFF_CHARS', 1)
    with pytest.raises(RuntimeError, match='mandatory review assignment'): harness.explain(report, 'codex', '', '')


def test_compacted_oversized_group_splits_by_metadata_without_losing_ids(monkeypatch):
    report = make_report(1, 12)
    for node in report['groups'][0]['graph']['nodes']: node['label'] = 'a' * 700
    monkeypatch.setattr(settings, 'MAX_DIFF_CHARS', 2700)
    batches = harness.review_batches(report)
    assert len(batches) > 1
    assert [s for batch in batches for group in batch for s in group['changed_ids']] == report['groups'][0]['changed_ids']
    assert all(len(harness.build_prompt(report, batch).rsplit('GROUPS:\n', 1)[1]) <= 2700 for batch in batches)
