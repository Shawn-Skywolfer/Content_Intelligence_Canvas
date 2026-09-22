from __future__ import annotations

import sys

from standalone_entry import _ensure_headless_streams


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
