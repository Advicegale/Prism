"""Persist exact viewability/finalization milestones independently of guide-only timing."""
import pytest
from prism import app as api, settings


class ImmediateExecutor:
    def submit(self, work): work()


@pytest.mark.parametrize('fail,review_requested', [(False, True), (True, True), (False, False)])
def test_analysis_times_viewability_and_complete_pipeline(monkeypatch,tmp_path,fail,review_requested):
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path)
    monkeypatch.setattr(api,'executor',ImmediateExecutor())
    clock=[100.0];monkeypatch.setattr(api.time,'monotonic',lambda:clock[0])
    report={'id':'a'*24,'ai':{'overview':'Preserve guide'},'architecture':{'method':'manifest'}}
    api.save_report(report)
    def work(progress):
        clock[0]=105.0 # includes metadata/Git/changed declarations
        progress.report_ready(report['id'])
        saved=api.read_report(report['id'])
        assert saved['analysis_timings']['graph_seconds']==5
        assert saved['analysis_timings']['review_status']==('running' if review_requested else 'not_requested')
        clock[0]=125.0 # guide plus architecture work
        if fail: raise RuntimeError('architecture failed')
        return report['id']
    job_id=api._job('analysis',work,review_requested=review_requested)['job_id']
    saved=api.read_report(report['id']);timing=saved['analysis_timings']
    assert saved['ai']==report['ai']
    assert timing['graph_seconds']==5
    if fail:
        assert timing['review_status']=='failed' and timing['review_seconds']==20
        assert 'completed_at' not in timing and 'total_seconds' not in timing
    else:
        assert timing['total_seconds']==25 and timing['completed_at']
        if review_requested: assert timing['review_seconds']==20 and timing['review_status']=='completed'
        else: assert timing['review_status']=='not_requested' and 'review_seconds' not in timing
    assert api.job_info(job_id)['state']==('failed' if fail else 'completed')


def test_regeneration_retains_graph_duration_and_excludes_idle_wait(monkeypatch,tmp_path):
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path)
    monkeypatch.setattr(api,'executor',ImmediateExecutor())
    clock=[1000.0];monkeypatch.setattr(api.time,'monotonic',lambda:clock[0])
    report={'id':'b'*24,'analysis_timings':{'graph_seconds':8,'review_seconds':30,'total_seconds':38,'review_status':'completed'}}
    api.save_report(report)
    def work(progress):
        progress.report_ready(report['id'])
        assert api.read_report(report['id'])['analysis_timings']['review_status']=='running'
        clock[0]+=15
        return report['id']
    api._job('explanation',work)
    timing=api.read_report(report['id'])['analysis_timings']
    assert timing['graph_seconds']==8 and timing['review_seconds']==15
    assert timing['review_kind']=='regenerated' and timing['review_status']=='completed'


def test_architecture_only_job_does_not_replace_analysis_timings(monkeypatch,tmp_path):
    monkeypatch.setattr(settings,'DATA_DIR',tmp_path)
    monkeypatch.setattr(api,'executor',ImmediateExecutor())
    report={'id':'c'*24,'analysis_timings':{'graph_seconds':8,'review_seconds':30,'total_seconds':38,'review_status':'completed'}}
    api.save_report(report)
    def work(progress):
        progress.report_ready(report['id'])
        return report['id']
    api._job('architecture',work)
    assert api.read_report(report['id'])['analysis_timings']==report['analysis_timings']
