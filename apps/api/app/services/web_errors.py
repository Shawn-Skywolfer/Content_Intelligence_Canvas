class WebToolError(ValueError):
    """Keep the upstream HTTP result alongside safe, actionable diagnostics."""

    def __init__(self, operation, http_status=None, reason=None, endpoint="", suggestion=None):
        hints = {
            400: ("请求参数无效", "检查检索语法、网址和请求参数"),
            401: ("密钥无效或无权限", "检查 DeepSeek API Key 并重新保存"),
            402: ("账号余额不足", "检查供应商账户余额"),
            403: ("抓取被安全策略拒绝", "更换允许公开访问的网页"),
            404: ("网页不存在、禁止抓取或无可提取正文", "检查网址或更换来源网页"),
            408: ("请求读取超时", "检查网络后重试"),
            413: ("请求内容超过大小限制", "缩短检索词或网址"),
            429: ("请求频率超限", "稍后重试或减少并行请求"),
            500: ("服务器内部错误", "稍后重试并检查供应商服务状态"),
            502: ("上游服务异常", "稍后重试"),
            503: ("上游服务暂不可用", "稍后重试"),
            504: ("上游网页服务超时", "稍后重试或更换网页"),
        }
        default = hints.get(http_status, ("请求未得到可用结果", "检查网络、代理和请求参数"))
        self.failure = {"operation": operation, "http_status": http_status, "reason": reason or default[0],
                        "suggestion": suggestion or default[1], "endpoint": endpoint,
                        "retryable": http_status in {408, 429, 500, 502, 503, 504}}
        status = f"HTTP {http_status}" if http_status is not None else "未收到 HTTP 响应"
        super().__init__(f"DeepSeek {operation} 失败 · {status} · {self.failure['reason']}。建议：{self.failure['suggestion']}")

    def as_dict(self):
        return dict(self.failure)
