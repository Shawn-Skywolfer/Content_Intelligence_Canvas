"""Safe, user-exportable diagnostics; hide credentials; provider reasoning is recorded only in the explicit provider_reasoning field."""
from __future__ import annotations
import re
from typing import Any


def safe_log(value: Any) -> Any:
    if isinstance(value, str):
        value = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "[密钥已隐藏]", value)
        value = re.sub(r"(?i)(Bearer\s+)\S+", r"\1[已隐藏]", value)
        value = re.sub(r"(https?://)[^/@\s]+:[^/@\s]+@", r"\1[凭据已隐藏]@", value)
        return re.sub(r"(?i)([?&](?:api[_-]?key|token|access_token|key|secret|password)=)[^&\s]+", r"\1[已隐藏]", value)
    if isinstance(value, dict):
        return {key: "[已隐藏]" if any(word in key.lower() for word in ("api_key", "password", "authorization", "reasoning_content")) else safe_log(item) for key, item in value.items()}
    if isinstance(value, list):
        return [safe_log(item) for item in value]
    return value
