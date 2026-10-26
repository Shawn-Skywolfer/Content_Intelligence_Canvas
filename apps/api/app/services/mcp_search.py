from __future__ import annotations

import json
import re
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from app.repositories.workspace import WorkspaceRepository
from app.services.ai.secret_store import LocalSecretStore
from app.services.ai.gateway import AIProviderGateway, ProviderConnectionError
from app.services.network_settings import NetworkSettings
from app.services.ai.cancellation import check_cancelled, current_token


class McpSearchService:
    """Streamable HTTP MCP search; only bounded search results enter model context."""

    def __init__(self, repository: WorkspaceRepository, secrets: LocalSecretStore) -> None:
        self.repository = repository
        self.secrets = secrets

    def config(self) -> dict:
        saved = self.repository.get_setting("mcp_search", {}) or {}
        return {
            "name": saved.get("name", "Tavily"),
            "url": saved.get("url", "https://mcp.tavily.com/mcp/"),
            "tool_name": saved.get("tool_name", "tavily_search"),
            "enabled": bool(saved.get("enabled", False)),
            "has_api_key": bool(saved.get("secret_ref")),
            "network_mode": saved.get("network_mode", "inherit"),
            "proxy_url": saved.get("proxy_url", ""),
            "proxy_username": saved.get("proxy_username", ""),
            "has_proxy_password": bool(saved.get("proxy_password_ref")),
        }

    def save(self, values: dict) -> dict:
        old = self.repository.get_setting("mcp_search", {}) or {}
        parts = urlsplit(values["url"])
        if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
            raise ValueError("请输入有效的 HTTP(S) MCP 地址，密钥请单独填写")
        if any(key.lower() in {"tavilyapikey", "api_key", "key", "token"} for key, _ in parse_qsl(parts.query)):
            raise ValueError("请将密钥填在独立的密钥输入框，不要写进地址")
        same_host = urlsplit(old.get("url", "")).hostname == parts.hostname
        secret_ref = old.get("secret_ref") if same_host else None
        if not same_host and old.get("secret_ref"):
            self.secrets.delete(old["secret_ref"])
        if values.get("api_key"):
            secret_ref = self.secrets.set(values["api_key"], secret_ref)
        proxy_password_ref = old.get("proxy_password_ref")
        if values.get("proxy_password"):
            proxy_password_ref = self.secrets.set(values["proxy_password"], proxy_password_ref)
        self.repository.set_setting("mcp_search", {
            "name": values["name"].strip(), "url": values["url"].strip(),
            "tool_name": values["tool_name"].strip(), "enabled": values["enabled"],
            "secret_ref": secret_ref,
            "network_mode": values.get("network_mode", "inherit"),
            "proxy_url": values.get("proxy_url", "").strip(),
            "proxy_username": values.get("proxy_username", "").strip(),
            "proxy_password_ref": proxy_password_ref,
        })
        return self.config()

    def _connect(self):
        config = self.repository.get_setting("mcp_search", {}) or {}
        if not config.get("enabled"):
            raise ValueError("请先在设置中启用搜索 MCP")
        url = config.get("url", "")
        key = self.secrets.get(config.get("secret_ref"))
        parts = urlsplit(url)
        if parts.hostname == "mcp.tavily.com":
            if not key:
                raise ValueError("Tavily MCP 缺少 API Key")
            url = urlunsplit(parts._replace(query=urlencode([*parse_qsl(parts.query), ("tavilyApiKey", key)])))
        headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if key and parts.hostname != "mcp.tavily.com":
            headers["Authorization"] = f"Bearer {key}"
        return config, url, headers

    def _client_options(self, config: dict, url: str) -> dict:
        resolved = NetworkSettings(self.repository, self.secrets).resolve(config)
        try:
            routes = AIProviderGateway._network_routes(
                url, resolved["network_mode"], resolved["proxy_url"], resolved["proxy_username"], resolved["proxy_password"],
            )
        except ProviderConnectionError as exc:
            raise ValueError(str(exc)) from exc
        return {"proxy": routes[0][1], "trust_env": False, "verify": AIProviderGateway._ssl_verification()}

    @staticmethod
    def _response(response: httpx.Response) -> dict:
        response.raise_for_status()
        if "text/event-stream" in response.headers.get("content-type", ""):
            messages = [json.loads(line[5:].strip()) for line in response.text.splitlines() if line.startswith("data:") and line[5:].strip() != "[DONE]"]
            payload = next((item for item in messages if "result" in item or "error" in item), {})
        else:
            payload = response.json()
        if payload.get("error"):
            raise ValueError(f"MCP 返回错误：{payload['error'].get('message', '未知错误')}")
        return payload.get("result") or {}

    def _session(self, client: httpx.Client, url: str, headers: dict):
        init = client.post(url, headers=headers, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "Content Intelligence Canvas", "version": "0.3.28"}},
        })
        if init.status_code in {400, 404, 405, 422} or (init.status_code == 200 and "application/json" in init.headers.get("content-type", "") and init.json().get("error", {}).get("code") == -32601):
            # MCP 2026-07-28 uses independent, stateless requests instead of initialize.
            return {**headers, "MCP-Protocol-Version": "2026-07-28"}
        result = self._response(init)
        session = init.headers.get("mcp-session-id")
        headers = {**headers, "MCP-Protocol-Version": result.get("protocolVersion", "2025-11-25")}
        if session:
            headers["Mcp-Session-Id"] = session
        client.post(url, headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"}).raise_for_status()
        return headers

    def _tools(self, client: httpx.Client, url: str, headers: dict) -> list[dict]:
        modern = headers.get("MCP-Protocol-Version") == "2026-07-28"
        params = {"_meta": {"io.modelcontextprotocol/clientInfo": {"name": "Content Intelligence Canvas", "version": "0.3.28"}}} if modern else {}
        response = client.post(url, headers={**headers, **({"Mcp-Method": "tools/list"} if modern else {})}, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": params})
        return self._response(response).get("tools", [])

    def test(self) -> dict:
        started = time.perf_counter()
        config, url, headers = self._connect()
        try:
            with httpx.Client(timeout=25, follow_redirects=True, **self._client_options(config, url)) as client:
                headers = self._session(client, url, headers)
                tools = self._tools(client, url, headers)
        except httpx.HTTPError as exc:
            raise ValueError(f"MCP 连接失败：{type(exc).__name__}；请检查网络和代理设置") from exc
        names = [item.get("name", "") for item in tools]
        return {"tools": names, "message": f"已连接 {config.get('name')}，发现 {len(names)} 个工具",
                "latency_ms": round((time.perf_counter() - started) * 1000),
                "endpoint": config.get("url"), "search_tool": config.get("tool_name"),
                "search_tool_available": config.get("tool_name") in names,
                "network_mode": config.get("network_mode", "auto")}

    def search(self, query: str) -> list[dict]:
        config, url, headers = self._connect()
        token = current_token()
        check_cancelled()
        try:
            with httpx.Client(timeout=50, follow_redirects=True, **self._client_options(config, url)) as client:
                if token:
                    token.bind(client)
                try:
                    headers = self._session(client, url, headers)
                    tools = self._tools(client, url, headers)
                    requested = config.get("tool_name", "tavily_search")
                    tool = next((item for item in tools if item.get("name") == requested), None)
                    if not tool:
                        raise ValueError(f"MCP 未提供搜索工具 {requested}；可用工具：{', '.join(item.get('name', '') for item in tools)}")
                    properties = (tool.get("inputSchema") or {}).get("properties") or {}
                    query_field = "query" if "query" in properties or not properties else "q" if "q" in properties else None
                    if not query_field:
                        raise ValueError(f"搜索工具 {requested} 缺少 query 或 q 参数，请选择兼容的搜索工具")
                    arguments = {query_field: query[:400]}
                    if "max_results" in properties:
                        arguments["max_results"] = 5
                    modern = headers.get("MCP-Protocol-Version") == "2026-07-28"
                    params = {"name": requested, "arguments": arguments}
                    if modern:
                        params["_meta"] = {"io.modelcontextprotocol/clientInfo": {"name": "Content Intelligence Canvas", "version": "0.3.28"}}
                    result = self._response(client.post(url, headers={**headers, **({"Mcp-Method": "tools/call", "Mcp-Name": requested} if modern else {})}, json={
                        "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": params,
                    }))
                finally:
                    if token:
                        token.unbind(client)
        except httpx.HTTPError as exc:
            check_cancelled()
            raise ValueError(f"MCP 检索失败：{type(exc).__name__}；请检查网络和代理设置") from exc
        check_cancelled()
        if result.get("isError"):
            raise ValueError("MCP 搜索工具返回错误：" + str(result.get("content", ""))[:300])
        structured = result.get("structuredContent")
        content = structured if isinstance(structured, dict) else None
        if not content:
            blocks = result.get("content", [])
            text = "\n".join(item.get("text", "") for item in blocks if item.get("type") == "text")
            try:
                content = json.loads(text)
            except (ValueError, TypeError):
                # Official Tavily MCP formats search hits as Title / URL / Content lines.
                links = list(re.finditer(r"(?m)^URL: (https?://\S+)", text))
                items = []
                for index, match in enumerate(links[:6]):
                    before = text[max(0, match.start() - 400):match.start()]
                    title = re.findall(r"(?m)^Title: (.+)$", before)
                    after = text[match.end():links[index + 1].start() if index + 1 < len(links) else len(text)]
                    excerpt = after.partition("Content: ")[2].split("\nRaw Content:", 1)[0].strip()
                    items.append({"title": title[-1] if title else match.group(1), "url": match.group(1), "content": excerpt})
                content = {"results": items}
        items = content.get("results", []) if isinstance(content, dict) else content if isinstance(content, list) else []
        if isinstance(items, dict):
            items = [items]
        if not items:
            raise ValueError("MCP 搜索没有返回可引用的网络结果")
        return [{"title": str(item.get("title", ""))[:200], "url": str(item.get("url", ""))[:1200],
                 "excerpt": str(item.get("content", item.get("snippet", "")))[:1600], "provider": config.get("name")}
                for item in items[:6] if isinstance(item, dict)]
