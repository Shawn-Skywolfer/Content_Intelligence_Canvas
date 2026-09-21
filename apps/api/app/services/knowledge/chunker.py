from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from app.domain.knowledge import ParsedWikiDocument, WikiChunk
from app.services.knowledge.parser import WIKILINK_RE, normalize_wikilink

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


@dataclass(frozen=True, slots=True)
class _Section:
    heading_path: tuple[str, ...]
    lines: tuple[str, ...]
    start_line: int
    end_line: int


def stable_chunk_id(document_id: str, heading_path: tuple[str, ...], part: int, text: str) -> str:
    raw = f"{document_id}|{'/'.join(heading_path)}|{part}|{text}".encode("utf-8")
    return "chk_" + hashlib.sha256(raw).hexdigest()[:24]


class HeadingAwareChunker:
    def __init__(self, max_chars: int = 1800, min_chars: int = 80) -> None:
        self.max_chars = max_chars
        self.min_chars = min_chars

    def chunk(self, document: ParsedWikiDocument) -> list[WikiChunk]:
        sections = self._sections(document.raw_text)
        chunks: list[WikiChunk] = []
        index = 0
        for section in sections:
            section_text = "\n".join(section.lines).strip()
            if not section_text:
                continue
            for part_no, (part, start_delta, end_delta) in enumerate(self._split(section_text)):
                searchable = f"{document.title}\n{' > '.join(section.heading_path)}\n{part}".strip()
                links = tuple(dict.fromkeys(normalize_wikilink(x) for x in WIKILINK_RE.findall(part)))
                declared = (
                    document.metadata.get("最后更新")
                    or document.metadata.get("更新时间")
                    or document.metadata.get("更新日期")
                )
                chunks.append(
                    WikiChunk(
                        chunk_id=stable_chunk_id(document.document_id, section.heading_path, part_no, part),
                        document_id=document.document_id,
                        source_id=document.source_id,
                        title=document.title,
                        document_type=document.document_type,
                        heading_path=section.heading_path,
                        text=searchable,
                        chunk_index=index,
                        source_path=document.relative_path,
                        start_line=section.start_line + start_delta,
                        end_line=min(section.end_line, section.start_line + end_delta),
                        wikilink_targets=links,
                        references=document.references,
                        declared_updated_at=declared,
                    )
                )
                index += 1
        return chunks

    def _sections(self, text: str) -> list[_Section]:
        lines = text.splitlines()
        stack: list[tuple[int, str]] = []
        sections: list[_Section] = []
        current: list[str] = []
        current_path: tuple[str, ...] = ()
        start_line = 1

        def flush(end_line: int) -> None:
            nonlocal current
            if any(line.strip() for line in current):
                sections.append(_Section(current_path, tuple(current), start_line, end_line))
            current = []

        for line_no, line in enumerate(lines, start=1):
            match = HEADING_RE.match(line)
            if not match:
                current.append(line)
                continue
            level = len(match.group(1))
            heading = match.group(2).strip()
            if level == 1:
                if current:
                    flush(line_no - 1)
                stack = [(1, heading)]
                current_path = ()
                start_line = line_no + 1
                continue
            flush(line_no - 1)
            stack = [item for item in stack if item[0] < level]
            stack.append((level, heading))
            current_path = tuple(value for lvl, value in stack if lvl >= 2)
            start_line = line_no
            current = [line]
        flush(len(lines))
        return sections

    def _split(self, text: str) -> list[tuple[str, int, int]]:
        if len(text) <= self.max_chars:
            line_count = max(0, text.count("\n"))
            return [(text, 0, line_count)]

        blocks = re.split(r"\n\s*\n", text)
        parts: list[tuple[str, int, int]] = []
        buffer: list[str] = []
        consumed_lines = 0
        part_start = 0

        def emit() -> None:
            nonlocal buffer, part_start
            if not buffer:
                return
            joined = "\n\n".join(buffer).strip()
            end = part_start + joined.count("\n")
            parts.append((joined, part_start, end))
            buffer = []
            part_start = consumed_lines

        for block in blocks:
            block = block.strip()
            if not block:
                consumed_lines += 1
                continue
            projected = len("\n\n".join(buffer + [block]))
            if buffer and projected > self.max_chars:
                emit()
            if len(block) > self.max_chars:
                emit()
                lines = block.splitlines()
                small: list[str] = []
                small_start = consumed_lines
                for line in lines:
                    if small and len("\n".join(small + [line])) > self.max_chars:
                        joined = "\n".join(small)
                        parts.append((joined, small_start, small_start + len(small) - 1))
                        small_start += len(small)
                        small = []
                    small.append(line)
                if small:
                    parts.append(("\n".join(small), small_start, small_start + len(small) - 1))
            else:
                buffer.append(block)
            consumed_lines += block.count("\n") + 2
        emit()
        return [part for part in parts if len(part[0]) >= self.min_chars] or [(text, 0, text.count("\n"))]

