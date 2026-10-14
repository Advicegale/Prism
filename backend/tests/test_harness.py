import json
from pathlib import Path
from types import SimpleNamespace
from prism import harness


def structured():
    return {"overview":"Changed service dependency", "key_changes":["Uses validator"],
            "groups":[{"id":"test","summary":"A","before_after":"B","impact":"C","risks":[],"tests":[]}]}


def test_codex_invocation_uses_readonly_sandbox(monkeypatch):
    monkeypatch.setattr(harness.shutil,'which',lambda cmd:'/fake/codex')
    def fake_run(args,**kwargs):
        assert args[1:4] == ['exec','--sandbox','read-only']
        assert '--output-schema' in args and '--output-last-message' in args
        assert args[-1]=='-'
        assert kwargs['input']=='Review this change'
        Path(args[args.index('--output-last-message')+1]).write_text(json.dumps(structured()))
        return SimpleNamespace(returncode=0,stdout='',stderr='')
    monkeypatch.setattr(harness.subprocess,'run',fake_run)
    result=harness.run_harness('codex','default','high','Review this change')
    assert result['groups'][0]['id']=='test'


def test_claude_disables_tools(monkeypatch):
    monkeypatch.setattr(harness.shutil,'which',lambda cmd:'/fake/claude')
    def fake_run(args,**kwargs):
        assert args[1]=='-p'
        assert '--tools' in args and args[args.index('--tools')+1]==''
        assert '--permission-mode' in args and args[args.index('--permission-mode')+1]=='plan'
        assert kwargs['cwd']
        return SimpleNamespace(returncode=0,stdout=json.dumps({'structured_output':structured()}),stderr='')
    monkeypatch.setattr(harness.subprocess,'run',fake_run)
    result=harness.run_harness('claude','default','default','Review this change')
    assert result['overview']=='Changed service dependency'
