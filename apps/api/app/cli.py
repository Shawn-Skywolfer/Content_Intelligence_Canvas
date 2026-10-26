from __future__ import annotations

import argparse
import asyncio
import json
import os
from dataclasses import asdict
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Content Intelligence Canvas retrieval tools")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("index", "evaluate"):
        command = subparsers.add_parser(name)
        command.add_argument("--vault", type=Path, required=True)
        command.add_argument("--data-dir", type=Path, required=True)
        command.add_argument("--name", default="本地知识库")
        if name == "evaluate":
            command.add_argument("--output", type=Path)
            command.add_argument("--cases", type=Path, required=True)
    search = subparsers.add_parser("search")
    search.add_argument("--source-id", required=True)
    search.add_argument("--data-dir", type=Path, required=True)
    search.add_argument("query")
    search.add_argument("--top-k", type=int, default=10)
    return parser


async def run() -> int:
    args = build_parser().parse_args()
    os.environ["CIC_DATA_DIR"] = str(args.data_dir.resolve())
    from app.container import get_container

    container = get_container()
    if args.command in {"index", "evaluate"}:
        report = await container.indexer.refresh(args.name, args.vault.resolve())
        payload: dict = {"index": report.to_dict()}
        if args.command == "evaluate":
            from app.evaluation import evaluate, load_cases

            payload["evaluation"] = evaluate(
                container.retrieval, report.source_id, load_cases(args.cases)
            )
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if not report.warnings else 2
    hits = container.retrieval.search(args.source_id, args.query, args.top_k)
    print(json.dumps([asdict(hit) for hit in hits], ensure_ascii=False, indent=2, default=list))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
