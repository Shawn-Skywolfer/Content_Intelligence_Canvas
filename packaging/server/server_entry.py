"""Single-service Windows web deployment; independent of desktop and static hosting."""
from __future__ import annotations
import base64
import binascii
import logging
import os
import secrets
import sys
from pathlib import Path


def create_server_app(runtime: Path):
    sys.path.insert(0, str(runtime / "apps" / "api"))
    from app.main import app
    from fastapi.staticfiles import StaticFiles
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse
    username = os.getenv("CIC_SERVER_USERNAME", "admin")
    password = os.getenv("CIC_SERVER_PASSWORD", "")
    host = os.getenv("CIC_SERVER_HOST", "0.0.0.0")
    if host not in {"127.0.0.1", "localhost", "::1"} and len(password) < 12:
        raise RuntimeError("服务器对外监听必须设置 CIC_SERVER_PASSWORD，至少 12 个字符；请在部署平台配置环境变量")

    class LoginMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if password:
                header = request.headers.get("authorization", "")
                valid = False
                try:
                    scheme, encoded = header.split(" ", 1)
                    user, supplied = base64.b64decode(encoded, validate=True).decode("utf-8").split(":", 1)
                    valid = (scheme.lower() == "basic" and secrets.compare_digest(user.encode(), username.encode())
                             and secrets.compare_digest(supplied.encode(), password.encode()))
                except (ValueError, UnicodeError, binascii.Error):
                    pass
                if not valid:
                    return JSONResponse({"detail": "请使用部署管理员提供的账号登录工作台"}, status_code=401,
                                        headers={"WWW-Authenticate": 'Basic realm="Content Intelligence Workbench", charset="UTF-8"'})
            return await call_next(request)

    app.add_middleware(LoginMiddleware)
    app.mount("/", StaticFiles(directory=runtime / "web_dist", html=True), name="服务器工作台")
    return app


def run() -> None:
    runtime = Path(__file__).resolve().parent
    root = runtime.parent
    os.environ["CIC_SERVER_MODE"] = "1"
    data = Path(os.getenv("CIC_DATA_DIR", str(root / "data"))).expanduser().resolve()
    data.mkdir(parents=True, exist_ok=True)
    os.environ["CIC_DATA_DIR"] = str(data)
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, open(data / "server-console.log", "a", encoding="utf-8", buffering=1))
    logging.basicConfig(filename=data / "server.log", encoding="utf-8", level=logging.WARNING)
    app = create_server_app(runtime)
    import uvicorn
    # One worker owns SQLite/LanceDB and the in-process task registry.
    uvicorn.run(app, host=os.getenv("CIC_SERVER_HOST", "0.0.0.0"),
                port=int(os.getenv("PORT", os.getenv("CIC_SERVER_PORT", "8000"))),
                workers=1, access_log=False, log_config=None)


if __name__ == "__main__":
    run()
