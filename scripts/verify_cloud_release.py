"""对实际解包的前后端做 HTTP 验收，不依赖开发目录的后端导入路径。"""
import base64
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

package = Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix="cloud-acceptance-") as directory:
    root = Path(directory)
    with zipfile.ZipFile(package) as outer:
        manifest = json.loads(outer.read("build-manifest.json"))
        for filename in ("front.zip", "backend.zip"):
            with zipfile.ZipFile(io.BytesIO(outer.read(filename))) as inner:
                assert all("\\" not in name and ".." not in Path(name).parts for name in inner.namelist())
                inner.extractall(root / filename[:-4])
    assert (root / "front/index.html").is_file()
    backend = root / "backend"
    assert (backend / "requirement.txt").read_bytes() == (backend / "requirements.txt").read_bytes()
    assert not any(p.suffix in {".db", ".sqlite", ".log"} or p.name.lower() == "dockerfile" for p in backend.rglob("*") if p.is_file())
    html = (root / "front/index.html").read_text(encoding="utf-8")
    for asset in re.findall(r'(?:src|href)="(\./assets/[^"]+)"', html):
        assert (root / "front" / asset).is_file()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
    prefix = manifest["service_prefix"]
    env = {**os.environ, "HOST": "127.0.0.1", "PORT": str(port), "DATA_DIR": str(root / "persistent"), "SERVICE_PREFIX": prefix,
           "CORS_ORIGINS": "https://platform.example", "CIC_SERVER_PASSWORD": "acceptance-password"}
    env.pop("PYTHONPATH", None)
    auth = "Basic " + base64.b64encode(b"admin:acceptance-password").decode()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(path, method="GET", value=None, authenticated=True, content_type="application/json", headers=None):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode() if value is not None else None
        fields = {"Content-Type": content_type, **(headers or {})}
        if authenticated: fields["Authorization"] = auth
        req = urllib.request.Request(f"http://127.0.0.1:{port}" + path, method=method, data=body, headers=fields)
        try:
            with opener.open(req, timeout=30) as response: return response.status, response.read(), response.headers
        except urllib.error.HTTPError as response:
            return response.code, response.read(), response.headers
    log = (root / "acceptance.log").open("w", encoding="utf-8")
    process = None
    try:
        for attempt in range(2):
            process = subprocess.Popen([sys.executable, str(backend / "manage.py")], cwd=backend, env=env, stdout=log, stderr=log)
            for _ in range(120):
                if process.poll() is not None: raise RuntimeError("解包服务提前退出")
                try:
                    status, data, _ = request(prefix + "/api/health", authenticated=False)
                    if status == 200: break
                except OSError: pass
                time.sleep(.25)
            else: raise RuntimeError("解包服务启动超时")
            assert json.loads(data) == {"status": "ok"}
            assert request("/api/projects")[0] == 404
            assert request(prefix + "/api/projects", authenticated=False)[0] == 401
            assert request(prefix + "/api/missing")[0] == 404
            assert "error" in json.loads(request(prefix + "/api/missing")[1])
            cors = request(prefix + "/api/projects", method="OPTIONS", authenticated=False,
                           headers={"Origin": "https://platform.example", "Access-Control-Request-Method": "GET"})
            assert cors[0] == 200 and cors[2]["access-control-allow-origin"] == "https://platform.example"
            if not attempt:
                status, data, _ = request(prefix + "/api/projects", "POST", {"name": "解包验收", "idea": "前缀与持久化", "brief": ""})
                assert status == 200
                project = json.loads(data)
                assert project["created_at"].endswith("Z")
                status, data, _ = request(prefix + f"/api/projects/{project['id']}/canvas")
                assert status == 200 and json.loads(data)["nodes"]
                wiki = io.BytesIO()
                with zipfile.ZipFile(wiki, "w") as archive:
                    archive.writestr("wiki/entry.md", "# 原始材料\n\n这是部署测试的知识词条。")
                assert request(prefix + "/api/knowledge-sources/upload-zip", "POST", wiki.getvalue(), content_type="application/zip")[0] == 200
            else:
                assert json.loads(request(prefix + "/api/projects")[1])[0]["id"] == project["id"]
                assert json.loads(request(prefix + "/api/knowledge-sources")[1])
            process.terminate(); process.wait(timeout=15); process = None
        print(json.dumps({"package": package.name, "bytes": package.stat().st_size, "python": sys.version.split()[0],
                          "prefix_health": "通过", "authentication": "通过", "project_canvas": "通过", "wiki_zip": "通过", "restart_persistence": "通过", "relative_assets": "通过"}, ensure_ascii=False))
    except Exception:
        log.flush(); print((root / "acceptance.log").read_text(encoding="utf-8"), file=sys.stderr)
        raise
    finally:
        if process is not None:
            process.terminate(); process.wait(timeout=15)
        log.close()
