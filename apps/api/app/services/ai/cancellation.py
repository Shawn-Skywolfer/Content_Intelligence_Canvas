from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from threading import Event, Lock, Thread
from typing import Any, Iterator


class OperationCancelled(RuntimeError):
    pass


class CancellationToken:
    def __init__(self) -> None:
        self.event = Event()
        self.lock = Lock()
        self.client: Any = None
        self.on_network: Any = None
        self.on_telemetry: Any = None
        self.on_draft: Any = None
        self.completed_draft = ""
        self.failure: str | None = None
        self.partial_output = ""

    def check(self) -> None:
        if self.failure:
            raise RuntimeError(self.failure)
        if self.event.is_set():
            raise OperationCancelled("任务已由用户取消")

    def bind(self, client: Any) -> None:
        with self.lock:
            self.check()
            self.client = client

    def unbind(self, client: Any) -> None:
        with self.lock:
            if self.client is client:
                self.client = None

    def cancel(self) -> None:
        self.event.set()
        with self.lock:
            client = self.client
        if client is not None:
            def close_connection() -> None:
                try:
                    client.close()
                except Exception:
                    pass
            Thread(target=close_connection, name="cancel-ai-connection", daemon=True).start()


_current_token: ContextVar[CancellationToken | None] = ContextVar("ai_cancel_token", default=None)


@contextmanager
def cancellation_scope(token: CancellationToken) -> Iterator[None]:
    reset = _current_token.set(token)
    try:
        yield
    finally:
        _current_token.reset(reset)


def check_cancelled() -> None:
    token = _current_token.get()
    if token:
        token.check()


def current_token() -> CancellationToken | None:
    return _current_token.get()


def checkpoint_draft(body: str) -> None:
    token = current_token()
    if token and body.strip():
        token.check()
        token.completed_draft = body
        if token.on_draft:
            token.on_draft(body)
