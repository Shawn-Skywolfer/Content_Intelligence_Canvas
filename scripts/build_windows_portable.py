from __future__ import annotations

import argparse
import hashlib
import shutil
import struct
import zipfile
from pathlib import Path


MAGIC = b"CICPACKV032FULL!"


def digest(path: Path, offset: int = 0, size: int | None = None) -> str:
    result = hashlib.sha256()
    remaining = path.stat().st_size - offset if size is None else size
    with path.open("rb") as handle:
        handle.seek(offset)
        while remaining:
            block = handle.read(min(1024 * 1024, remaining))
            if not block:
                raise ValueError("文件提前结束")
            result.update(block)
            remaining -= len(block)
    return result.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("launcher", type=Path)
    parser.add_argument("payload", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with zipfile.ZipFile(args.payload) as archive:
        broken = archive.testzip()
        if broken:
            raise ValueError(f"ZIP 校验失败：{broken}")
    with args.output.open("wb") as target, args.launcher.open("rb") as source:
        shutil.copyfileobj(source, target, 1024 * 1024)
        with args.payload.open("rb") as source:
            shutil.copyfileobj(source, target, 1024 * 1024)
        target.write(struct.pack("<Q", args.payload.stat().st_size))
        target.write(MAGIC)
    total = args.output.stat().st_size
    payload_size = args.payload.stat().st_size
    payload_offset = total - 24 - payload_size
    if digest(args.output, payload_offset, payload_size) != digest(args.payload):
        raise ValueError("内嵌载荷哈希不一致")
    print(f"file_size={total}")
    print(f"payload_size={payload_size}")
    print(f"payload_sha256={digest(args.payload)}")
    print(f"file_sha256={digest(args.output)}")


if __name__ == "__main__":
    main()
