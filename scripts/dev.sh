#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -x backend/.venv/bin/python ]]; then echo 'Run ./setup.sh first'; exit 1; fi
backend/.venv/bin/python -m uvicorn prism.app:app --app-dir backend --host 127.0.0.1 --port 4780 --reload &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
(cd frontend && npm run dev)
