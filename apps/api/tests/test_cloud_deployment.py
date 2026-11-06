"""针对平台前缀、探针与持久目录的验收。"""
import base64
import importlib.util
import io
import json
from pathlib import Path
import zipfile
import pytest
from fastapi.testclient import TestClient
from app.cloud_deployment import create_cloud_app
from app.container import get_container


def test_cloud_prefix_health_login_errors_and_persistent_data(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "persistent"))
    monkeypatch.setenv("SERVICE_PREFIX", "/ContentWorkbench")
    monkeypatch.setenv("CIC_SERVER_MODE", "cloud")
    monkeypatch.setenv("CIC_SERVER_PASSWORD", "test-cloud-password")
    monkeypatch.setenv("CORS_ORIGINS", "https://deployment.example")
    get_container.cache_clear()
    try:
        client = TestClient(create_cloud_app())
        for route in ("/api/health", "/ContentWorkbench/api/health", "/legacy/healthz"):
            response = client.get(route)
            assert response.status_code == 200 and response.json() == {"status": "ok"}
        assert not (tmp_path / "persistent/app.db").exists()
        assert client.get("/api/projects").status_code == 404
        assert client.get("/ContentWorkbench/api/projects").status_code == 401
        client.auth = ("admin", "test-cloud-password")
        created = client.post("/ContentWorkbench/api/projects", json={"name": "云端项目", "idea": "部署测试", "brief": ""})
        assert created.status_code == 200
        project = created.json()
        assert project["created_at"].endswith("Z")
        repo = get_container().workspace
        assert not repo.get_project(project["id"])["created_at"].endswith("Z")
        assert "+00:00" not in repo.get_project(project["id"])["created_at"]
        response = client.get(f"/ContentWorkbench/api/projects/{project['id']}/canvas")
        assert response.status_code == 200 and response.json()["nodes"]
        assert client.get("/ContentWorkbench/api/missing").json() == {"error": "Not Found"}
        error = client.post("/ContentWorkbench/api/projects", json={"idea": ""})
        assert error.status_code == 422 and "error" in error.json()
        cors = client.options("/ContentWorkbench/api/projects", headers={"Origin": "https://deployment.example", "Access-Control-Request-Method": "GET"})
        assert cors.status_code == 200
        assert cors.headers["access-control-allow-origin"] == "https://deployment.example"
        get_container.cache_clear()
        restarted = TestClient(create_cloud_app()); restarted.auth = client.auth
        assert restarted.get("/ContentWorkbench/api/projects").json()[0]["id"] == project["id"]
    finally:
        get_container.cache_clear()


def test_package_structure_is_immutable_and_excludes_runtime_data(tmp_path):
    root = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location("cloud_build", root / "scripts/build_cloud_release.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    fake = tmp_path / "source"
    web = fake / "apps/web/dist"; web.mkdir(parents=True)
    (web / "index.html").write_text('<script src="./assets/main.js"></script>', encoding="utf-8")
    (web / "main.js").write_text('const prefix="/ContentWorkbench"', encoding="utf-8")
    app = fake / "apps/api/app"; app.mkdir(parents=True)
    (app / "main.py").write_text("# 中文\n", encoding="utf-8")
    (app / "private.db").write_bytes(b"secret")
    cloud = fake / "packaging/cloud"; cloud.mkdir(parents=True)
    for name in ("manage.py", "requirements.txt", "requirements.lock.txt", "DEPLOYMENT.md"):
        (cloud / name).write_text("example", encoding="utf-8")
    package = module.build(fake, tmp_path / "output", "ContentWorkbench", "20261027010101")
    with zipfile.ZipFile(package) as outer:
        assert set(outer.namelist()) == {"front.zip", "backend.zip", "DEPLOYMENT.md", "build-manifest.json"}
        with zipfile.ZipFile(io.BytesIO(outer.read("backend.zip"))) as backend:
            assert {"manage.py", "requirement.txt", "requirements.txt", "requirements.lock.txt"} <= set(backend.namelist())
            assert not any("\\" in name or name.endswith(".db") or "Dockerfile" in name for name in backend.namelist())
            assert backend.read("requirement.txt") == backend.read("requirements.txt")
    with pytest.raises(FileExistsError):
        module.build(fake, tmp_path / "output", "ContentWorkbench", "20261027010101")
