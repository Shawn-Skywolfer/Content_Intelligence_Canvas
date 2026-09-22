#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
python_exe="$repo_root/apps/api/.venv/bin/python"
if [[ ! -x "$python_exe" ]]; then
  echo "尚未安装依赖，请先运行 ./scripts/setup.sh" >&2
  exit 1
fi
cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM
(cd "$repo_root/apps/api" && CIC_DATA_DIR="$repo_root/data" "$python_exe" -m uvicorn app.main:app --reload --port 8000) &
(cd "$repo_root/apps/web" && npm run dev) &
wait
