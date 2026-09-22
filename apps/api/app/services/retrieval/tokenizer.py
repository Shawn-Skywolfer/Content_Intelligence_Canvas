from __future__ import annotations

import re
from collections.abc import Iterable

LATIN_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.+-]*")
CJK_RUN_RE = re.compile(r"[\u3400-\u9fff]+")
STOP_TOKENS = {
    "为什么", "为什", "什么", "可以", "如何", "怎么", "哪些", "内容", "观点",
    "问题", "重要", "的是", "什么内", "么内容", "内容观", "容观点",
}


def tokenize(text: str) -> list[str]:
    lowered = text.lower()
    tokens = LATIN_RE.findall(lowered)
    for run in CJK_RUN_RE.findall(lowered):
        if len(run) == 1:
            tokens.append(run)
            continue
        tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
        if len(run) >= 3:
            tokens.extend(run[i : i + 3] for i in range(len(run) - 2))
    return [token for token in tokens if token not in STOP_TOKENS]


def unique_terms(text: str) -> set[str]:
    return set(tokenize(text))


def contains_any(text: str, terms: Iterable[str]) -> bool:
    haystack = text.lower()
    return any(term.lower() in haystack for term in terms if term)
