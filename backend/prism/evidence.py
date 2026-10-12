"""Small, verifiable code excerpts from PR revisions for the review UI and LLM.

Only reads files in the previously prepared detached worktrees. Unlike AI-generated
snippets, these excerpts are exact source text with stable line references.
"""
from __future__ import annotations
from pathlib import Path


SUFFIXES = {'.py':'python','.ts':'typescript','.tsx':'tsx','.js':'javascript','.jsx':'jsx',
            '.java':'java','.go':'go','.rs':'rust','.kt':'kotlin','.swift':'swift',
            '.cpp':'cpp','.c':'c','.cs':'csharp','.rb':'ruby','.vue':'vue'}


def collect_evidence(groups: list[dict], files: list[dict], before: Path, after: Path) -> dict:
    file_map = {f['path']:f for f in files}
    file_map.update({f['old_path']:f for f in files if f.get('old_path')})
    results = {}
    for group in groups:
        by_id = {n['id']:n for n in group['graph']['nodes']}
        for symbol_id in group['changed_ids']:
            if symbol_id in results or symbol_id not in by_id:
                continue
            node = by_id[symbol_id]
            old = node['status'] == 'deleted'
            root = before if old else after
            relative = node.get('path', '')
            if not relative:
                continue
            path = (root / relative).resolve()
            # Repository-controlled paths must never escape the cached worktree.
            if not path.is_relative_to(root.resolve()) or not path.is_file() or path.is_symlink():
                continue
            if path.stat().st_size > 600_000:
                continue
            try:
                lines = path.read_text(encoding='utf-8').splitlines()
            except (OSError, UnicodeError):
                continue
            if not lines:
                continue
            info = file_map.get(relative, {})
            ranges = info.get('old_ranges' if old else 'new_ranges', [])
            symbol_start = max(1, int(node.get('line') or 1))
            symbol_end = max(symbol_start, int(node.get('end') or symbol_start + 15))
            matching = [r for r in ranges if r[1] >= symbol_start and r[0] <= symbol_end]
            focus = matching[0][0] if matching else symbol_start
            start = max(1, max(symbol_start, focus - 6))
            end = min(len(lines), symbol_end, max(focus + 16, start + 20), start + 54)
            if end < start:
                start = min(len(lines), symbol_start)
                end = min(len(lines), start + 28)
            excerpt = '\n'.join(lines[start-1:end])
            clipped = len(excerpt) > 3500
            results[symbol_id] = {
                'path':relative, 'start_line':start, 'end_line':end,
                'language':SUFFIXES.get(path.suffix.lower(),'text'),
                'side':'base' if old else 'head',
                'code':excerpt[:3500], 'truncated':clipped or (end < symbol_end),
            }
    return results
