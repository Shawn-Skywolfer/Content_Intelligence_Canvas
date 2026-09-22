from __future__ import annotations

import json
import os
import re
import ssl
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from urllib.request import getproxies, proxy_bypass

import httpx

from app.repositories.workspace import WorkspaceRepository
from app.services.ai.secret_store import LocalSecretStore


JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


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
        mode = str(extra.get("network_mode") or "auto")
        if mode not in {"auto", "direct", "system_proxy", "custom_proxy"}:
            mode = "auto"
        proxy_password = extra.get("proxy_password") or self.secrets.get(extra.get("proxy_password_ref"))
        return mode, extra.get("proxy_url"), extra.get("proxy_username"), proxy_password

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
    ) -> httpx.Response:
        errors: list[str] = []
        routes = cls._network_routes(url, network_mode, proxy_url, proxy_username, proxy_password)
        request_timeout = httpx.Timeout(float(timeout), connect=min(float(timeout), 12.0))
        for index, (label, proxy) in enumerate(routes):
            try:
                with httpx.Client(
                    trust_env=False,
                    proxy=proxy,
                    timeout=request_timeout,
                    follow_redirects=True,
                    verify=cls._ssl_verification(),
                ) as client:
                    response = client.request(method, url, headers=headers, json=json_payload)
                if response.status_code in {407, 502, 503, 504} and index + 1 < len(routes):
                    errors.append(f"{label}：HTTP {response.status_code}")
                    continue
                response.extensions["cic_network_route"] = label
                return response
            except (httpx.TransportError, ValueError, OSError) as exc:
                errors.append(f"{label}：{cls._connection_error(exc)}")
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

    def health_check(self, provider: dict[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            network_mode, proxy_url, proxy_username, proxy_password = self._network_settings(provider)
            response = self._request(
                "POST",
                self._chat_url(provider["base_url"]),
                headers=self._headers(provider),
                json_payload={
                    "model": provider["model_name"],
                    "messages": [{"role": "user", "content": "只回复 OK"}],
                    "temperature": 0,
                    "max_tokens": 8,
                },
                timeout=provider.get("timeout_seconds", 60),
                network_mode=network_mode,
                proxy_url=proxy_url,
                proxy_username=proxy_username,
                proxy_password=proxy_password,
            )
            latency = int((time.perf_counter() - started) * 1000)
            response.raise_for_status()
            payload = response.json()
            content = self._extract_content(payload)
            return {
                "reachable": True,
                "authenticated": True,
                "capability_test": bool(content),
                "latency_ms": latency,
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "message": (
                    f"连接成功（{self._route_label(response)}）"
                    if content
                    else f"接口可达，但没有返回文本内容（{self._route_label(response)}）"
                ),
            }
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            return {
                "reachable": True,
                "authenticated": status not in {401, 403},
                "capability_test": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "message": self._http_error_message("模型调用失败", exc.response),
            }
        except Exception as exc:  # Provider error must not crash the workspace.
            return {
                "reachable": False,
                "authenticated": False,
                "capability_test": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "message": f"连接失败：{exc}",
            }

    def complete(
        self,
        system: str,
        user: str,
        *,
        provider: dict[str, Any] | None = None,
    ) -> tuple[str, dict[str, str]]:
        provider = provider or self.repository.active_provider()
        if not provider:
            raise RuntimeError("尚未配置可用的大模型")
        if self.repository.get_setting("protect_internal_data", True) and provider.get("is_external"):
            raise PermissionError("数据保护已开启，不能把内部知识发送给外部模型")
        network_mode, proxy_url, proxy_username, proxy_password = self._network_settings(provider)
        response = self._request(
            "POST",
            self._chat_url(provider["base_url"]),
            headers=self._headers(provider),
            json_payload={
                "model": provider["model_name"],
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": provider.get("temperature", 0.3),
                "max_tokens": provider.get("max_tokens", 3000),
            },
            timeout=provider.get("timeout_seconds", 60),
            network_mode=network_mode,
            proxy_url=proxy_url,
            proxy_username=proxy_username,
            proxy_password=proxy_password,
        )
        response.raise_for_status()
        text = self._extract_content(response.json())
        if not text:
            raise RuntimeError("大模型返回了空内容")
        return text, {"provider": provider["name"], "model": provider["model_name"]}

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
