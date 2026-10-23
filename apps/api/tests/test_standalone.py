from __future__ import annotations

import sys

from standalone_entry import _ensure_headless_streams
import json
from pathlib import Path
import standalone_entry as entry


def test_pythonw_headless_streams_are_replaced(monkeypatch) -> None:
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)

    _ensure_headless_streams()

    assert sys.stdout is not None
    assert sys.stderr is not None
    assert not sys.stdout.closed
    assert not sys.stderr.closed
    sys.stdout.close()
    sys.stderr.close()


def test_loopback_readiness_never_uses_enterprise_proxy(tmp_path, monkeypatch):
    monkeypatch.setattr(entry, "_control_root", lambda: tmp_path)
    monkeypatch.setenv("HTTP_PROXY", "http://unreachable.invalid:9999")
    monkeypatch.setenv("HTTPS_PROXY", "http://unreachable.invalid:9999")
    marker = tmp_path / "ready.url"
    monkeypatch.setenv("CIC_STARTUP_URL_FILE", str(marker))
    class Response:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *args): pass
    class Opener:
        def open(self, url, timeout):
            assert url == "http://127.0.0.1:48765/api/health"
            return Response()
    def build(handler):
        assert handler.proxies == {}
        return Opener()
    monkeypatch.setattr(entry.urllib.request, "build_opener", build)
    entry._open_when_ready("http://127.0.0.1:48765")
    assert marker.read_text() == "http://127.0.0.1:48765"


def test_moving_exe_preserves_existing_data_and_explicit_portable_copy_wins(tmp_path, monkeypatch):
    control = tmp_path / "control"
    control.mkdir()
    old = tmp_path / "old-data"
    (old / "data").mkdir(parents=True)
    (old / "data/app.db").touch()
    (control / "last-data-root.json").write_text(json.dumps({"path": str(old)}))
    requested = tmp_path / "new-location"
    monkeypatch.setattr(entry, "_control_root", lambda: control)
    monkeypatch.setenv("CIC_PORTABLE_HOME", str(requested))
    assert entry._user_root() == old
    (requested / "data").mkdir(parents=True)
    (requested / "data/app.db").touch()
    assert entry._user_root() == requested
