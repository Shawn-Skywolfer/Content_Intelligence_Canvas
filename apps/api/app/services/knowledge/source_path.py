from __future__ import annotations

import re


def clean_local_path(value: str) -> str:
    """Find a drive path pasted immediately after a tool warning."""
    raw = value.strip().strip('"\'')
    matches = list(re.finditer(r"[A-Za-z]:[\\/]", raw))
    if matches:
        raw = raw[matches[-1].start():].strip().strip('"\'')
    return raw
