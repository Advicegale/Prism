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


def test_question_prompt_uses_the_same_topics_as_the_ui():
    report = {"meta": {"title": "T"}, "files": [], "groups": [], "evidence": {},
              "topics": [{"title": "Stored plan", "focus": "", "files": []}],
              "ai": {"topics": [{"title": "AI plan", "focus": "", "files": []}]}}
    prompt, _sources = harness.build_question_prompt(report, "what changed?")
    assert "AI plan" in prompt and "Stored plan" not in prompt
    report["ai"]["topics"] = []
    prompt, _sources = harness.build_question_prompt(report, "what changed?")
    assert "Stored plan" in prompt


def _summary_set(symbols=3, text=400):
    return [
        {"group_id": f"g{g}", "structural_title": f"Group {g}", "changed_symbol_ids": [f"g{g}-s{s}" for s in range(symbols)],
         "files": [f"f{g}.py"], "summary": "S" * 10, "review_order": [], "impact": "", "risks": [], "tests": [],
         "diff_summaries": [{"symbol_id": f"g{g}-s{s}", "summary": "d" * text} for s in range(symbols)]}
        for g in range(3)
    ]


def test_fit_summaries_is_untouched_when_it_already_fits():
    items = _summary_set(symbols=1, text=10)
    fitted, shrunk = harness._fit_summaries(items, 100000)
    assert shrunk is False
    assert fitted == items


def test_fit_summaries_drops_symbol_ids_first():
    items = _summary_set()
    without_ids = [{key: value for key, value in item.items() if key != "changed_symbol_ids"} for item in items]
    limit = len(json.dumps(without_ids, ensure_ascii=False))
    fitted, shrunk = harness._fit_summaries(items, limit)
    assert shrunk is True
    assert all("changed_symbol_ids" not in item for item in fitted)
    assert all(len(d["summary"]) == 400 for item in fitted for d in item["diff_summaries"])


def test_fit_summaries_shortens_symbol_summaries_before_dropping_any_group_detail():
    items = _summary_set(symbols=3, text=400)
    stripped = [{key: value for key, value in item.items() if key != "changed_symbol_ids"} for item in items]
    limit = len(json.dumps([dict(item, diff_summaries=[dict(d, summary="d" * 300) for d in item["diff_summaries"]])
                            for item in stripped], ensure_ascii=False))
    fitted, shrunk = harness._fit_summaries(items, limit)
    assert shrunk is True
    assert all(len(d["summary"]) == 300 for item in fitted for d in item["diff_summaries"])
    assert all(len(item["diff_summaries"]) == 3 for item in fitted)


def test_fit_summaries_drops_details_from_the_end_and_keeps_every_group():
    items = _summary_set(symbols=2, text=400)
    # One byte under the size after every per-symbol summary has been shortened to 120 chars.
    shortened = [dict(item, diff_summaries=[dict(d, summary="d" * 120) for d in item["diff_summaries"]])
                 for item in items]
    shortened = [{key: value for key, value in item.items() if key != "changed_symbol_ids"} for item in shortened]
    fitted, shrunk = harness._fit_summaries(items, len(json.dumps(shortened, ensure_ascii=False)) - 1)
    assert shrunk is True
    assert [item["group_id"] for item in fitted] == ["g0", "g1", "g2"]
    assert all(item["summary"] == "S" * 10 for item in fitted)
    # The earliest groups keep their detail while the trailing groups lose it first.
    assert fitted[0]["diff_summaries"] and not fitted[-1]["diff_summaries"]


def test_fit_summaries_output_is_valid_json_with_every_group_at_tiny_limits():
    items = _summary_set()
    for limit in (0, 1, 50, 300):
        fitted, shrunk = harness._fit_summaries(items, limit)
        parsed = json.loads(json.dumps(fitted, ensure_ascii=False))
        assert [item["group_id"] for item in parsed] == ["g0", "g1", "g2"]
        assert shrunk is True
    assert items[0]["changed_symbol_ids"] == ["g0-s0", "g0-s1", "g0-s2"]


def _explain_report():
    def group(index):
        nodes = [{"id": f"s{index}", "label": f"Sym{index}", "path": f"f{index}.py", "kind": "function",
                  "status": "modified", "line": 1, "end": 2}]
        return {"id": f"g{index}", "title": f"Group {index}", "changed_ids": [f"s{index}"], "files": [f"f{index}.py"],
                "graph": {"nodes": nodes, "edges": []}}
    return {"meta": {"title": "T", "body": ""}, "groups": [group(0), group(1)], "overview": {"nodes": [], "edges": []},
            "files": [], "evidence": {}}


def _group_result(group_id):
    return {"id": group_id, "summary": "", "before_after": "", "impact": "", "risks": [], "tests": [],
            "review_order": [], "changes": [{"symbol_id": group_id.replace("g", "s"), "diff_summary": "Changed.",
                                            "why": "", "review_notes": []}]}


def test_explain_records_topic_diagnostics_for_ai_and_fallback(monkeypatch):
    prompts = []
    def fake_harness(harness_name, model, effort, prompt):
        prompts.append(prompt)
        if "Synthesize" in prompt:
            return {"overview": "", "key_changes": [], "review_order": [], "groups": [],
                    "topics": [{"title": "Only one", "focus": "", "group_ids": ["g0"]}]}
        return {"overview": "", "key_changes": [], "review_order": [], "topics": [],
                "groups": [_group_result("g0")]} if "g0" in prompt and "g1" not in prompt else \
               {"overview": "", "key_changes": [], "review_order": [], "topics": [],
                "groups": [_group_result("g1")]}
    monkeypatch.setattr(harness, "run_harness", fake_harness)
    result = harness.explain(_explain_report(), "codex", "", "")
    assert result["topic_diagnostics"] == {"source": "paths", "issues": ["missing_groups"], "appended_paths": 0}
    assert [topic["source"] for topic in result["topics"]] == ["paths"]
    assert len(prompts) == 3


def test_explain_synthesis_prompt_notes_shortened_input(monkeypatch):
    prompts = []
    def fake_harness(harness_name, model, effort, prompt):
        prompts.append(prompt)
        if "Synthesize" in prompt:
            return {"overview": "", "key_changes": [], "review_order": [], "groups": [], "topics": []}
        group_id = "g0" if "g0" in prompt else "g1"
        return {"overview": "", "key_changes": [], "review_order": [], "topics": [], "groups": [_group_result(group_id)]}
    monkeypatch.setattr(harness, "run_harness", fake_harness)
    monkeypatch.setattr(harness.settings, "MAX_DIFF_CHARS", 40)
    harness.explain(_explain_report(), "codex", "", "")
    synthesis = prompts[-1]
    assert "Some per-symbol summaries were shortened to fit; use only what is supplied." in synthesis
    assert '"group_id": "g0"' in synthesis and '"group_id": "g1"' in synthesis
