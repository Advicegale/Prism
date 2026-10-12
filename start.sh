#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] && set -a && source .env && set +a
PORT="${PORT:-4780}"
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then echo 'Invalid PORT'; exit 1; fi
if [[ ! -x backend/.venv/bin/python ]]; then echo 'Run ./setup.sh first'; exit 1; fi
if [[ ! -f frontend/dist/index.html ]]; then echo 'Frontend is not built; run ./setup.sh first'; exit 1; fi
printf 'Prism listening on http://127.0.0.1:%s\n' "$PORT"
exec backend/.venv/bin/python -m uvicorn prism.app:app --app-dir backend --host 127.0.0.1 --port "$PORT"
