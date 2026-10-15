from prism import topics


def groups(*ids):
    return [{"id": group_id, "changed_ids": [], "files": [f"{group_id}.py"], "graph": {"nodes": [], "edges": []}}
            for group_id in ids]


def suggestion(title, members, focus=""):
    return {"title": title, "focus": focus, "group_ids": members}


def check(suggestions, group_list=None):
    return topics._check_suggestions(suggestions, group_list or groups("a", "b", "c"))


def test_valid_partition_is_accepted_without_issues():
    result, issues = check([suggestion("One", ["a"], "Check it"), suggestion("Two", ["b", "c"])])
    assert [topic["group_ids"] for topic in result] == [["a"], ["b", "c"]]
    assert result[0]["focus"] == "Check it"
    assert issues == []


def test_rejection_codes_match_the_spec():
    cases = {
        "no_suggestions": [None, []],
        "not_a_list": ["not a list", {"title": "x"}],
        "too_many_topics": [[suggestion(f"T{i}", [group]) for i, group in enumerate("abc")] + [suggestion("X", ["a"])]],
        "topic_not_object": [["a"]],
        "bad_title": [[suggestion("", ["a"]), suggestion("B", ["b", "c"])],
                      [suggestion("x" * 81, ["a"]), suggestion("B", ["b", "c"])],
                      [{"group_ids": ["a"]}, suggestion("B", ["b", "c"])]],
        "bad_members": [[suggestion("A", []), suggestion("B", ["b", "c"])],
                        [suggestion("A", [1]), suggestion("B", ["b", "c"])],
                        [suggestion("A", "a"), suggestion("B", ["b", "c"])]],
        "unknown_group": [[suggestion("A", ["a", "zzz"]), suggestion("B", ["b", "c"])]],
        "duplicate_group": [[suggestion("A", ["a", "b"]), suggestion("B", ["b", "c"])]],
        "missing_groups": [[suggestion("A", ["a"]), suggestion("B", ["b"])]],
    }
    for code, variants in cases.items():
        for suggestions in variants:
            result, issues = check(suggestions)
            assert result is None, code
            assert issues == [code], (code, suggestions, issues)


def test_focus_cleared_is_reported_but_partition_is_kept():
    long_focus = "x" * 181
    result, issues = check([suggestion("A", ["a"], long_focus), suggestion("B", ["b"], "line\nbreak"),
                            suggestion("C", ["c"], 7)])
    assert result is not None
    assert [topic["focus"] for topic in result] == ["", "", ""]
    assert issues == ["focus_cleared"]


def test_empty_focus_is_not_an_issue():
    result, issues = check([suggestion("A", ["a"], ""), suggestion("B", ["b"], None), suggestion("C", ["c"])])
    assert result is not None and issues == []


def test_validated_suggestions_keeps_its_return_value():
    group_list = groups("a", "b")
    assert topics._validated_suggestions([suggestion("A", ["a"]), suggestion("B", ["b"])], group_list) == [
        {"title": "A", "focus": "", "group_ids": ["a"], "source": "ai"},
        {"title": "B", "focus": "", "group_ids": ["b"], "source": "ai"},
    ]
    assert topics._validated_suggestions([suggestion("A", ["a"])], group_list) is None


def test_diagnostics_report_ai_source_and_fallback_reason():
    group_list = groups("a", "b", "c")
    built, diagnostics = topics.build_topics_with_diagnostics(group_list, {}, [suggestion("A", ["a"]), suggestion("B", ["b", "c"])])
    assert diagnostics == {"source": "ai", "issues": [], "appended_paths": 0}
    assert [topic["title"] for topic in built] == ["A", "B"]

    _, missing = topics.build_topics_with_diagnostics(group_list, {}, [suggestion("A", ["a"]), suggestion("B", ["b"])])
    assert missing == {"source": "paths", "issues": ["missing_groups"], "appended_paths": 0}

    _, none = topics.build_topics_with_diagnostics(group_list, {})
    assert none == {"source": "paths", "issues": ["no_suggestions"], "appended_paths": 0}
    _, explicit_none = topics.build_topics_with_diagnostics(group_list, {}, None, None)
    assert explicit_none["issues"] == ["no_suggestions"]


def test_build_topics_returns_the_same_topics_as_diagnostics():
    group_list = groups("a", "b", "c")
    suggested = [suggestion("A", ["a"]), suggestion("B", ["b", "c"], "Verify it")]
    assert topics.build_topics(group_list, {}, suggested) == topics.build_topics_with_diagnostics(group_list, {}, suggested)[0]
    assert topics.build_topics(group_list, {}) == topics.build_topics_with_diagnostics(group_list, {})[0]


def test_no_groups_yields_no_topics():
    assert topics.build_topics_with_diagnostics([], {}) == ([], {"source": "paths", "issues": [], "appended_paths": 0})


def test_file_role_recognises_the_same_test_paths_as_the_explorer():
    positives = ['src/__tests__/a.ts', 'tests/test_x.py', 'pkg/test_x.py', 'pkg/conftest.py', 'web/app.test.tsx',
                 'web/app.spec.js', 'web/app.e2e.ts', 'api/foo_test.go', 'api/foo_spec.rb', 'lib/foo_test.dart',
                 'src/test/java/FooBar.java', 'src/main/FooTest.java', 'src/main/FooTests.cs', 'src/main/FooSpec.kt',
                 'src/main/FooIT.java', 'src/main/TestFoo.java', 'svc/itest/Runner.java', 'svc/ITest/Runner.java',
                 'crate/tests/it.rs', 'spec/models/user.rb', 'e2e/login.ts', 'testdata/sample.json', 'cmd/unit_test.cc']
    negatives = ['src/latest.ts', 'src/contest.py', 'src/Test.java', 'src/attest.go', 'src/main.rs',
                 'src/components/Submit.tsx', 'src/EDIT.ts', 'src/protest/a.ts', 'src/specification.ts',
                 'lib/testing.ts', 'src/app.ts']
    assert len(positives) == 23 and len(negatives) == 11
    for path in positives:
        assert topics.file_role(path) == "test", path
    for path in negatives:
        assert topics.file_role(path) != "test", path


def test_file_role_for_locks_docs_migrations_and_config():
    expected = {
        "Cargo.lock": "lock", "package-lock.json": "lock", "web/yarn.lock": "lock", "api/poetry.lock": "lock",
        "pnpm-lock.yaml": "lock", "vendor/custom.lock": "lock",
        "README.md": "doc", "docs/guide.txt": "doc", "documentation/setup.rst": "doc", "src/page.mdx": "doc",
        "db/migrations/0001_init.sql": "migration", "schema.sql": "migration", "db/migration/002.txt": "migration",
        "package.json": "config", "tsconfig.json": "config", "config/app.json": "config", "config/settings.toml": "config", "conf/settings.toml": "source",
        ".env.local": "config", "Dockerfile": "config", "compose.yaml": "config", "docker-compose.yml": "config",
        "src/data.json": "source", "src/app.ts": "source", "lib/parser.rs": "source", "assets/logo.svg": "source",
    }
    for path, role in expected.items():
        assert topics.file_role(path) == role, path


def test_file_role_order_puts_tests_and_locks_first():
    assert topics.file_role("docs/tests/readme.md") == "test"
    assert topics.file_role("config/tests/app.json") == "test"
    assert topics.file_role("yarn.lock") == "lock"
    assert topics.file_role("db/migrations/config.json") == "migration"
