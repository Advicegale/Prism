from pathlib import Path
import subprocess
import pytest
from prism.gitops import parse_pr_url, RepoError, diff_files

@pytest.mark.parametrize('url,expected',[
  ('https://github.com/foo/bar/pull/14',('foo','bar',14)),
  ('https://github.com/foo/bar/pull/14/files',('foo','bar',14)),
  ('https://github.com/foo/bar/pull/14/',('foo','bar',14))])
def test_pr_url(url,expected):
    assert parse_pr_url(url)==expected

@pytest.mark.parametrize('url',[
  'http://github.com/a/b/pull/1','https://evil.com/a/b/pull/1',
  'https://github.com/a/b/issues/1','https://github.com/a/b/pull/0',
  'file:///etc/passwd','https://github.com/a/../pull/42',
  'https://foo.github.com/a/b/pull/1'])
def test_invalid_url(url):
    with pytest.raises(RepoError):parse_pr_url(url)

def git(repo,*args):
    return subprocess.check_output(['git','-C',str(repo),*args],text=True).strip()

def test_diff_detects_additions_and_deletions(tmp_path):
    git(tmp_path,'init')
    git(tmp_path,'config','user.email','test@example.org')
    git(tmp_path,'config','user.name','Test')
    src=tmp_path/'foo.py'
    src.write_text('class A:\n    def one(self):\n        return 2\n')
    git(tmp_path,'add','.')
    git(tmp_path,'commit','-m','base')
    base=git(tmp_path,'rev-parse','HEAD')
    src.write_text('class A:\n    def one(self):\n        return 3\n\n    def two(self):\n        return 4\n')
    git(tmp_path,'add','.')
    git(tmp_path,'commit','-m','update')
    head=git(tmp_path,'rev-parse','HEAD')
    files=diff_files(tmp_path,base,head)
    assert len(files)==1
    assert files[0]['path']=='foo.py'
    assert files[0]['new_ranges']
    assert files[0]['old_ranges']
    assert 'return 4' in files[0]['patch']
