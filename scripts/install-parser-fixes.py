#!/usr/bin/env python3
"""Build small, reproducible corrections to Graphify's published grammars.

Only the parser packages change; neither Graphify nor reviewed source is edited.
Upstream sources/licenses stay in the build cache. Local version tags distinguish
these wheels in Prism's existing parser-version cache fingerprint.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
from importlib.metadata import PackageNotFoundError, version
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

FIXES = Path(__file__).resolve().parent / 'grammar-fixes'
MANIFEST = json.loads((FIXES / 'manifest.json').read_text())


def run(args, cwd=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Prism-parser-build'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def compiler(cache):
    system = {'Linux': 'linux', 'Darwin': 'macos'}.get(platform.system())
    arch = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    asset = f'tree-sitter-{system}-{arch}.gz'
    expected = MANIFEST['compiler']['sha256'].get(asset)
    if not expected:
        raise RuntimeError(f'No pinned parser compiler for {platform.system()}/{platform.machine()}')
    archive = cache / asset
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        data = download(f'https://github.com/tree-sitter/tree-sitter/releases/download/v{MANIFEST["compiler"]["version"]}/{asset}')
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError('Parser compiler checksum mismatch')
        archive.write_bytes(data)
    executable = cache / 'tree-sitter'
    executable.write_bytes(gzip.decompress(archive.read_bytes()))
    executable.chmod(0o755)
    return executable


def build(spec, cache, cli):
    destination = cache / spec['package']
    destination.mkdir(exist_ok=True)
    wheels = list(destination.glob('*.whl'))
    if wheels:
        return wheels[0]
    with tempfile.TemporaryDirectory(prefix='build-', dir=cache) as folder:
        folder = Path(folder)
        data = download(f'https://codeload.github.com/{spec["repository"]}/tar.gz/{spec["commit"]}')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            archive.extractall(folder, filter='data')
        source = next(folder.iterdir())
        run(['git', 'apply', '--check', FIXES / spec['patch']], source)
        run(['git', 'apply', FIXES / spec['patch']], source)
        metadata = source / 'pyproject.toml'
        text = metadata.read_text()
        original = f'version = "{spec["upstream_version"]}"'
        if text.count(original) != 1:
            raise RuntimeError(f'Unexpected upstream version for {spec["package"]}')
        metadata.write_text(text.replace(original, f'version = "{spec["version"]}"'))
        for grammar_dir in spec['generate']:
            run([cli, 'generate'], source / grammar_dir)
        if shutil.which('uv'):
            run(['uv', 'build', '--wheel', '--out-dir', destination, source])
        else:
            run([sys.executable, '-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', destination, source])
        # Retain the exact patched source and upstream license for inspection.
        shutil.move(source, destination / 'source')
    return next(destination.glob('*.whl'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true', help='Reinstall from the cached corrected wheels')
    args = parser.parse_args()
    needed = []
    for spec in MANIFEST['parsers']:
        try:
            installed = version(spec['package'])
        except PackageNotFoundError:
            installed = None
        if args.force or installed != spec['version']:
            needed.append(spec)
    if not needed:
        print('Corrected Graphify parsers are already installed.')
        return
    if not shutil.which('git') or not shutil.which('node') or not any(shutil.which(c) for c in ('cc', 'gcc', 'clang')):
        raise RuntimeError('Building corrected parsers requires Git, Node.js and a C compiler (cc/gcc/clang).')
    fingerprint = hashlib.sha256((FIXES / 'manifest.json').read_bytes() + b''.join(
        (FIXES / spec['patch']).read_bytes() for spec in MANIFEST['parsers'])).hexdigest()[:16]
    cache = Path(os.getenv('XDG_CACHE_HOME', str(Path.home() / '.cache'))) / 'prism' / 'grammar-fixes' / (
        f'{fingerprint}-{sys.implementation.cache_tag}-{platform.system()}-{platform.machine()}')
    cache.mkdir(parents=True, exist_ok=True)
    cli = compiler(cache) if any(spec['generate'] and not list((cache / spec['package']).glob('*.whl')) for spec in needed) else None
    wheels = [build(spec, cache, cli) for spec in needed]
    if shutil.which('uv'):
        run(['uv', 'pip', 'install', '--python', sys.executable, '--reinstall', *wheels])
    else:
        run([sys.executable, '-m', 'pip', 'install', '--force-reinstall', '--no-deps', *wheels])
    print(f'Installed {len(wheels)} corrected parsers; sources and licenses: {cache}')


if __name__ == '__main__':
    main()
