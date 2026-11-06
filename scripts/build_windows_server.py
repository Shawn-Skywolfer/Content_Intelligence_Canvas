"""Build the independent WinOs ZIP from the tested embedded runtime."""
import argparse
import shutil
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("runtime", type=Path)
parser.add_argument("launcher", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix="cic-server-") as directory:
    root = Path(directory)
    shutil.copytree(args.runtime, root / "runtime", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copy2("packaging/server/server_entry.py", root / "runtime/server_entry.py")
    shutil.copy2(args.launcher, root / "WinOs_ContentIntelligenceWorkbench.exe")
    shutil.copy2("packaging/server/README.zh-CN.md", root / "部署说明.md")
    (root / "data").mkdir()
    (root / "wiki").mkdir()
    shutil.make_archive(str(args.output.resolve().with_suffix("")), "zip", root_dir=root)
print(args.output.resolve())
