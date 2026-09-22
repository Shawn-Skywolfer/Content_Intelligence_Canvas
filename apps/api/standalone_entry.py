from __future__ import annotations

import atexit
import ctypes
import json
import os
import shutil
import socket
import sqlite3
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

import psutil
import uvicorn
from fastapi.staticfiles import StaticFiles


APP_NAME = "ContentIntelligenceCanvas"
MUTEX_NAME = "Local\\ContentIntelligenceCanvas.SingleInstance"
ERROR_ALREADY_EXISTS = 183
WAIT_OBJECT_0 = 0
WAIT_ABANDONED = 0x80


def _ensure_headless_streams() -> None:
    """pythonw.exe has no console streams; logging libraries still expect file objects."""
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")


def _message(title: str, message: str) -> None:
    ctypes.windll.user32.MessageBoxW(None, message, title, 0x10)


def _runtime_root() -> Path:
    return Path(__file__).resolve().parent


def _user_root() -> Path:
    portable_home = os.getenv("CIC_PORTABLE_HOME")
    if portable_home:
        root = Path(portable_home)
    else:
        base = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        root = Path(base) / APP_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _control_root() -> Path:
    base = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    root = Path(base) / APP_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _copy_seed_data(runtime_root: Path, user_root: Path) -> tuple[Path, Path]:
    seed = runtime_root / "seed"
    data_dir = user_root / "data"
    wiki_dir = user_root / "knowledge" / "wiki"

    if not (data_dir / "app.db").exists() and (seed / "data").exists():
        shutil.copytree(seed / "data", data_dir, dirs_exist_ok=True)
    else:
        data_dir.mkdir(parents=True, exist_ok=True)

    if not wiki_dir.exists() and (seed / "wiki").exists():
        shutil.copytree(seed / "wiki", wiki_dir)
    else:
        wiki_dir.mkdir(parents=True, exist_ok=True)

    private_dir = user_root / "private-evaluation"
    if not private_dir.exists() and (seed / "private-evaluation").exists():
        shutil.copytree(seed / "private-evaluation", private_dir)

    database = data_dir / "app.db"
    if database.exists() and wiki_dir.exists():
        try:
            with sqlite3.connect(database) as connection:
                table = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_sources'"
                ).fetchone()
                if table:
                    connection.execute(
                        "UPDATE knowledge_sources SET root_path = ? WHERE connector_type = 'local_vault'",
                        (str(wiki_dir.resolve()),),
                    )
                    connection.commit()
        except sqlite3.Error:
            pass

    return data_dir, wiki_dir


def _terminate_previous(pid_file: Path) -> None:
    if not pid_file.exists():
        return
    try:
        record = json.loads(pid_file.read_text(encoding="utf-8"))
        pid = int(record["pid"])
        if pid == os.getpid():
            return
        process = psutil.Process(pid)
        expected_time = float(record["create_time"])
        if abs(process.create_time() - expected_time) > 1.0:
            return
        command = " ".join(process.cmdline()).lower()
        if "standalone_entry.py" not in command:
            return
        if Path(process.exe()).name.lower() not in {"pythonw.exe", "python.exe"}:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except psutil.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    except (OSError, ValueError, KeyError, psutil.Error, json.JSONDecodeError):
        return


def _acquire_single_instance(user_root: Path) -> tuple[int, Path]:
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.CreateMutexW(None, True, MUTEX_NAME)
    if not handle:
        raise RuntimeError("无法创建应用单实例锁。")

    pid_file = user_root / "runtime-process.json"
    if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
        _terminate_previous(pid_file)
        result = kernel32.WaitForSingleObject(handle, 10_000)
        if result not in {WAIT_OBJECT_0, WAIT_ABANDONED}:
            kernel32.CloseHandle(handle)
            raise RuntimeError("旧实例未能在 10 秒内退出，请稍后重试。")

    current = psutil.Process(os.getpid())
    pid_file.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "create_time": current.create_time(),
                "executable": current.exe(),
                "entry": str(Path(__file__).resolve()),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return handle, pid_file


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _open_when_ready(url: str) -> None:
    for _ in range(80):
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=0.5) as response:
                if response.status == 200:
                    webbrowser.open(url)
                    return
        except OSError:
            time.sleep(0.25)


def run() -> None:
    _ensure_headless_streams()
    runtime_root = _runtime_root()
    user_root = _user_root()
    mutex, pid_file = _acquire_single_instance(_control_root())

    def cleanup() -> None:
        try:
            if pid_file.exists():
                record = json.loads(pid_file.read_text(encoding="utf-8"))
                if int(record.get("pid", -1)) == os.getpid():
                    pid_file.unlink(missing_ok=True)
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        ctypes.windll.kernel32.ReleaseMutex(mutex)
        ctypes.windll.kernel32.CloseHandle(mutex)

    atexit.register(cleanup)
    data_dir, _ = _copy_seed_data(runtime_root, user_root)
    os.environ["CIC_DATA_DIR"] = str(data_dir)

    api_root = runtime_root / "apps" / "api"
    sys.path.insert(0, str(api_root))
    from app.main import app

    web_dist = runtime_root / "web_dist"
    if not (web_dist / "index.html").exists():
        raise RuntimeError("前端资源不完整，请重新下载应用。")
    app.mount("/", StaticFiles(directory=web_dist, html=True), name="中文界面")

    port = _free_port()
    url = f"http://127.0.0.1:{port}"
    threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        _message("内容智能白板启动失败", f"应用未能启动：\n\n{exc}")
        raise
