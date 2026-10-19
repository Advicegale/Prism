"""Early availability, ordered topic enrichment and retained partial feedback."""
import copy
import threading
import time
import pytest
from fastapi.testclient import TestClient
from prism import app as api, harness, settings
from test_review_batching import make_report, assignments, response_for


def plan_for(report):
    # Model topic array deliberately contradicts route; scheduling must follow route.
    return {'overview': 'Follow the contract into consumers.', 'key_changes': [],
            'review_order': [{'path': f['path'], 'reason': ''} for f in reversed(report['files'])],
            'topics': [{'title': 'First behavior', 'focus': '', 'group_ids': ['g0']},
                       {'title': 'Remaining behavior', 'focus': '', 'group_ids': [g['id'] for g in report['groups'][1:]]}]}


def test_plan_precedes_feedback_and_feedback_follows_frozen_reading_route(monkeypatch, tmp_path):
    report = make_report(3); original = copy.deepcopy(report)
    snapshots = []; calls = []
    def run(*args, **kwargs):
        calls.append(args[3])
        assert kwargs['repository_head'] == report['meta']['head']
        assert kwargs['repository_base'] == report['meta']['merge_base']
        if kwargs.get('required_field') == 'topics':
            assert snapshots == []
            assert 'groups' not in kwargs['schema']['properties']
            return plan_for(report)
        assert snapshots and snapshots[0]['groups'] == []
        assert [t['title'] for t in snapshots[0]['topics']] == ['Remaining behavior', 'First behavior']
        shared = kwargs['repository_context']['ai']
        assert shared['review_order'] == snapshots[0]['review_order']
        assert shared['review_state']['topic_feedback'][0]['status'] in ('running', 'ready')
        items = assignments(args[3])
        if len(calls) == 2: assert [g['group_id'] for g in items] == ['g2', 'g1']
        else:
            assert [g['group_id'] for g in items] == ['g0']
            assert len(shared['groups']) == 2
            assert shared['review_state']['topic_feedback'][0]['status'] == 'ready'
        raw = response_for(items, report)
        raw['topics'] = []  # Detailed passes cannot replace plan or route.
        raw['review_order'] = []
        return raw
    monkeypatch.setattr(harness, 'run_harness', run)
    result = harness.explain_progressively(report, 'codex', '', '', repository_root=tmp_path, publish=snapshots.append)
    assert report == original
    assert len(calls) == 3
    assert len(result['groups']) == 3
    assert result['review_state']['model_calls'] == 3
    assert result['review_state']['feedback_status'] == 'complete'
    assert result['review_state']['pending_symbols'] == []
    assert all(t['status'] == 'ready' for t in result['review_state']['topic_feedback'])
    assert all(s['topics'] == snapshots[0]['topics'] and s['review_order'] == snapshots[0]['review_order'] for s in snapshots)
    assert snapshots[0]['review_state']['topic_feedback'][0]['status'] == 'pending'


def test_later_failure_preserves_plan_and_completed_topic(monkeypatch):
    report = make_report(3); snapshots = []; calls = 0
    def run(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1: return plan_for(report)
        if calls == 3: raise RuntimeError('provider timed out')
        return response_for(assignments(args[3]), report)
    monkeypatch.setattr(harness, 'run_harness', run)
    with pytest.raises(RuntimeError, match='timed out'):
        harness.explain_progressively(report, 'claude', '', '', publish=snapshots.append)
    saved = snapshots[-1]
    assert saved['review_state']['feedback_status'] == 'failed'
    assert [t['status'] for t in saved['review_state']['topic_feedback']] == ['ready', 'failed']
    assert {g['id'] for g in saved['groups']} == {'g1', 'g2'}
    assert saved['review_state']['pending_symbols'] == ['s0-0']
    assert saved['topics'] == snapshots[0]['topics']


def test_large_topic_publishes_completed_batches_before_topic_ready(monkeypatch):
    report = make_report(1, 5); snapshots = []
    monkeypatch.setattr(settings, 'REVIEW_BATCH_SYMBOLS', 2)
    def run(*args, **kwargs):
        if kwargs.get('required_field') == 'topics':
            return dict(plan_for(make_report(2)), topics=[{'title': 'One behavior', 'focus': '', 'group_ids': ['g0']}])
        return response_for(assignments(args[3]), report)
    monkeypatch.setattr(harness, 'run_harness', run)
    result = harness.explain_progressively(report, 'codex', '', '', publish=snapshots.append)
    assert result['review_state']['batch_count'] == 3
    partial = [s for s in snapshots if s['review_state']['topic_feedback'][0]['status'] == 'running' and s['groups']]
    assert [len(s['groups'][0]['changes']) for s in partial] == [2, 4, 5]
    assert result['review_state']['topic_feedback'][0]['status'] == 'ready'


def wait_terminal(job_id):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        job = api.job_info(job_id)
        if job['state'] in ('completed', 'failed'): return job
        time.sleep(.01)
    pytest.fail('job did not terminate')


@pytest.mark.parametrize('fail', [False, True])
def test_running_job_exposes_report_and_questions_run_before_analysis_finishes(monkeypatch, tmp_path, fail):
    monkeypatch.setattr(settings, 'DATA_DIR', tmp_path)
    report = make_report(2); report.update(id='e'*24, demo=False, diff_version=1, topics_version=5, created_at='now', stats={})
    api.save_report(report)
    ready = threading.Event(); release = threading.Event()
    def work(progress):
        progress.report_ready(report['id'])
        ready.set()
        assert release.wait(3)
        if fail: raise RuntimeError('later phase failed')
        return report['id']
    job_id = api._job('analysis', work)['job_id']
    try:
        assert ready.wait(2)
        job = api.job_info(job_id)
        assert job['state'] == 'running' and job['report_id'] == report['id']
        assert api.read_report(report['id'])['analysis']['job_id'] == job_id
        question_id = api._job('question', lambda progress: {'answer': 'While you read'})['job_id']
        assert wait_terminal(question_id)['result']['answer'] == 'While you read'
        assert api.job_info(job_id)['state'] == 'running'
    finally: release.set()
    assert wait_terminal(job_id)['state'] == ('failed' if fail else 'completed')
    saved = api.read_report(report['id'])
    assert saved['analysis']['state'] == ('failed' if fail else 'completed')
    assert saved['ai'] == report['ai']


def test_publication_merges_latest_report_fields_and_retains_guide_on_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, 'DATA_DIR', tmp_path)
    report = make_report(2); report['id'] = 'd'*24
    api.save_report(report)
    def run(report, *args, publish, **kwargs):
        current = api.read_report(report['id']); current['architecture'] = {'new': True}; api.save_report(current)
        publish({'overview': 'Early plan', 'topics': [], 'groups': []})
        current = api.read_report(report['id'])
        assert current['architecture'] == {'new': True}
        assert current['ai']['overview'] == 'Early plan'
        raise RuntimeError('stop')
    monkeypatch.setattr(api, 'explain', run)
    with pytest.raises(RuntimeError, match='stop'):
        api._generate_guide(report, api.ExplainRequest(harness='codex'), lambda _: None, tmp_path)
    saved = api.read_report(report['id'])
    assert saved['ai']['overview'] == 'Early plan'
    assert saved['previous_ai'][-1]['ai'] == report['ai']


def test_restart_marks_interruption_without_discarding_saved_feedback(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, 'DATA_DIR', tmp_path)
    report = make_report(2)
    report.update(id='c'*24, demo=False, diff_version=1, topics_version=5,
                  analysis={'state': 'running', 'job_id': 'not-in-this-process'})
    report['ai']['review_state'] = {'feedback_status': 'running', 'topic_feedback': [{'topic_id': 'topic', 'status': 'running'}]}
    api.save_report(report)
    monkeypatch.setattr(api, 'ensure_architecture', lambda data: data)
    monkeypatch.setattr(api, 'ensure_evidence', lambda data: data)
    monkeypatch.setattr(api.exploration, 'prefetch', lambda data: None)
    result = TestClient(api.app).get('/api/reports/'+report['id']).json()
    assert result['analysis']['state'] == 'failed'
    assert 'interrupted' in result['analysis']['error']
    assert result['ai']['overview'] == report['ai']['overview']
    assert result['ai']['review_state']['feedback_status'] == 'failed'
    assert result['ai']['review_state']['topic_feedback'][0]['status'] == 'failed'


def test_invalid_plan_uses_ordered_complete_fallback_without_skipping_feedback(monkeypatch):
    report = make_report(3)
    def run(*args, **kwargs):
        if kwargs.get('required_field') == 'topics':
            return dict(plan_for(report), topics=[{'title': 'Incomplete plan', 'focus': '', 'group_ids': ['g0']}])
        return response_for(assignments(args[3]), report)
    monkeypatch.setattr(harness, 'run_harness', run)
    result = harness.explain_progressively(report, 'codex', '', '')
    assert result['topic_diagnostics']['source'] == 'paths'
    assert 'missing_groups' in result['topic_diagnostics']['issues']
    assert {g['id'] for g in result['groups']} == {'g0', 'g1', 'g2'}
    assert result['review_state']['feedback_status'] == 'complete'
