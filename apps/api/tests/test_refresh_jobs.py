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


def test_folder_picker_ignores_stdout_warnings_and_reads_structured_result(tmp_path, monkeypatch):
    import json
    import base64
    from pathlib import Path
    from app.api import knowledge
    def run(args, **kwargs):
        script = base64.b64decode(args[-1]).decode("utf-16-le")
        assert "选择本地知识库文件夹" in script and "Write-Output" not in script
        Path(kwargs["env"]["CIC_FOLDER_PICKER_RESULT"]).write_text(json.dumps({"path": "D:\\LLM-Wiki\\知识库 O'Brien"}, ensure_ascii=False), encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="[WARNING] Ignore caches that are heterogeneous", stderr="")
    monkeypatch.setattr(knowledge.subprocess, "run", run)
    assert knowledge._pick_windows_folder()["path"] == "D:\\LLM-Wiki\\知识库 O'Brien"


def test_folder_picker_cancel_returns_empty_without_using_console_output(monkeypatch):
    from pathlib import Path
    from app.api import knowledge
    def run(_args, **kwargs):
        Path(kwargs["env"]["CIC_FOLDER_PICKER_RESULT"]).write_text('{"path":""}', encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="[WARNING] junk D:\\wrong", stderr="")
    monkeypatch.setattr(knowledge.subprocess, "run", run)
    assert knowledge._pick_windows_folder() == {"path": ""}


def test_saved_warning_path_is_repaired_without_losing_source_id(tmp_path):
    from app.repositories.knowledge_manifest import KnowledgeManifestRepository
    from app.services.knowledge.source_path import repair_source_path
    manifest = KnowledgeManifestRepository(tmp_path / "db.sqlite")
    vault = tmp_path / "wiki"
    vault.mkdir()
    manifest.upsert_source("stable-id", "知识库", f"[WARNING] junk\n{vault}")
    fixed = repair_source_path(manifest, manifest.get_source("stable-id"))
    assert fixed["root_path"] == str(vault.resolve())
    assert manifest.get_source("stable-id")["root_path"] == fixed["root_path"]
    assert len(manifest.list_sources()) == 1
