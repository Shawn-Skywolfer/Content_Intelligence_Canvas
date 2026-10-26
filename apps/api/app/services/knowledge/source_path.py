from __future__ import annotations

import re
from pathlib import Path


def clean_local_path(value: str) -> str:
    """Find a drive path pasted immediately after a tool warning."""
    raw = value.replace("\ufeff", "").strip().strip('"\'“”‘’')
    matches = list(re.finditer(r"[A-Za-z]:[\\/]|\\\\[^\\\s]+\\", raw))
    if matches:
        raw = raw[matches[-1].start():].splitlines()[0].strip().strip('"\'“”‘’')
    elif "\n" in raw:
        raw = next((line.strip().strip('"\'') for line in reversed(raw.splitlines())
                    if line.strip().strip('"\'').startswith(("/", "~/"))), raw)
    return raw


def repair_source_path(manifest, source: dict) -> dict:
    """Repair a saved warning-prefixed path without changing source/document IDs."""
    original = str(source["root_path"])
    cleaned = clean_local_path(original)
    if cleaned != original and Path(cleaned).expanduser().is_dir():
        cleaned = str(Path(cleaned).expanduser().resolve())
        manifest.upsert_source(source["id"], source["name"], cleaned)
        return {**source, "root_path": cleaned}
    return source
