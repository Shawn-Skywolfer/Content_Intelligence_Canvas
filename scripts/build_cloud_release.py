"""生成平台可识别的源码发布包，并拒绝覆盖同名制品。"""
from __future__ import annotations
import argparse
import hashlib
from email.parser import BytesParser
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


def build(root: Path, output: Path, service: str, timestamp: str | None = None, wheelhouse: Path | None = None):
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
    if wheelhouse is not None:
        # 锁定包与哈希，阻止离线安装意外回退到公网或选择其他版本。
        expected = {}
        normalize = lambda name: re.sub(r"[-_.]+", "-", name).lower()
        for line in backend["requirements.lock.txt"].decode().splitlines():
            if line.strip() and not line.startswith("#"):
                name, version = line.strip().split("==")
                expected[normalize(name)] = version
        found = {}
        for wheel in sorted(wheelhouse.glob("*.whl")):
            content = wheel.read_bytes()
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                metadata = [n for n in archive.namelist() if n.endswith(".dist-info/METADATA")]
                if len(metadata) != 1:
                    raise ValueError("依赖包元数据不完整")
                info = BytesParser().parsebytes(archive.read(metadata[0]))
            name, version = normalize(info["Name"]), info["Version"]
            if expected.get(name) != version or name in found:
                raise ValueError(f"依赖包与锁文件不一致：{wheel.name}")
            found[name] = f"{name}=={version} --hash=sha256:{hashlib.sha256(content).hexdigest()}"
            backend["wheelhouse/" + wheel.name] = content
        if set(found) != set(expected):
            raise ValueError(f"缺少离线依赖：{sorted(set(expected) - set(found))}")
        backend["requirements.txt"] = ("--no-index\n--find-links ./wheelhouse\n--require-hashes\n" + "\n".join(found[n] for n in sorted(found)) + "\n").encode()
    backend["requirement.txt"] = backend["requirements.txt"]
    backend["DEPLOYMENT.md"] = (root / "packaging/cloud/DEPLOYMENT.md").read_bytes()
    manifest = {"service": service, "version": timestamp, "shape": "front_end", "chain": "Linux/K8s", "python": "3.11.4", "entry": "manage.py", "replicas": 1, "service_prefix": f"/{service}", "health": f"/{service}/api/health", "contains_runtime": False, "contains_user_data": False}
    if wheelhouse is not None:
        backend["DEPLOYMENT.md"] = (root / "packaging/cloud/OFFLINE.md").read_bytes()
        manifest.update({"offline_dependencies": True, "wheel_count": len(found), "architecture": "linux-x86_64", "base_image_required": True})
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
    parser.add_argument("--wheelhouse", type=Path)
    args = parser.parse_args()
    result = build(Path(__file__).resolve().parents[1], args.output, args.service, wheelhouse=args.wheelhouse)
    print(result.resolve())
