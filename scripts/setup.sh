#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
python3 -m venv "$repo_root/apps/api/.venv"
"$repo_root/apps/api/.venv/bin/python" -m pip install --upgrade pip
"$repo_root/apps/api/.venv/bin/python" -m pip install -e "$repo_root/apps/api[dev]"
(cd "$repo_root/apps/web" && npm install)
echo "安装完成。运行 ./scripts/dev.sh 启动工作台。"
