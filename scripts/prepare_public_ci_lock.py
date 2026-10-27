"""公开 CI 使用锁文件的临时副本，仓库始终保留内网镜像地址与原完整性校验。"""
import os
from pathlib import Path
if os.getenv("GITHUB_ACTIONS") != "true":
    raise SystemExit("此脚本仅允许在公开 GitHub 构建环境执行")
path = Path(__file__).resolve().parents[1] / "apps/web/package-lock.json"
path.write_text(path.read_text(encoding="utf-8").replace("https://mirrors.tools.huawei.com/npm/", "https://registry.npmjs.org/"), encoding="utf-8")
