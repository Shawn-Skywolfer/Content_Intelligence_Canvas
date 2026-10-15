from __future__ import annotations

import threading
import time
import uuid
from typing import Any

from app.services.ai.gateway import AIProviderGateway


class ProviderTestJobs:
    def __init__(self, gateway: AIProviderGateway) -> None:
        self.gateway = gateway
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}

    def start(self, provider: dict[str, Any]) -> dict[str, Any]:
        job_id = f"test_{uuid.uuid4().hex}"
        with self._lock:
            self._jobs[job_id] = {"job_id": job_id, "provider_id": provider["id"], "status": "running", "phase": "准备短文本测试请求", "started_at": time.time(), "result": None}
            # A bounded history is enough for page refreshes without accumulating secrets.
            for old in list(self._jobs)[:-100]:
                if self._jobs[old]["status"] != "running":
                    del self._jobs[old]
        threading.Thread(target=self._run, args=(job_id, provider), daemon=True).start()
        return self.get(job_id) or {}

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return {**job, "elapsed_seconds": round(time.time() - job["started_at"], 1)} if job else None

    def _run(self, job_id: str, provider: dict[str, Any]) -> None:
        def report(phase: str) -> None:
            with self._lock:
                self._jobs[job_id]["phase"] = phase

        try:
            result = self.gateway.health_check(provider, progress=report)
        except Exception as exc:
            result = {"status": "failed", "capability_test": False, "message": f"测试未能完成：{exc}", "reachable": False}
        with self._lock:
            self._jobs[job_id].update(status="completed", phase="真实模型测试通过" if result["capability_test"] else "真实模型测试失败", result=result)
