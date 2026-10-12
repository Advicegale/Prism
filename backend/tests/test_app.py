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
