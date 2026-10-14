#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null; then echo 'Python 3.11+ is required'; exit 1; fi
if ! command -v npm >/dev/null; then echo 'Node.js and npm are required'; exit 1; fi
if ! command -v git >/dev/null; then echo 'git is required'; exit 1; fi
python3 - <<'PY'
import sys
if sys.version_info < (3,11): raise SystemExit('Python 3.11 or newer is required')
PY
if command -v uv >/dev/null; then
  echo '[1/2] Installing Python dependencies with uv'
  uv venv --python python3 backend/.venv
  uv pip install --python backend/.venv/bin/python -e './backend[test]'
else
  echo '[1/2] Installing Python dependencies with venv / pip'
  python3 -m venv backend/.venv
  backend/.venv/bin/python -m pip install -e './backend[test]'
fi
echo 'Installing language parsers declared by Graphify'
mapfile -t graphify_parser_requirements < <(backend/.venv/bin/python scripts/graphify-language-requirements.py)
if command -v uv >/dev/null; then
  uv pip install --python backend/.venv/bin/python "${graphify_parser_requirements[@]}"
else
  backend/.venv/bin/python -m pip install "${graphify_parser_requirements[@]}"
fi
echo 'Installing reproducible corrections for JSX, C# pointers and PostgreSQL syntax'
backend/.venv/bin/python scripts/install-parser-fixes.py
echo '[2/2] Installing and building web interface'
(cd frontend && npm install && npm run build)
if [[ ! -f .env ]]; then cp .env.example .env; fi
echo 'Setup complete. Run ./start.sh and visit http://127.0.0.1:4780'
