from __future__ import annotations

import time
from types import SimpleNamespace

from app.services.knowledge.refresh_jobs import KnowledgeRefreshJobs
from app.services.knowledge.source_path import clean_local_path


def test_warning_prefix_is_removed_from_pasted_windows_path():
    assert clean_local_path("[WARNING] Ignore caches that are heterogeneousD:\\Wiki\\wiki") == "D:\\Wiki\\wiki"
    assert clean_local_path("D:\\Wiki\\wiki") == "D:\\Wiki\\wiki"


def test_refresh_reports_model_read_then_current_file_and_counts(tmp_path):
    events = []

    class Manifest:
        def get_source(self, source_id):
            return {"id": "wiki", "name": "Wiki", "root_path": str(tmp_path)} if source_id == "wiki" else None

    class Context:
        def prepare_refresh(self, source_id):
            events.append("context")
            return {"status": "read", "model": "internal"}

    class Indexer:
        async def refresh(self, _name, _path, progress):
            events.append("index")
            progress({"phase": "处理词条", "processed": 1, "total": 2, "current_path": "first.md", "indexed": 1})
            time.sleep(.05)
            progress({"phase": "处理词条", "processed": 2, "total": 2, "current_path": "second.md", "indexed": 2})
            return SimpleNamespace(discovered=2, indexed=2, warnings=[], to_dict=lambda: {"discovered": 2, "indexed": 2, "warnings": []})

    service = KnowledgeRefreshJobs(Manifest(), Indexer(), Context())
    job = service.start("wiki")
    deadline = time.monotonic() + 2
    while job["status"] == "running" and time.monotonic() < deadline:
        time.sleep(.01)
        job = service.get(job["job_id"])
    assert job["status"] == "completed"
    assert job["processed"] == job["total"] == 2
    assert job["agent_context"]["status"] == "read"
    assert job["estimated_total_seconds"] is not None
    assert events == ["context", "index"]
