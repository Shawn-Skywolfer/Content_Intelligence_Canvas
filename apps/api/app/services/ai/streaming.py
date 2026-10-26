"""Streaming diagnostics, including reasoning explicitly returned by the user's provider API."""
from __future__ import annotations

import json
import time
import uuid
from threading import Event, Thread, Lock
from contextvars import copy_context
from queue import Queue, Empty
import sys
import traceback
from typing import Any

import httpx

from app.services.ai.cancellation import check_cancelled, current_token


class StreamUnsupported(RuntimeError):
    pass


class ModelStreamTimeout(RuntimeError):
    pass


def _receive_stream(gateway: Any, url: str, *, headers: dict[str, str], payload: dict[str, Any],
                   timeout: float, network_mode: str, proxy_url: str | None,
                   proxy_username: str | None, proxy_password: str | None,
                   activity: dict[str, Any], emit: Any, stop: Event) -> dict[str, Any]:
    token = current_token()
    started = time.monotonic()
    call_id = uuid.uuid4().hex[:12]
    state: dict[str, Any] = {"call_id": call_id, "stage": "connecting", "model": payload["model"],
                             "max_tokens": payload.get("max_tokens"), "content_chars": 0,
                             "reasoning_chars": 0, "chunks": 0}
    last_emit = 0.0
    pending_reasoning: list[str] = []
    telemetry_lock = Lock()
    parts: list[str] = []
    activity["parts"] = parts

    def report(detail: str, *, force: bool = True, level: str = "info") -> None:
        nonlocal last_emit
        with telemetry_lock:
            now = time.monotonic()
            if not force and now - last_emit < 1:
                return
            last_emit = now
            metrics = {**state, "elapsed_seconds": round(now - started, 1)}
            if pending_reasoning:
                # Keep deltas once in persisted logs, rather than duplicating the full transcript each second.
                metrics["provider_reasoning"] = "".join(pending_reasoning)
                metrics["reasoning_source"] = "供应商 API 的 reasoning_content / reasoning 字段"
                pending_reasoning.clear()
        emit(detail, metrics, level)

    def heartbeat() -> None:
        while not stop.wait(5):
            if token and token.event.is_set():
                return
            elapsed = int(time.monotonic() - started)
            idle = int(time.monotonic() - activity["last_content"])
            label = {"connecting": "连接接口", "waiting": "等待模型首段响应", "reasoning": "模型推理中", "output": "接收模型正文"}.get(state["stage"], "等待模型响应")
            try:
                report(f"{label} · 已用 {elapsed} 秒 · 连续 {idle} 秒无新内容 · 已收到正文 {state['content_chars']} 字符、推理 {state['reasoning_chars']} 字符")
            except RuntimeError:
                return

    errors: list[str] = []
    try:
        routes = gateway._network_routes(url, network_mode, proxy_url, proxy_username, proxy_password)
        Thread(target=heartbeat, daemon=True, name=f"ai-progress-{call_id}").start()
        for index, (route, proxy) in enumerate(routes):
            check_cancelled()
            state.update(route=route, stage="connecting", http_status=None)
            report(f"正在通过{route}连接模型 · 第 {index + 1}/{len(routes)} 条线路 · 模型 {payload['model']}")
            received = False
            try:
                with httpx.Client(trust_env=False, proxy=proxy, timeout=httpx.Timeout(timeout, connect=min(timeout, 12)),
                                  follow_redirects=True, verify=gateway._ssl_verification()) as client:
                    if token:
                        token.bind(client)
                    try:
                        with client.stream("POST", url, headers=headers, json={**payload, "stream": True}) as response:
                            activity["response"] = response
                            state.update(http_status=response.status_code, stage="waiting")
                            report(f"{route}已返回 HTTP {response.status_code} · 正在等待模型首段响应")
                            if response.status_code >= 400:
                                response.read()
                                message = gateway._http_error_message("模型请求失败", response)
                                if response.status_code in {400, 422} and "stream" in message.lower():
                                    raise StreamUnsupported(message)
                                if response.status_code in {407, 502, 503, 504} and index + 1 < len(routes):
                                    errors.append(f"{route}：{message}")
                                    report(f"{message}，准备切换下一条线路", level="warning")
                                    continue
                                advice = {400: "检查模型参数及最大输出限制", 401: "检查 API Key", 403: "检查模型访问权限", 404: "检查接口地址和模型 ID", 429: "检查额度或稍后重试"}.get(response.status_code, "检查供应商服务及代理设置")
                                raise RuntimeError(f"{message}。建议：{advice}")
                            if "text/event-stream" not in response.headers.get("content-type", ""):
                                response.read()
                                data = response.json()
                                text = gateway._extract_content(data)
                                message = ((data.get("choices") or [{}])[0].get("message") or {})
                                reasoning = message.get("reasoning_content") or message.get("reasoning")
                                if isinstance(reasoning, str) and reasoning:
                                    with telemetry_lock:
                                        pending_reasoning.append(reasoning)
                                        state["reasoning_chars"] = len(reasoning)
                                state.update(stage="complete", content_chars=len(text), usage=data.get("usage"))
                                report("供应商返回非流式结果，已接收完整响应")
                                activity["result"] = data
                                return data
                            parts.clear()
                            finish: str | None = None
                            done = False
                            event_lines: list[str] = []

                            def consume(raw: str) -> None:
                                nonlocal finish, done, received
                                check_cancelled()
                                if stop.is_set():
                                    raise RuntimeError("本次模型接收已停止")
                                if raw == "[DONE]":
                                    done = True
                                    return
                                try:
                                    data = json.loads(raw)
                                except ValueError as exc:
                                    raise RuntimeError("模型返回了无效的流式数据，请检查接口兼容性") from exc
                                if data.get("error"):
                                    error = data["error"]
                                    raise RuntimeError(f"模型流式响应错误：{error.get('message', error) if isinstance(error, dict) else error}")
                                if data.get("usage"):
                                    state["usage"] = data["usage"]
                                choices = data.get("choices") or []
                                if not choices:
                                    return
                                choice = choices[0]
                                delta = choice.get("delta") or {}
                                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                                content = delta.get("content")
                                if isinstance(reasoning, str) and reasoning:
                                    activity["last_content"] = time.monotonic()
                                    received = True
                                    changed = state["stage"] != "reasoning"
                                    with telemetry_lock:
                                        pending_reasoning.append(reasoning)
                                        state.update(stage="reasoning", reasoning_chars=state["reasoning_chars"] + len(reasoning))
                                    report(f"模型正在推理 · 已收到 {state['reasoning_chars']} 个推理字符", force=changed)
                                if isinstance(content, str) and content:
                                    activity["last_content"] = time.monotonic()
                                    received = True
                                    changed = state["stage"] != "output"
                                    parts.append(content)
                                    if token and (changed or time.monotonic() - last_emit >= 1):
                                        token.partial_output = "".join(parts)
                                    state.update(stage="output", content_chars=state["content_chars"] + len(content))
                                    state["output_preview"] = (str(state.get("output_preview", "")) + content)[-240:]
                                    report(f"正在接收模型正文 · 已收到 {state['content_chars']} 字符", force=changed)
                                state["chunks"] += 1
                                finish = choice.get("finish_reason") or finish

                            for line in response.iter_lines():
                                check_cancelled()
                                if line.startswith("data:"):
                                    event_lines.append(line[5:].lstrip())
                                elif not line and event_lines:
                                    consume("\n".join(event_lines))
                                    event_lines.clear()
                                    if done or finish:
                                        break
                            if event_lines:
                                consume("\n".join(event_lines))
                            check_cancelled()
                            if not finish and not done:
                                raise RuntimeError("模型响应流意外中断，未收到完成标记；已接收草稿已保留，请重试")
                            state.update(stage="complete", finish_reason=finish)
                            report(f"模型响应接收完成 · 正文 {state['content_chars']} 字符 · 结束原因 {finish or 'DONE'}")
                            result = {"choices": [{"message": {"content": "".join(parts)}, "finish_reason": finish}],
                                      "usage": state.get("usage"), "reasoning_chars": state["reasoning_chars"]}
                            activity["result"] = result
                            return result
                    finally:
                        if token:
                            token.unbind(client)
            except (httpx.TransportError, ValueError, OSError) as exc:
                check_cancelled()
                message = gateway._connection_error(exc)
                if received:
                    error_type = ModelStreamTimeout if isinstance(exc, httpx.ReadTimeout) else RuntimeError
                    raise error_type(f"模型生成中断：{message}。已接收草稿已保留，请重试") from exc
                errors.append(f"{route}：{message}")
                report(f"{route}失败：{message}" + ("，尝试下一条线路" if index + 1 < len(routes) else ""), level="warning")
        raise RuntimeError(f"模型网络连接失败：{'；'.join(errors)}。请检查全局网络、模型独立代理和超时设置")
    except Exception as exc:
        check_cancelled()
        state["stage"] = "error"
        report(str(exc), level="warning" if isinstance(exc, StreamUnsupported) else "error")
        raise


def request_stream(gateway: Any, url: str, *, headers: dict[str, str], payload: dict[str, Any],
                   timeout: float, network_mode: str, proxy_url: str | None,
                   proxy_username: str | None, proxy_password: str | None) -> dict[str, Any]:
    """Keep socket reads and diagnostic persistence off the supervising task thread.

    Closing a Windows TLS stream is best effort: it must never be the mechanism
    that the task depends on to regain control after a stalled read.
    """
    token = current_token()
    stop = Event()
    outcome: Queue = Queue(maxsize=1)
    logs: Queue = Queue()
    drained = Event()
    activity: dict[str, Any] = {"last_content": time.monotonic(), "parts": []}
    idle_limit = max(5, min(float(timeout), 60))
    started = time.monotonic()

    def emit(detail: str, metrics: dict[str, Any], level: str) -> None:
        if not stop.is_set():
            logs.put((detail, metrics, level))

    def persist_logs() -> None:
        try:
            while True:
                item = logs.get()
                if item is None:
                    return
                if stop.is_set():
                    return
                if token and token.on_telemetry and not token.event.is_set():
                    try:
                        token.on_telemetry(*item)
                    except Exception:
                        # Diagnostic storage failure cannot block receiving the answer.
                        continue
        finally:
            drained.set()

    def receive() -> None:
        try:
            result = _receive_stream(gateway, url, headers=headers, payload=payload, timeout=timeout,
                                     network_mode=network_mode, proxy_url=proxy_url,
                                     proxy_username=proxy_username, proxy_password=proxy_password,
                                     activity=activity, emit=emit, stop=stop)
            outcome.put((True, result))
        except BaseException as exc:
            outcome.put((False, exc))
        finally:
            logs.put(None)

    context = copy_context()
    reader = Thread(target=lambda: context.run(receive), name="ai-socket-reader", daemon=True)
    writer = Thread(target=persist_logs, name="ai-log-writer", daemon=True)
    writer.start()
    reader.start()
    try:
        while True:
            check_cancelled()
            try:
                ok, value = outcome.get(timeout=0.1)
            except Empty:
                if "result" in activity:
                    # The protocol completed; a hung TLS teardown must not lose the answer.
                    drained.wait(1)
                    check_cancelled()
                    return activity["result"]
                idle = time.monotonic() - activity["last_content"]
                if idle < idle_limit and time.monotonic() - started < 1800:
                    continue
                # Include code locations, never frame locals or request contents.
                frames = sys._current_frames()
                locations = []
                for thread in (reader, writer):
                    frame = frames.get(thread.ident)
                    stack = traceback.extract_stack(frame)[-4:] if frame else []
                    locations.append(thread.name + ": " + " > ".join(
                        f"{entry.filename.rsplit('/', 1)[-1]}:{entry.lineno}({entry.name})" for entry in stack))
                reason = (f"模型连续 {int(idle)} 秒未返回新的正文或推理内容" if idle >= idle_limit
                          else "本次模型调用已达到 30 分钟总时限")
                message = reason + "，已停止等待；已接收草稿已保留。线程诊断：" + "；".join(locations)
                raise ModelStreamTimeout(message)
            # Normally flush every diagnostic, but never join a blocked logger indefinitely.
            drained.wait(1)
            check_cancelled()
            if ok:
                return value
            raise value
    finally:
        stop.set()
        if token:
            token.partial_output = "".join(activity["parts"])
        logs.put(None)
        response = activity.get("response")
        if reader.is_alive() and response is not None:
            def close() -> None:
                try:
                    response.close()
                except Exception:
                    pass
            Thread(target=close, name="close-stalled-model", daemon=True).start()
