"""Language-neutral eligibility for bounded tracked source reads."""
from pathlib import PurePosixPath

SKIP_DIRS = {'.git', '.venv', 'venv', 'node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', 'graphify-out'}
BINARY_SUFFIXES = {'.png','.jpg','.jpeg','.gif','.webp','.ico','.bmp','.pdf','.zip','.gz','.xz','.7z','.tar',
                   '.mp4','.mkv','.mov','.mp3','.wav','.ogg','.woff','.woff2','.ttf','.otf','.exe','.dll','.so',
                   '.pyc','.class','.jar','.pck','.bin','.db','.sqlite','.sqlite3','.p12','.pfx','.key','.pem'}


def eligible_path(path: str) -> bool:
    pure = PurePosixPath(path)
    return not (pure.is_absolute() or '..' in pure.parts or SKIP_DIRS.intersection(pure.parts)
                or pure.suffix.lower() in BINARY_SUFFIXES)


def git_lines(text: str) -> list[str]:
    """Git/Tree-sitter coordinates count LF only, not Python's Unicode separators."""
    if not text: return []
    rows = text.split("\n")
    return rows[:-1] if rows[-1] == "" else rows
