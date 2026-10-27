"""生成平台可识别的源码发布包，并拒绝覆盖同名制品。"""
from __future__ import annotations
import argparse
import io
import json
from pathlib import Path
import re
import time
import zipfile


def zip_bytes(files):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            if "\\" in name or name.startswith("/") or ".." in Path(name).parts:
                raise ValueError("ZIP 路径不安全")
            archive.writestr(name, content)
    return data.getvalue()


def build(root: Path, output: Path, service: str, timestamp: str | None = None):
    if not re.fullmatch(r"[A-Za-z]+", service) or service.startswith("WinOs"):
        raise ValueError("Linux 服务名只允许英文字母，不能使用 WinOs 前缀")
    timestamp = timestamp or time.strftime("%Y%m%d%H%M%S", time.gmtime(time.time() + 8 * 3600))
    if not re.fullmatch(r"\d{14}", timestamp):
        raise ValueError("版本必须为 14 位实时时间戳")
    destination = output / f"{service}-{timestamp}.zip"
    if destination.exists():
        raise FileExistsError("不可覆盖已存在的发布包")
    front_root = root / "apps/web/dist"
    if not (front_root / "index.html").is_file():
        raise ValueError("请先构建前端")
    front = {str(p.relative_to(front_root).as_posix()): p.read_bytes() for p in front_root.rglob("*") if p.is_file()}
    combined = b"\n".join(value for name, value in front.items() if name.endswith(".js"))
    if f"/{service}".encode() not in combined:
        raise ValueError("前端构建服务前缀与包名不一致")
    if re.search(rb'(?:src|href)=[\"\']/assets/', front["index.html"]):
        raise ValueError("前端资源不是相对路径")
    backend = {}
    for p in (root / "apps/api/app").rglob("*.py"):
        backend[p.relative_to(root / "apps/api").as_posix()] = p.read_bytes()
    for name in ("manage.py", "requirements.txt", "requirements.lock.txt"):
        backend[name] = (root / "packaging/cloud" / name).read_bytes()
    backend["requirement.txt"] = backend["requirements.txt"]
    backend["DEPLOYMENT.md"] = (root / "packaging/cloud/DEPLOYMENT.md").read_bytes()
    manifest = {"service": service, "version": timestamp, "shape": "front_end", "chain": "Linux/K8s", "python": "3.11.4", "entry": "manage.py", "replicas": 1, "service_prefix": f"/{service}", "health": f"/{service}/api/health", "contains_runtime": False, "contains_user_data": False}
    output.mkdir(parents=True, exist_ok=True)
    # 排他创建避免同一秒并发打包覆盖不可变制品。
    with destination.open("xb") as file:
        file.write(zip_bytes({"front.zip": zip_bytes(front), "backend.zip": zip_bytes(backend),
                              "DEPLOYMENT.md": backend["DEPLOYMENT.md"], "build-manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2).encode()}))
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", default="ContentWorkbench")
    parser.add_argument("--output", type=Path, default=Path("release-artifacts"))
    args = parser.parse_args()
    result = build(Path(__file__).resolve().parents[1], args.output, args.service)
    print(result.resolve())
