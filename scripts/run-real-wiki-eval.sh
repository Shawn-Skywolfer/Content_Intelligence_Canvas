#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wiki_path="${1:-$repo_root/fixtures/wiki}"
data_path="${2:-$repo_root/data}"
cases_path="${3:-$repo_root/fixtures/wiki-cases.json}"
python_bin="${CIC_PYTHON:-$repo_root/apps/api/.venv/bin/python}"

if [[ ! -x "$python_bin" ]]; then
  python_bin="python3"
fi

cd "$repo_root/apps/api"
"$python_bin" -m app.cli evaluate \
  --vault "$wiki_path" \
  --data-dir "$data_path" \
  --cases "$cases_path" \
  --output "$repo_root/docs/retrieval-evaluation.json"
