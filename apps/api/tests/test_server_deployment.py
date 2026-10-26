import base64
import importlib.util
import io
import zipfile
from pathlib import Path
from types import SimpleNamespace
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api import knowledge


def test_zip_import_keeps_agent_context_and_rejects_traversal(tmp_path, monkeypatch):
    from app.repositories.knowledge_manifest import KnowledgeManifestRepository
    monkeypatch.setenv("CIC_DATA_DIR", str(tmp_path))
    manifest = KnowledgeManifestRepository(tmp_path / "app.db")
    monkeypatch.setattr(knowledge, "get_container", lambda: SimpleNamespace(manifest=manifest))
    app = FastAPI(); app.include_router(knowledge.router)
    client = TestClient(app)
    def archive(entries):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as z:
            for path, value in entries.items(): z.writestr(path, value)
        return data.getvalue()
    response = client.post("/api/knowledge-sources/upload-zip?name=测试", content=archive({"wiki/_agent_context/overview.md": "总览", "wiki/词条.md": "原文", "wiki/image.png": "不导入"}))
    assert response.status_code == 200
    root = Path(response.json()["root_path"])
    assert (root / "_agent_context/overview.md").read_text(encoding="utf-8") == "总览"
    assert not (root / "image.png").exists()
    for path in ("../escape.md", "C:/escape.md", "..\\escape.md", "/escape.md"):
        assert client.post("/api/knowledge-sources/upload-zip", content=archive({path: "x"})).status_code == 422
    assert not (tmp_path / "escape.md").exists()
    assert client.post("/api/knowledge-sources/upload-zip", content=b"invalid").status_code == 422


def test_server_folder_picker_is_disabled(monkeypatch):
    monkeypatch.setenv("CIC_SERVER_MODE", "1")
    app = FastAPI(); app.include_router(knowledge.router)
    response = TestClient(app).post("/api/system/select-folder")
    assert response.status_code == 501 and "服务器" in response.json()["detail"]


def test_server_requires_password_and_authenticates_all_routes(tmp_path, monkeypatch):
    path = Path(__file__).resolve().parents[3] / "packaging/server/server_entry.py"
    spec = importlib.util.spec_from_file_location("cic_server", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    web = tmp_path / "web_dist"; web.mkdir(); (web / "index.html").write_text("工作台", encoding="utf-8")
    import app.main as main
    monkeypatch.setattr(main, "app", FastAPI())
    @main.app.get("/api/health")
    def health(): return {"status": "ok"}
    monkeypatch.setenv("CIC_SERVER_HOST", "0.0.0.0")
    monkeypatch.delenv("CIC_SERVER_PASSWORD", raising=False)
    with pytest.raises(RuntimeError, match="CIC_SERVER_PASSWORD"):
        module.create_server_app(tmp_path)
    monkeypatch.setenv("CIC_SERVER_PASSWORD", "test-password-123")
    client = TestClient(module.create_server_app(tmp_path))
    for route in ("/", "/api/health"):
        assert client.get(route).status_code == 401
        assert client.get(route, auth=("admin", "wrong")).status_code == 401
        assert client.get(route, auth=("admin", "test-password-123")).status_code == 200
