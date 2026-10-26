from __future__ import annotations

import json
import os
import re
import ssl
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlsplit
from urllib.request import getproxies, proxy_bypass

import httpx
from app.services.ai.cancellation import check_cancelled, current_token

from app.repositories.workspace import WorkspaceRepository
from app.services.ai.secret_store import LocalSecretStore


JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
_task_provider: ContextVar[dict[str, Any] | None] = ContextVar("task_provider", default=None)


@contextmanager
def provider_scope(provider: dict[str, Any] | None):
    marker = _task_provider.set(provider)
    try:
        yield
    finally:
        _task_provider.reset(marker)


class ProviderConnectionError(RuntimeError):
    """A readable aggregate of the connection routes attempted for one provider request."""


class AIProviderGateway:
    def __init__(self, repository: WorkspaceRepository, secrets: LocalSecretStore) -> None:
        self.repository = repository
        self.secrets = secrets

    @staticmethod
    def _chat_url(base_url: str) -> str:
        clean = base_url.rstrip("/")
        if clean.endswith("/chat/completions"):
            return clean
        return f"{clean}/chat/completions"

    @staticmethod
    def _models_url(base_url: str) -> str:
        clean = base_url.rstrip("/")
        if clean.endswith("/chat/completions"):
            clean = clean[: -len("/chat/completions")]
        if clean.endswith("/models"):
            return clean
        return f"{clean}/models"

    @staticmethod
    def _proxy_url(value: str | None) -> str | None:
        if not value or not value.strip():
            return None
        candidate = value.strip()
        if "://" not in candidate:
            candidate = f"http://{candidate}"
        try:
            parsed = urlsplit(candidate)
            _ = parsed.port
        except ValueError:
            return None
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        return candidate

    @classmethod
    def _windows_proxy_candidates(cls, scheme: str) -> list[str]:
        if os.name != "nt":
            return []
        try:
            import winreg

            key_path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                enabled = int(winreg.QueryValueEx(key, "ProxyEnable")[0])
                raw = str(winreg.QueryValueEx(key, "ProxyServer")[0]).strip()
            if not enabled or not raw:
                return []
            if "=" not in raw:
                return [raw]
            values: dict[str, str] = {}
            for item in raw.split(";"):
                key_name, separator, value = item.partition("=")
                if separator and value.strip():
                    values[key_name.strip().lower()] = value.strip()
            return [value for value in (values.get(scheme), values.get("https"), values.get("http")) if value]
        except (OSError, ValueError):
            return []

    @classmethod
    def _system_proxy(cls, target_url: str) -> str | None:
        parsed = urlsplit(target_url)
        try:
            if parsed.hostname and proxy_bypass(parsed.hostname):
                return None
        except (OSError, ValueError):
            pass
        discovered = getproxies()
        candidates = [
            discovered.get(parsed.scheme),
            discovered.get("all"),
            *cls._windows_proxy_candidates(parsed.scheme),
        ]
        for candidate in candidates:
            proxy = cls._proxy_url(candidate)
            if proxy:
                return proxy
        return None

    @classmethod
    def _network_routes(
        cls,
        target_url: str,
        network_mode: str,
        proxy_url: str | None,
        proxy_username: str | None = None,
        proxy_password: str | None = None,
    ) -> list[tuple[str, str | httpx.Proxy | None]]:
        if network_mode == "direct":
            return [("直连", None)]
        if network_mode == "custom_proxy":
            proxy = cls._proxy_url(proxy_url)
            if not proxy:
                raise ProviderConnectionError("自定义代理地址无效，请填写 http://主机:端口")
            proxy_config: str | httpx.Proxy = proxy
            if proxy_username:
                proxy_config = httpx.Proxy(proxy, auth=(proxy_username, proxy_password or ""))
            return [("企业代理", proxy_config)]
        system_proxy = cls._system_proxy(target_url)
        if network_mode == "system_proxy":
            if not system_proxy:
                raise ProviderConnectionError("未检测到可用的 Windows 系统代理，请改用自动、直连或自定义代理")
            return [("系统代理", system_proxy)]
        routes: list[tuple[str, str | httpx.Proxy | None]] = []
        if system_proxy:
            routes.append(("系统代理", system_proxy))
        routes.append(("直连", None))
        return routes

    @staticmethod
    def _connection_error(exc: Exception) -> str:
        message = str(exc).strip()
        if isinstance(exc, httpx.TimeoutException) or "WinError 10060" in message:
            return "连接超时（WinError 10060）"
        if isinstance(exc, httpx.ProxyError):
            return f"代理不可用：{message or type(exc).__name__}"
        if isinstance(exc, httpx.ConnectError):
            return f"无法建立连接：{message or type(exc).__name__}"
        return message or type(exc).__name__

    def _network_settings(
        self,
        provider: dict[str, Any],
    ) -> tuple[str, str | None, str | None, str | None]:
        extra = provider.get("extra") if isinstance(provider.get("extra"), dict) else {}
        from app.services.network_settings import NetworkSettings
        resolved = NetworkSettings(self.repository, self.secrets).resolve(extra)
        return tuple(resolved[key] for key in ("network_mode", "proxy_url", "proxy_username", "proxy_password"))

    @staticmethod
    def _ssl_verification() -> ssl.SSLContext | bool:
        try:
            import truststore

            return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        except ImportError:
            return True

    @staticmethod
    def _route_label(response: httpx.Response) -> str:
        extensions = getattr(response, "extensions", {}) or {}
        return str(extensions.get("cic_network_route") or "自动网络")

    @classmethod
    def _request(
        cls,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        timeout: int | float,
        json_payload: dict[str, Any] | None = None,
        network_mode: str = "auto",
        proxy_url: str | None = None,
        proxy_username: str | None = None,
        proxy_password: str | None = None,
        progress: Callable[[str], None] | None = None,
    ) -> httpx.Response:
        errors: list[str] = []
        token = current_token()
        routes = cls._network_routes(url, network_mode, proxy_url, proxy_username, proxy_password)
        request_timeout = httpx.Timeout(float(timeout), connect=min(float(timeout), 12.0))
        for index, (label, proxy) in enumerate(routes):
            check_cancelled()
            if token and token.on_network:
                token.on_network(f"正在通过{label}连接模型接口：{url}")
            if progress:
                progress(f"正在通过{label}连接并等待模型响应（第 {index + 1}/{len(routes)} 条线路）")
            try:
                with httpx.Client(
                    trust_env=False,
                    proxy=proxy,
                    timeout=request_timeout,
                    follow_redirects=True,
                    verify=cls._ssl_verification(),
                ) as client:
                    if token:
                        token.bind(client)
                    try:
                        response = client.request(method, url, headers=headers, json=json_payload)
                    finally:
                        if token:
                            token.unbind(client)
                check_cancelled()
                if token and token.on_network:
                    token.on_network(f"{label}已返回 HTTP {response.status_code}")
                if progress:
                    progress(f"收到 HTTP {response.status_code}，正在解析模型结果")
                if response.status_code in {407, 502, 503, 504} and index + 1 < len(routes):
                    errors.append(f"{label}：HTTP {response.status_code}")
                    continue
                response.extensions["cic_network_route"] = label
                return response
            except (httpx.TransportError, ValueError, OSError) as exc:
                check_cancelled()
                errors.append(f"{label}：{cls._connection_error(exc)}")
        check_cancelled()
        detail = "；".join(errors) or "没有可用连接方式"
        raise ProviderConnectionError(
            f"自动网络连接失败：{detail}。请在模型配置中切换网络连接方式或填写代理地址"
        )

    @staticmethod
    def _http_error_message(prefix: str, response: httpx.Response) -> str:
        detail = ""
        try:
            payload = response.json()
            error = payload.get("error") if isinstance(payload, dict) else None
            if isinstance(error, dict):
                detail = str(error.get("message") or error.get("code") or "")
            elif error:
                detail = str(error)
            elif isinstance(payload, dict):
                detail = str(payload.get("message") or payload.get("detail") or "")
        except (ValueError, TypeError):
            detail = response.text.strip()[:240]
        suffix = f"：{detail}" if detail else ""
        return f"{prefix}：HTTP {response.status_code}{suffix}"

    def _headers(self, provider: dict[str, Any]) -> dict[str, str]:
        key = provider.get("api_key") or self.secrets.get(provider.get("secret_ref"))
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        return headers

    def list_models(self, provider: dict[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            network_mode, proxy_url, proxy_username, proxy_password = self._network_settings(provider)
            response = self._request(
                "GET",
                self._models_url(provider["base_url"]),
                headers=self._headers(provider),
                timeout=provider.get("timeout_seconds", 60),
                network_mode=network_mode,
                proxy_url=proxy_url,
                proxy_username=proxy_username,
                proxy_password=proxy_password,
            )
            response.raise_for_status()
            payload = response.json()
            raw_models = payload.get("data", payload.get("models", []))
            models = sorted(
                {
                    str(item.get("id") or item.get("name"))
                    for item in raw_models
                    if isinstance(item, dict) and (item.get("id") or item.get("name"))
                }
            )
            return {
                "models": models,
                "count": len(models),
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "message": (
                    f"已获取 {len(models)} 个模型（{self._route_label(response)}）"
                    if models
                    else f"接口可达，但没有返回模型列表（{self._route_label(response)}）"
                ),
            }
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(self._http_error_message("获取模型失败", exc.response)) from exc
        except Exception as exc:
            raise RuntimeError(f"获取模型失败：{exc}") from exc

    def health_check(self, provider: dict[str, Any], progress: Callable[[str], None] | None = None) -> dict[str, Any]:
        started = time.perf_counter()
        extra = provider.get("extra") or {}
        test_model = str(extra.get("test_model") or provider["model_name"])
        test_timeout = max(5, min(30, int(extra.get("test_timeout_seconds") or 15)))
        test_tokens = max(64, min(512, int(extra.get("test_max_tokens") or 256)))
        endpoint = self._chat_url(provider["base_url"])
        try:
            network_mode, proxy_url, proxy_username, proxy_password = self._network_settings(provider)
            if progress:
                progress(f"已准备测试文本“请只回复 OK”；模型 {test_model}，每条线路最多等待 {test_timeout} 秒")
            response = self._request(
                "POST",
                endpoint,
                headers=self._headers(provider),
                json_payload={
                    "model": test_model,
                    "messages": [{"role": "user", "content": "请只回复 OK"}],
                    "max_tokens": test_tokens,
                    **self._reasoning_payload(provider),
                },
                timeout=test_timeout,
                network_mode=network_mode,
                proxy_url=proxy_url,
                proxy_username=proxy_username,
                proxy_password=proxy_password,
                progress=progress,
            )
            latency = int((time.perf_counter() - started) * 1000)
            response.raise_for_status()
            payload = response.json()
            content = self._extract_content(payload)
            choice = (payload.get("choices") or [{}])[0] if isinstance(payload, dict) else {}
            message = choice.get("message") or {}
            finish_reason = choice.get("finish_reason")
            reasoning_only = bool(message.get("reasoning_content")) and not content
            usage = payload.get("usage") if isinstance(payload, dict) else None
            detail = "模型已返回文本" if content else ("输出额度耗尽，只有思考内容；可提高测试输出 token 或换用非推理测试模型" if reasoning_only or finish_reason == "length" else "接口返回 HTTP 200，但未返回文本；请核对模型 ID 与响应格式")
            return {
                "reachable": True,
                "authenticated": True,
                "capability_test": bool(content),
                "status": "success" if content else "failed",
                "http_status": response.status_code,
                "route": self._route_label(response),
                "tested_model": test_model,
                "endpoint": endpoint,
                "latency_ms": latency,
                "finish_reason": finish_reason,
                "usage": usage,
                "response_excerpt": content[:200] if content else "",
                "sent_prompt": "请只回复 OK",
                "test_max_tokens": test_tokens,
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "message": detail,
            }
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            return {
                "reachable": True,
                "authenticated": status not in {401, 403},
                "capability_test": False,
                "status": "failed",
                "http_status": status,
                "route": self._route_label(exc.response),
                "tested_model": test_model,
                "endpoint": endpoint,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "message": self._http_error_message("模型调用失败", exc.response),
            }
        except Exception as exc:  # Provider error must not crash the workspace.
            return {
                "reachable": False,
                "authenticated": False,
                "capability_test": False,
                "status": "failed",
                "http_status": None,
                "tested_model": test_model,
                "endpoint": endpoint,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "message": f"连接失败：{exc}",
            }

    @staticmethod
    def _reasoning_payload(provider: dict[str, Any]) -> dict[str, Any]:
        extra = provider.get("extra") or {}
        mode = extra.get("reasoning_mode", "off")
        if mode == "off" and urlsplit(str(provider.get("base_url") or "")).hostname == "api.deepseek.com":
            # DeepSeek enables thinking by default; omitting the field does not disable it.
            return {"thinking": {"type": "disabled"}}
        if mode == "effort":
            effort = extra.get("reasoning_effort", "medium")
            if effort in {"low", "medium", "high"}:
                return {"reasoning_effort": effort}
        if mode == "thinking":
            return {"thinking": {"type": "enabled"}}
        return {}

    def query_quota(self, provider: dict[str, Any]) -> dict[str, Any]:
        extra = provider.get("extra") or {}
        url = str(extra.get("quota_url") or "").strip()
        field = str(extra.get("quota_json_path") or "").strip()
        if not url.startswith(("https://", "http://")) or not field:
            raise ValueError("请先配置供应商的额度查询地址及 JSON 字段路径")
        mode, proxy_url, username, password = self._network_settings(provider)
        response = self._request("GET", url, headers=self._headers(provider), timeout=10,
                                 network_mode=mode, proxy_url=proxy_url, proxy_username=username, proxy_password=password)
        if response.status_code >= 400:
            raise RuntimeError(self._http_error_message("额度查询失败", response))
        value: Any = response.json()
        for part in field.split("."):
            if not isinstance(value, dict) or part not in value:
                raise ValueError(f"额度响应中没有字段 {field}，请检查 JSON 路径")
            value = value[part]
        if not isinstance(value, (int, float, str, bool)):
            raise ValueError("额度字段应为数字或文本")
        return {"value": value, "unit": str(extra.get("quota_unit") or ""), "route": self._route_label(response)}

    def complete(
        self,
        system: str,
        user: str,
        *,
        provider: dict[str, Any] | None = None,
    ) -> tuple[str, dict[str, str]]:
        provider = provider or _task_provider.get() or self.repository.active_provider()
        if not provider:
            raise RuntimeError("尚未配置可用的大模型")
        if self.repository.get_setting("protect_internal_data", True) and provider.get("is_external"):
            raise PermissionError("数据保护已开启，不能把内部知识发送给外部模型")
        network_mode, proxy_url, proxy_username, proxy_password = self._network_settings(provider)
        payload = {
            "model": provider["model_name"],
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": provider.get("temperature", 0.3),
            "max_tokens": provider.get("max_tokens", 3000),
            **self._reasoning_payload(provider),
        }
        token = current_token()
        if token and token.on_telemetry and (provider.get("extra") or {}).get("stream_output", False):
            from app.services.ai.streaming import request_stream, StreamUnsupported
            try:
                response_payload = request_stream(
                    self, self._chat_url(provider["base_url"]), headers=self._headers(provider), payload=payload,
                    timeout=float(provider.get("timeout_seconds", 60)), network_mode=network_mode,
                    proxy_url=proxy_url, proxy_username=proxy_username, proxy_password=proxy_password,
                )
            except StreamUnsupported:
                token.on_telemetry("供应商不支持流式响应，改用普通调用；等待期间无法提供正文接收进度", {"stage": "fallback"}, "warning")
                response_payload = self._complete_response(provider, payload, network_mode, proxy_url, proxy_username, proxy_password)
        else:
            response_payload = self._complete_response(provider, payload, network_mode, proxy_url, proxy_username, proxy_password)
        choice = (response_payload.get("choices") or [{}])[0]
        if choice.get("finish_reason") == "length":
            raise RuntimeError("模型达到输出或上下文长度上限，结果不完整。请提高最大输出 token 或缩小上下文后重试")
        text = self._extract_content(response_payload)
        if not text:
            choice = (response_payload.get("choices") or [{}])[0] if isinstance(response_payload, dict) else {}
            if choice.get("finish_reason") == "length" or (choice.get("message") or {}).get("reasoning_content"):
                raise RuntimeError("模型输出额度耗尽，尚未返回正文。请提高最大输出 token，或关闭思考模式后重试")
            raise RuntimeError("大模型返回了空内容")
        return text, {"provider": provider["name"], "model": provider["model_name"]}

    def _complete_response(self, provider: dict[str, Any], payload: dict[str, Any], network_mode: str,
                           proxy_url: str | None, username: str | None, password: str | None) -> dict[str, Any]:
        from threading import Event, Thread
        from contextvars import copy_context
        from queue import Queue, Empty
        token = current_token()
        stop = Event()
        started = time.monotonic()
        def waiting() -> None:
            while not stop.wait(5):
                if token and token.on_telemetry and not token.event.is_set():
                    try:
                        token.on_telemetry("等待非流式模型返回完整结果", {"stage": "waiting", "elapsed_seconds": round(time.monotonic() - started, 1)}, "info")
                    except RuntimeError:
                        return
        if token and token.on_telemetry:
            Thread(target=waiting, name="ai-nonstream-progress", daemon=True).start()
        try:
            outcome: Queue = Queue(maxsize=1)
            def receive() -> None:
                try:
                    response = self._request("POST", self._chat_url(provider["base_url"]), headers=self._headers(provider),
                                             json_payload=payload, timeout=provider.get("timeout_seconds", 60),
                                             network_mode=network_mode, proxy_url=proxy_url,
                                             proxy_username=username, proxy_password=password)
                    outcome.put((True, response))
                except BaseException as exc:
                    outcome.put((False, exc))
            context = copy_context()
            Thread(target=lambda: context.run(receive), name="ai-complete-response", daemon=True).start()
            deadline = max(30, min(600, float(provider.get("timeout_seconds", 60)) * 2 + 15))
            while True:
                check_cancelled()
                try:
                    ok, response = outcome.get(timeout=.2)
                    break
                except Empty:
                    if time.monotonic() - started >= deadline:
                        message = f"完整响应模式超过 {int(deadline)} 秒总时限，已结束等待；已保存草稿可在任务详情查看"
                        if token:
                            token.failure = message
                        raise RuntimeError(message)
            check_cancelled()
            if not ok:
                raise response
            if response.status_code >= 400:
                raise RuntimeError(self._http_error_message("模型请求失败", response))
            result = response.json()
            if token and token.on_telemetry:
                token.on_telemetry("已接收非流式模型完整结果", {"stage": "complete", "http_status": response.status_code,
                    "elapsed_seconds": round(time.monotonic() - started, 1), "content_chars": len(self._extract_content(result)),
                    "usage": result.get("usage"),
                    "provider_reasoning": str(((result.get("choices") or [{}])[0].get("message") or {}).get("reasoning_content") or ""),
                    "reasoning_source": "供应商 API 的 reasoning_content 字段"}, "info")
            return result
        finally:
            stop.set()

    def complete_json(self, system: str, user: str) -> tuple[Any, dict[str, str]]:
        content, trace = self.complete(system, user)
        match = JSON_BLOCK_RE.search(content)
        candidate = match.group(1).strip() if match else content.strip()
        first_object = min(
            (index for index in (candidate.find("["), candidate.find("{")) if index >= 0),
            default=0,
        )
        candidate = candidate[first_object:]
        try:
            return json.loads(candidate), trace
        except json.JSONDecodeError:
            end = max(candidate.rfind("]"), candidate.rfind("}"))
            if end >= 0:
                return json.loads(candidate[: end + 1]), trace
            raise RuntimeError("大模型没有返回有效 JSON")

    @staticmethod
    def _extract_content(payload: dict[str, Any]) -> str:
        choices = payload.get("choices") or []
        if choices:
            message = choices[0].get("message") or {}
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "".join(
                    str(item.get("text", "")) for item in content if isinstance(item, dict)
                )
        output = payload.get("output_text")
        return str(output) if output else ""
