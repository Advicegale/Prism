from fastapi.testclient import TestClient
from prism.app import app

client=TestClient(app)

def test_health():
    assert client.get('/api/health').json()['port']==4780

def test_demo_contains_segments():
    result=client.get('/api/demo')
    assert result.status_code==200
    data=result.json()
    assert data['demo'] is True
    assert len(data['groups'])>=2
    assert data['overview']['nodes']

def test_invalid_pr_returns_error():
    result=client.post('/api/analyze',json={'url':'https://google.com/this-is-not-a-pull-request'})
    assert result.status_code==400 or result.status_code==422

def test_cross_site_post_rejected():
    result=client.post('/api/analyze',headers={'Origin':'https://evil.example'},json={'url':'https://github.com/a/b/pull/1'})
    assert result.status_code==403


def test_store_ai_sets_top_level_topics_from_a_nonempty_ai_plan():
    from prism.app import _store_ai
    report={"topics":[{"title":"Path"}],"topics_version":4,"ai":None}
    _store_ai(report,{"topics":[{"title":"AI plan"}],"overview":"x"})
    assert report["ai"]["overview"]=="x"
    assert report["topics"]==[{"title":"AI plan"}]
    assert report["topics_version"]==5


def test_store_ai_keeps_stored_topics_when_the_ai_plan_is_empty():
    from prism.app import _store_ai
    report={"topics":[{"title":"Path"}],"topics_version":5,"ai":None}
    _store_ai(report,{"topics":[],"overview":""})
    assert report["ai"]=={"topics":[],"overview":""}
    assert report["topics"]==[{"title":"Path"}]


def test_ensure_topics_does_not_overwrite_a_v5_ai_plan(monkeypatch):
    from prism import app as api
    monkeypatch.setattr(api,"save_report",lambda report:(_ for _ in ()).throw(AssertionError("saved")))
    ai_topics=[{"title":"AI plan","focus":"","source":"ai","files":[],"group_ids":["g1"]}]
    report={"topics_version":5,"topics":ai_topics,"ai":{"topics":ai_topics},"groups":[],"overview":{}}
    api.ensure_topics(report)
    assert report["ai"]["topics"] is ai_topics and report["topics"] is ai_topics
