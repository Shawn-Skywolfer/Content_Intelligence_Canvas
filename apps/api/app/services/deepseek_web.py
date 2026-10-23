from __future__ import annotations

import copy
import threading
import time
import uuid
from typing import Callable
from urllib.parse import urlsplit

from app.repositories.workspace import WorkspaceRepository
from app.schemas.workspace import DeepSeekWebConfig
from app.services.ai.cancellation import CancellationToken, OperationCancelled, cancellation_scope, check_cancelled, current_token
from app.services.ai.gateway import AIProviderGateway, ProviderConnectionError
from app.services.ai.secret_store import LocalSecretStore


class DeepSeekWebService:
    """Native DeepSeek Search/Fetch API, separate from the optional MCP transport."""

    def __init__(self, repository: WorkspaceRepository, secrets: LocalSecretStore) -> None:
        self.repository, self.secrets = repository, secrets

    @staticmethod
    def validate(values: dict) -> None:
        parts = urlsplit(values["base_url"].strip())
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or parts.path.rstrip("/") not in {"", "/v1"}:
            raise ValueError("DeepSeek 地址须为 HTTP(S) 根地址或 /v1，不能含账号、密码或查询参数")

    def config(self) -> dict:
        saved = self.repository.get_setting("deepseek_web", {}) or {}
        defaults = DeepSeekWebConfig().model_dump(exclude={"api_key", "proxy_password"})
        return {**defaults, **{key: saved[key] for key in defaults if key in saved},
                "has_api_key": bool(self.secrets.get(saved.get("secret_ref"))), "has_proxy_password": bool(saved.get("proxy_password_ref"))}

    def save(self, values: dict) -> dict:
        values = DeepSeekWebConfig.model_validate(values).model_dump()
        self.validate(values)
        old = self.repository.get_setting("deepseek_web", {}) or {}
        same_host = urlsplit(old.get("base_url", "")).hostname == urlsplit(values["base_url"]).hostname
        secret_ref = old.get("secret_ref") if same_host else None
        if not same_host and old.get("secret_ref"):
            self.secrets.delete(old["secret_ref"])
        if values["api_key"].strip():
            secret_ref = self.secrets.set(values["api_key"].strip(), secret_ref)
        password_ref = old.get("proxy_password_ref")
        if values["proxy_password"]:
            password_ref = self.secrets.set(values["proxy_password"], password_ref)
        clean = {key: value for key, value in values.items() if key not in {"api_key", "proxy_password"}}
        clean.update(base_url=values["base_url"].strip().rstrip("/"), secret_ref=secret_ref, proxy_password_ref=password_ref)
        self.repository.set_setting("deepseek_web", clean)
        return self.config()

    def _post(self, operation: str, payload: dict, progress: Callable[[str], None] | None = None) -> tuple[dict, dict]:
        saved = self.repository.get_setting("deepseek_web", {}) or {}
        config = self.config()
        if not config["enabled"]:
            raise ValueError("请先在 MCP 与网页搜索设置中启用 DeepSeek 网页搜索与抓取")
        key = self.secrets.get(saved.get("secret_ref"))
        if not key:
            raise ValueError("DeepSeek 网页工具缺少 API Key，请保存密钥后重试")
        self.validate(config)
        base = config["base_url"].rstrip("/")
        endpoint = f"{base}{'' if base.endswith('/v1') else '/v1'}/tools/{operation}"
        started = time.perf_counter()
        try:
            for attempt in range(2):
                response = AIProviderGateway._request(
                    "POST", endpoint, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json_payload=payload, timeout=config["timeout_seconds"], network_mode=config["network_mode"],
                    proxy_url=config["proxy_url"], proxy_username=config["proxy_username"],
                    proxy_password=self.secrets.get(saved.get("proxy_password_ref")),
                    progress=(lambda detail: progress(detail.replace("模型响应", "网页工具响应").replace("模型结果", "网页工具结果"))) if progress else None,
                )
                if response.status_code not in {408, 429, 500, 502, 503, 504} or attempt:
                    break
                if progress:
                    progress(f"DeepSeek {operation} 暂时返回 HTTP {response.status_code}，正在重试一次")
                token = current_token()
                if token:
                    token.event.wait(0.5)
                else:
                    time.sleep(0.5)
                check_cancelled()

        except ProviderConnectionError as exc:
            raise ValueError(str(exc).replace("模型配置", "DeepSeek 网页工具配置")) from exc
        check_cancelled()
        if response.status_code != 200:
            hints = {401: "密钥无效或无权限", 402: "账号余额不足", 403: "抓取被安全策略拒绝", 404: "网页不存在、禁止抓取或无可提取正文", 429: "请求过于频繁，请稍后重试", 504: "上游网页服务超时"}
            raise ValueError(f"DeepSeek {operation} 失败 · HTTP {response.status_code} · {hints.get(response.status_code, '请求未成功，请检查服务状态与参数')}")
        try:
            data = response.json()
        except ValueError as exc:
            raise ValueError(f"DeepSeek {operation} 返回的内容不是有效 JSON") from exc
        if not isinstance(data, dict) or data.get("error"):
            raise ValueError(f"DeepSeek {operation} 返回异常，未得到可用结果")
        return data, {"http_status": 200, "latency_ms": round((time.perf_counter() - started) * 1000),
                      "endpoint": endpoint, "route": AIProviderGateway._route_label(response)}

    def search_raw(self, query: str, progress: Callable[[str], None] | None = None) -> tuple[list[dict], dict]:
        query = query.strip()[:128]
        if not query:
            raise ValueError("请输入搜索词")
        config = self.config()
        data, trace = self._post("search", {"query": query, "count": config["count"], "need_content": True}, progress)
        if not isinstance(data.get("results"), list):
            raise ValueError("DeepSeek Search 返回缺少 results 数组")
        items = [item for item in data["results"] if isinstance(item, dict) and str(item.get("url", "")).startswith(("https://", "http://"))]
        return items[:config["count"]], {**trace, "query": query, "result_count": len(items)}

    def fetch(self, url: str, progress: Callable[[str], None] | None = None) -> tuple[dict, dict]:
        url = url.strip()
        parts = urlsplit(url)
        if len(url) > 8192 or parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise ValueError("请输入有效 HTTP(S) 网页地址，不能包含用户名和密码")
        data, trace = self._post("fetch", {"url": url}, progress)
        if not isinstance(data.get("content"), str) or not data["content"].strip():
            raise ValueError("DeepSeek Fetch 返回 HTTP 200，但没有可用 Markdown 正文")
        return {"title": str(data.get("title") or ""), "url": url, "content": data["content"]}, {**trace, "content_chars": len(data["content"])}

    def search(self, query: str, progress: Callable[[str], None] | None = None) -> list[dict]:
        report = progress or (lambda _detail: None)
        items, _trace = self.search_raw(query, report)
        if not items:
            raise ValueError("DeepSeek 搜索成功，但没有可引用的网络结果")
        config = self.config()
        results = []
        failures = []
        seen = set()
        for index, item in enumerate(items):
            check_cancelled()
            url = str(item["url"])
            if url in seen:
                continue
            seen.add(url)
            content = item.get("content")
            content = content.strip() if isinstance(content, str) else ""
            method = "search_content"
            if not content:
                report(f"读取网页正文 {index + 1}/{len(items)}：{item.get('title') or url}")
                try:
                    page, _ = self.fetch(url, report)
                    content = page["content"]
                    method = "fetch"
                except OperationCancelled:
                    raise
                except ValueError as exc:
                    failures.append({"url": url, "error": str(exc)})
                    report(f"未取得正文，跳过此页（不用摘要代替）：{url}；{exc}")
                    continue
            report(f"已取得网页正文 {index + 1}/{len(items)}：{len(content)} 字符；{item.get('title') or url}")
            results.append({"title": str(item.get("title") or url)[:200], "url": url,
                            "content": content, "content_chars": len(content), "excerpt": content[:800],
                            "content_source": method, "provider": "DeepSeek Search/Fetch",
                            "date": item.get("date"), "authority": item.get("authority")})
        if not results:
            detail = "；".join(f"{item['url']}：{item['error']}" for item in failures[:3])
            raise ValueError(f"DeepSeek 找到 {len(items)} 条链接，但没有取得任何网页正文。不会使用摘要代替全文。{detail}")
        results[0]["retrieval_report"] = {"searched": len(items), "full_text_pages": len(results),
                                          "content_chars": sum(item["content_chars"] for item in results), "failed_pages": failures}
        report(f"网页上下文已准备：{len(results)} 篇正文，共 {sum(item['content_chars'] for item in results)} 字符；失败跳过 {len(failures)} 篇")
        return results


class WebSearchService:
    def __init__(self, repository: WorkspaceRepository, mcp, deepseek: DeepSeekWebService) -> None:
        self.repository, self.mcp, self.deepseek = repository, mcp, deepseek

    def selection(self) -> dict:
        deepseek = self.deepseek.config()
        mcp = self.mcp.config()
        deepseek_ready = bool(deepseek["enabled"] and deepseek["has_api_key"])
        mcp_ready = bool(mcp["enabled"] and mcp["url"] and mcp["tool_name"])
        provider = "deepseek" if deepseek_ready else "mcp" if mcp_ready else None
        return {"provider": provider, "deepseek_ready": deepseek_ready, "mcp_ready": mcp_ready,
                "message": "优先使用 DeepSeek 网页搜索与抓取" if deepseek_ready else "使用搜索 MCP" if mcp_ready else "尚未启用可用的网页搜索服务"}

    def search(self, query: str, progress: Callable[[str], None] | None = None) -> list[dict]:
        report = progress or (lambda _detail: None)
        selected = self.selection()
        if selected["provider"] == "deepseek":
            report("已自动选择 DeepSeek 网页搜索与抓取（优先）")
            return self.deepseek.search(query, report)
        elif not selected["mcp_ready"]:
            raise ValueError("请先在设置中启用 DeepSeek 网页搜索与抓取并保存 Key，或启用搜索 MCP")
        report("正在使用搜索 MCP 获取网络资料")
        return self.mcp.search(query)


class DeepSeekWebTestJobs:
    def __init__(self, service: DeepSeekWebService) -> None:
        self.service = service
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}

    def start(self, operation: str, query: str, url: str) -> dict:
        job_id = f"webtest_{uuid.uuid4().hex}"
        with self.lock:
            self.jobs[job_id] = {"job_id": job_id, "status": "running", "phase": "准备真实网页工具测试", "started_at": time.time(), "finished_at": None, "events": [], "result": {}, "error": None}
            for old in list(self.jobs)[:-50]:
                if self.jobs[old]["status"] != "running":
                    del self.jobs[old]
        threading.Thread(target=self._run, args=(job_id, operation, query, url), daemon=True).start()
        return self.get(job_id) or {}

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            job = copy.deepcopy(self.jobs.get(job_id))
        if job:
            job["elapsed_seconds"] = round((job["finished_at"] or time.time()) - job["started_at"], 1)
        return job

    def _run(self, job_id: str, operation: str, query: str, url: str) -> None:
        def report(detail: str) -> None:
            with self.lock:
                self.jobs[job_id]["phase"] = detail
                self.jobs[job_id]["events"].append({"at": time.time(), "detail": detail})
        result = {}
        token = CancellationToken()
        timer = threading.Timer(min(180, self.service.config()["timeout_seconds"] * (self.service.config()["count"] + 1)) if operation == "context" else self.service.config()["timeout_seconds"] * (2 if operation == "both" else 1), token.cancel)
        timer.daemon = True
        timer.start()
        try:
            with cancellation_scope(token):
                if operation == "context":
                    report("正在测试完整流程：搜索 → 网页正文 → 模型上下文")
                    pages = self.service.search(query, report)
                    result["context"] = {"page_count": len(pages), "content_chars": sum(page["content_chars"] for page in pages),
                                         "items": [{"title": page["title"], "url": page["url"], "content_chars": page["content_chars"], "content_source": page["content_source"], "preview": page["content"][:2400]} for page in pages],
                                         "failed_pages": pages[0]["retrieval_report"]["failed_pages"]}
                if operation in {"search", "both"}:
                    report("正在执行真实 Search 请求")
                    hits, trace = self.service.search_raw(query, report)
                    result["search"] = {**trace, "items": [{"title": item.get("title"), "url": item["url"], "excerpt": str(item.get("summary") or item.get("snippet") or item.get("content") or "")[:800]} for item in hits]}
                    with self.lock:
                        self.jobs[job_id]["result"] = copy.deepcopy(result)
                    if not hits:
                        raise ValueError("Search 返回 HTTP 200，但没有搜索结果")
                    report(f"Search 通过：HTTP 200，返回 {len(hits)} 条结果")
                if operation in {"fetch", "both"}:
                    report("正在执行真实 Fetch 请求，等待 Markdown 正文")
                    page, trace = self.service.fetch(url, report)
                    result["fetch"] = {**trace, "title": page["title"], "url": url, "preview": page["content"][:2400]}
                    report(f"Fetch 通过：HTTP 200，正文 {len(page['content'])} 字符")
            with self.lock:
                self.jobs[job_id].update(status="completed", phase="真实网页工具测试通过", result=result, finished_at=time.time())
        except Exception as exc:
            message = "网页工具测试超时，连接已中断；请检查网络或调整超时设置" if token.event.is_set() else str(exc)
            with self.lock:
                self.jobs[job_id].update(status="failed", phase="网页工具测试失败", error=message, result=result, finished_at=time.time())
        finally:
            timer.cancel()
