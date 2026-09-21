from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from app.repositories.workspace import WorkspaceRepository
from app.services.ai.secret_store import LocalSecretStore


JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


class AIProviderGateway:
    def __init__(self, repository: WorkspaceRepository, secrets: LocalSecretStore) -> None:
        self.repository = repository
        self.secrets = secrets

    @staticmethod
    def _chat_url(base_url: str) -> str:
        clean = base_url.rstrip("/")
        if clean.endswith("/chat/completions"):
            return clean
        if clean.endswith("/v1"):
            return f"{clean}/chat/completions"
        return f"{clean}/v1/chat/completions"

    def _headers(self, provider: dict[str, Any]) -> dict[str, str]:
        key = self.secrets.get(provider.get("secret_ref"))
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        return headers

    def health_check(self, provider: dict[str, Any]) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            response = httpx.post(
                self._chat_url(provider["base_url"]),
                headers=self._headers(provider),
                json={
                    "model": provider["model_name"],
                    "messages": [{"role": "user", "content": "只回复 OK"}],
                    "temperature": 0,
                    "max_tokens": 8,
                },
                timeout=provider.get("timeout_seconds", 60),
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
                "message": "连接成功" if content else "接口可达，但没有返回文本内容",
            }
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            return {
                "reachable": True,
                "authenticated": status not in {401, 403},
                "capability_test": False,
                "latency_ms": int((time.perf_counter() - started) * 1000),
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "message": f"模型调用失败：HTTP {status}",
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
        response = httpx.post(
            self._chat_url(provider["base_url"]),
            headers=self._headers(provider),
            json={
                "model": provider["model_name"],
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": provider.get("temperature", 0.3),
                "max_tokens": provider.get("max_tokens", 3000),
            },
            timeout=provider.get("timeout_seconds", 60),
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
