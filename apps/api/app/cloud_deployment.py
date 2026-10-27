"""按平台约定提供前缀、健康检查与服务器鉴权。"""
from __future__ import annotations
import base64
import binascii
import json
import os
import re
import secrets
from fastapi import FastAPI
from starlette.exceptions import HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse
from app.config import Settings


def utc_output(value, key=""):
    if isinstance(value, dict):
        return {k: utc_output(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [utc_output(item) for item in value]
    if isinstance(value, str) and (key.endswith("_at") or key == "at"):
        if re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?", value):
            return value + "Z"
        if value.endswith("+00:00"):
            return value[:-6] + "Z"
    return value


class CloudJSONResponse(JSONResponse):
    def render(self, content) -> bytes:
        return super().render(utc_output(content))


class PrefixMiddleware:
    def __init__(self, app, prefix: str, username: str = "admin", password: str = ""):
        self.app, self.prefix, self.username, self.password = app, prefix, username, password

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        # 探针不读取数据库、不要求身份，兼容平台历史探活地址。
        if path.endswith("/api/health") or path.endswith("/healthz"):
            return await JSONResponse({"status": "ok"})(scope, receive, send)
        if self.prefix:
            if not (path == self.prefix or path.startswith(self.prefix + "/")):
                return await JSONResponse({"error": "请求缺少部署服务前缀"}, status_code=404)(scope, receive, send)
            scope = dict(scope)
            scope["path"] = path[len(self.prefix):] or "/"
            scope["raw_path"] = scope["path"].encode("utf-8")
            scope["root_path"] = scope.get("root_path", "") + self.prefix
        if self.password:
            valid = False
            try:
                header = dict(scope["headers"]).get(b"authorization", b"").decode("ascii")
                scheme, encoded = header.split(" ", 1)
                user, password = base64.b64decode(encoded, validate=True).decode("utf-8").split(":", 1)
                valid = scheme.lower() == "basic" and secrets.compare_digest(user.encode(), self.username.encode()) and secrets.compare_digest(password.encode(), self.password.encode())
            except (ValueError, UnicodeError, binascii.Error):
                pass
            if not valid:
                return await JSONResponse({"error": "请登录工作台"}, status_code=401,
                    headers={"WWW-Authenticate": 'Basic realm="Workbench", charset="UTF-8"'})(scope, receive, send)
        await self.app(scope, receive, send)


def create_cloud_app() -> FastAPI:
    from app.api.knowledge import router as knowledge
    from app.api.workspace import router as workspace
    from app.api.settings import router as settings_router
    from fastapi.middleware.cors import CORSMiddleware
    settings = Settings.from_env()
    settings.ensure_dirs()
    app = FastAPI(title="内容智能工作台", version="0.3.29-cloud.1", default_response_class=CloudJSONResponse,
                  docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({"error": error.detail}, status_code=error.status_code, headers=error.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # 不把请求值和密钥回显到错误响应。
        return JSONResponse({"error": [{"loc": item["loc"], "msg": item["msg"], "type": item["type"], "ctx": {key: value for key, value in item.get("ctx", {}).items() if key in {"ge", "le", "min_length", "max_length"} and isinstance(value, (int, float))}} for item in error.errors()]}, status_code=422)

    @app.exception_handler(Exception)
    async def internal_error(request, error):
        import logging
        logging.getLogger(__name__).exception("处理请求失败")
        return JSONResponse({"error": "服务器内部错误，请查看服务日志或任务 LOG"}, status_code=500)

    app.include_router(knowledge)
    app.include_router(workspace)
    app.include_router(settings_router)
    app.add_middleware(PrefixMiddleware, prefix=settings.service_prefix,
                       username=os.getenv("CIC_SERVER_USERNAME", "admin"), password=os.getenv("CIC_SERVER_PASSWORD", ""))
    # 同域请求自然不受 CORS 限制，跨域列表由实际平台域名通过环境变量提供。
    app.add_middleware(CORSMiddleware, allow_origins=settings.web_origins, allow_methods=["*"], allow_headers=["*"], allow_credentials=False)
    return app
