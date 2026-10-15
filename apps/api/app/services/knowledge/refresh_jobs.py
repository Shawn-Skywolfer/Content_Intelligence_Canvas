from __future__ import annotations

import asyncio
import threading
import time
import uuid
from pathlib import Path
from typing import Any


class KnowledgeRefreshJobs:
    """Observable refresh work. Jobs survive navigation within this application process."""

    def __init__(self, manifest: Any, indexer: Any, agent_context: Any) -> None:
        self.manifest = manifest
        self.indexer = indexer
        self.agent_context = agent_context
        self.jobs: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()

    def start(self, source_id: str) -> dict[str, Any]:
        source = self.manifest.get_source(source_id)
        if not source:
            raise ValueError("知识源不存在")
        with self.lock:
            if any(job["source_id"] == source_id and job["status"] == "running" for job in self.jobs.values()):
                raise ValueError("该知识源已经在刷新，请等待当前任务完成")
            job_id = f"refresh_{uuid.uuid4().hex}"
            self.jobs[job_id] = {
                "job_id": job_id, "source_id": source_id, "status": "running",
                "phase": "阅读知识全貌", "detail": "模型正在阅读 overview.md 与 domain-map.md",
                "processed": 0, "total": 0, "current_path": "", "indexed": 0,
                "unchanged": 0, "warnings_count": 0, "started": time.monotonic(),
                "index_started": None,
                "agent_context": None, "report": None, "error": None,
            }
        threading.Thread(target=self._run, args=(job_id, dict(source)), daemon=True,
                         name=f"wiki-refresh-{job_id[-8:]}").start()
        return self.get(job_id) or {}

    def _update(self, job_id: str, **changes: Any) -> None:
        with self.lock:
            self.jobs[job_id].update(changes)

    def _run(self, job_id: str, source: dict[str, Any]) -> None:
        try:
            context = self.agent_context.prepare_refresh(source["id"])
            self._update(job_id, agent_context=context, phase="扫描知识库", index_started=time.monotonic(),
                         detail="正在统计原始词条；模型阅读结果将在下方显示")
            report = asyncio.run(self.indexer.refresh(
                source["name"], Path(source["root_path"]),
                progress=lambda change: self._update(job_id, **change),
            ))
            self._update(job_id, status="completed", phase="刷新完成", current_path="",
                         detail=f"处理 {report.discovered} 个词条，更新 {report.indexed} 个，警告 {len(report.warnings or [])} 个",
                         report=report.to_dict())
        except Exception as exc:
            self._update(job_id, status="failed", phase="刷新失败", detail=str(exc), error=str(exc))

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return None
            snapshot = dict(job)
        elapsed = max(0, int(time.monotonic() - snapshot.pop("started")))
        index_started = snapshot.pop("index_started")
        total, processed = snapshot["total"], snapshot["processed"]
        snapshot["elapsed_seconds"] = elapsed
        snapshot["estimated_total_seconds"] = (
            round(elapsed + max(0, time.monotonic() - index_started) * (total - processed) / processed)
            if snapshot["status"] == "running" and processed and total and index_started else
            elapsed if snapshot["status"] != "running" else None
        )
        return snapshot

    def latest_for_source(self, source_id: str) -> dict[str, Any] | None:
        with self.lock:
            ids = [item["job_id"] for item in self.jobs.values() if item["source_id"] == source_id]
        return self.get(ids[-1]) if ids else None
