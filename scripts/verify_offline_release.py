"""在空白虚拟环境内，仅使用实际交付包安装并执行完整 HTTP 验收。"""
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import venv
import zipfile

package = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="offline-acceptance-") as directory:
    root = Path(directory)
    with zipfile.ZipFile(package) as archive:
        with zipfile.ZipFile(io.BytesIO(archive.read("backend.zip"))) as backend:
            backend.extractall(root / "backend")
    venv.create(root / "venv", with_pip=True)
    python = root / "venv/bin/python"
    env = {k: v for k, v in os.environ.items() if not k.startswith("PIP_") and k != "PYTHONPATH"}
    # --isolated 忽略开发机的 pip 配置；requirements 内的 no-index 强制只查随包依赖。
    subprocess.run([str(python), "-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--no-cache-dir", "-r", "requirement.txt"], cwd=root / "backend", env=env, check=True)
    subprocess.run([str(python), "-m", "pip", "check"], env=env, check=True)
    subprocess.run([str(python), str(Path(__file__).with_name("verify_cloud_release.py")), str(package)], env=env, check=True)
    print("离线依赖安装、依赖完整性及解包后的业务验收通过", flush=True)
