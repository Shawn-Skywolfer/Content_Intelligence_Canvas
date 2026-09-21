from __future__ import annotations

import json
import os
import uuid
from pathlib import Path


class LocalSecretStore:
    """Small local secret store kept outside SQLite and excluded from exports."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self, values: dict[str, str]) -> None:
        self.path.write_text(json.dumps(values), encoding="utf-8")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def set(self, secret: str, ref: str | None = None) -> str:
        ref = ref or f"local-secret://{uuid.uuid4().hex}"
        values = self._read()
        values[ref] = secret
        self._write(values)
        return ref

    def get(self, ref: str | None) -> str | None:
        if not ref:
            return None
        return self._read().get(ref)

    def delete(self, ref: str | None) -> None:
        if not ref:
            return
        values = self._read()
        if ref in values:
            del values[ref]
            self._write(values)
