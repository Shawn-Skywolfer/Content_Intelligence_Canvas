from __future__ import annotations

import hashlib
import re
from pathlib import Path

from app.domain.knowledge import KnowledgeDocument, ParsedWikiDocument

H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
META_RE = re.compile(r"\*\*([^*]+?)\*\*\s*[:：]\s*([^|\n]+)")
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
URL_RE = re.compile(r"https?://[^\s)>\]]+")


def stable_document_id(source_id: str, relative_path: str) -> str:
    raw = f"{source_id}:{relative_path}".encode("utf-8")
    return "doc_" + hashlib.sha256(raw).hexdigest()[:24]


def infer_document_type(relative_path: str) -> str:
    name = Path(relative_path).name.lower()
    if name == "index.md":
        return "index"
    if name.startswith("concept-"):
        return "concept"
    if name.startswith("product-"):
        return "product"
    if name.startswith("source-"):
        return "source"
    return "topic"


def normalize_wikilink(value: str) -> str:
    target = value.strip().replace("\\", "/")
    if target.lower().endswith(".md"):
        target = target[:-3]
    return target.strip("/")


class WikiMarkdownParser:
    def parse(self, source_id: str, document: KnowledgeDocument) -> ParsedWikiDocument:
        text = document.text.replace("\r\n", "\n").replace("\r", "\n")
        title_match = H1_RE.search(text)
        title = title_match.group(1).strip() if title_match else Path(document.ref.relative_path).stem

        metadata: dict[str, str] = {}
        for line in text.splitlines()[:20]:
            if not line.lstrip().startswith(">"):
                continue
            for key, value in META_RE.findall(line):
                metadata[key.strip()] = value.strip()

        wikilinks = tuple(dict.fromkeys(normalize_wikilink(x) for x in WIKILINK_RE.findall(text)))
        references = tuple(dict.fromkeys(url.rstrip(".,;，。；") for url in URL_RE.findall(text)))
        return ParsedWikiDocument(
            document_id=stable_document_id(source_id, document.ref.relative_path),
            source_id=source_id,
            relative_path=document.ref.relative_path,
            title=title,
            document_type=infer_document_type(document.ref.relative_path),
            metadata=metadata,
            wikilinks=wikilinks,
            references=references,
            raw_text=text,
            revision=document.revision,
            mtime_ns=document.ref.mtime_ns,
        )
