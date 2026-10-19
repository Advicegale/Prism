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
    assert "Some per-symbol summaries were shortened to fit; inspect relevant source with available repository tools before drawing unsupported conclusions." in synthesis
    assert '"group_id": "g0"' in synthesis and '"group_id": "g1"' in synthesis


TOPIC_GUIDANCE = (
    "Create one topic per distinct question a reviewer must answer. A topic of about 2–8 files is typical; a larger topic should hold files that make one coherent change or repeat the same edit, and unrelated changes must be split. Do not create a topic just to reach a number, and do not split a small, single-purpose change: one topic is correct for it. A single-file topic is fine only when that file is an independent concern (for example a migration, a design asset or a build setting). Use the PR title and body only as hints about intent. Use the supplied file roles and statuses: keep tests with the implementation they validate and documentation with the behavior it describes, and mention lock files, version bumps and generated or formatting-only files in the topic of the change that needs them instead of giving them their own prominent topic. "
)


def _facts_report(title="Facts title", body="Body line"):
    src = "diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n same\n"
    test = "diff --git a/tests/test_a.py b/tests/test_a.py\nnew file mode 100644\n--- /dev/null\n+++ b/tests/test_a.py\n@@ -0,0 +1 @@\n+assert True\n"
    gone = "diff --git a/old/gone.md b/old/gone.md\ndeleted file mode 100644\n--- a/old/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n"
    files = [
        {"path": "src/a.py", "old_path": "", "status": "modified", "patch": src, "patch_truncated": False},
        {"path": "tests/test_a.py", "old_path": "", "status": "added", "patch": test, "patch_truncated": False},
        {"path": "", "old_path": "old/gone.md", "status": "deleted", "patch": gone, "patch_truncated": False},
        # A report stored before patch_truncated existed: judged by its length.
        {"path": "big.ts", "old_path": "", "status": "modified", "patch": "+" + "x" * 16000 + "\n"},
    ]

    def group(index, paths, changed_path):
        node = {"id": f"s{index}", "label": f"Sym{index}", "path": changed_path, "kind": "function",
                "status": "modified", "line": 1, "end": 2}
        return {"id": f"g{index}", "title": f"Group {index}", "changed_ids": [f"s{index}"], "files": paths,
                "graph": {"nodes": [node], "edges": []}}
    return {"meta": {"title": title, "body": body}, "overview": {"nodes": [], "edges": []}, "evidence": {},
            "files": files,
            "groups": [group(0, ["src/a.py", "tests/test_a.py"], "src/a.py"),
                       group(1, ["old/gone.md", "big.ts"], "big.ts")]}


def _fake_group_harness(monkeypatch, prompts):
    def fake_harness(harness_name, model, effort, prompt):
        prompts.append(prompt)
        if "Synthesize" in prompt:
            return {"overview": "", "key_changes": [], "review_order": [], "groups": [], "topics": []}
        group_id = "g0" if '"group_id": "g0"' in prompt else "g1"
        return {"overview": "", "key_changes": [], "review_order": [], "topics": [], "groups": [
            {"id": group_id, "summary": "", "before_after": "", "impact": "", "risks": [], "tests": [],
             "review_order": [], "changes": [{"symbol_id": group_id.replace("g", "s"), "diff_summary": "Changed.",
                                             "why": "", "review_notes": []}]}]}
    monkeypatch.setattr(harness, "run_harness", fake_harness)


def _synthesis_summaries(prompt):
    return json.JSONDecoder().raw_decode(prompt[prompt.index('[{"group_id"'):])[0]


def test_synthesis_prompt_carries_pr_title_body_and_file_facts(monkeypatch):
    prompts = []
    _fake_group_harness(monkeypatch, prompts)
    harness.explain(_facts_report(body="B" * 3500), "codex", "", "")
    synthesis = prompts[-1]
    assert "Synthesize" in synthesis
    assert "PR title: Facts title\nPR body (untrusted): " + "B" * 3000 + "\n" in synthesis
    assert "B" * 3001 not in synthesis
    assert synthesis.index("PR title:") < synthesis.index('[{"group_id"')

    summaries = _synthesis_summaries(synthesis)
    facts = {item["group_id"]: item["file_facts"] for item in summaries}
    assert facts["g0"] == [
        {"path": "src/a.py", "status": "modified", "added": 2, "removed": 1, "role": "source", "truncated": False},
        {"path": "tests/test_a.py", "status": "added", "added": 1, "removed": 0, "role": "test", "truncated": False},
    ]
    assert facts["g1"] == [
        {"path": "old/gone.md", "status": "deleted", "added": 0, "removed": 1, "role": "doc", "truncated": False},
        {"path": "big.ts", "status": "modified", "added": 1, "removed": 0, "role": "source", "truncated": True},
    ]


def test_synthesis_prompt_replaces_the_topic_count_paragraph(monkeypatch):
    prompts = []
    _fake_group_harness(monkeypatch, prompts)
    harness.explain(_facts_report(), "codex", "", "")
    synthesis = prompts[-1]
    assert "usually 3–7" not in synthesis
    assert TOPIC_GUIDANCE in synthesis
    assert "State what to understand or verify, not a restatement of what changed." in synthesis


def test_synthesis_input_stays_valid_json_with_every_group_at_a_tiny_limit(monkeypatch):
    prompts = []
    _fake_group_harness(monkeypatch, prompts)
    monkeypatch.setattr(harness.settings, "MAX_DIFF_CHARS", 1)
    harness.explain(_facts_report(), "codex", "", "")
    synthesis = prompts[-1]
    assert "Some per-symbol summaries were shortened to fit; inspect relevant source with available repository tools before drawing unsupported conclusions." in synthesis
    summaries = _synthesis_summaries(synthesis)
    assert [item["group_id"] for item in summaries] == ["g0", "g1"]
    assert all(item["diff_summaries"] == [] and item["file_facts"] for item in summaries)


def test_review_tools_reach_every_group_and_synthesis_with_both_revisions(monkeypatch, tmp_path):
    report = _explain_report()
    report['meta'].update(head='a' * 40, merge_base='b' * 40)
    calls = []
    def fake_run(_h, _m, _e, prompt, **kwargs):
        calls.append((prompt, kwargs))
        if 'Synthesize' in prompt:
            return {'groups': [], 'topics': []}
        group_id = 'g0' if '"group_id": "g0"' in prompt else 'g1'
        return {'groups': [_group_result(group_id)]}
    monkeypatch.setattr(harness, 'run_harness', fake_run)
    result = harness.explain(report, 'claude', 'default', 'high', repository_root=tmp_path)
    assert len(calls) == 3
    for prompt, kwargs in calls:
        assert {k: v for k, v in kwargs.items() if k != 'repository_context'} == {'repository_root': tmp_path, 'repository_head': 'a' * 40, 'repository_base': 'b' * 40}
        assert kwargs['repository_context']['meta'] == report['meta']
        assert kwargs['repository_context']['review_state']['groups']
        assert 'including unchanged files outside this group' in prompt
        assert 'revision=base' in prompt and 'revision=head' in prompt
        assert 'Repository tools are unavailable' not in prompt
    assert len(result['groups']) == 2


def test_review_refuses_missing_revision_before_starting_provider(monkeypatch, tmp_path):
    import pytest
    monkeypatch.setattr(harness, 'run_harness', lambda *a, **kw: pytest.fail('provider must not start'))
    with pytest.raises(RuntimeError, match='PR-head and merge-base'):
        harness.explain(_explain_report(), 'codex', '', '', repository_root=tmp_path)
