# Content Intelligence Canvas — Retrieval Skeleton

This repository is the first runnable slice of the V1 specification. It focuses on:

- read-only `LocalVaultConnector`;
- tolerant Markdown/Wiki parsing;
- heading-aware chunking;
- SQLite change manifest;
- LanceDB chunk/vector storage;
- BM25 + vector RRF fusion;
- one-hop WikiLink expansion;
- inspectable retrieval reasons and source fidelity;
- a minimal React Search Debug page.

The default embedding implementation is a deterministic, offline feature-hashing baseline. It makes the real Wiki testable without an API key while keeping the `EmbeddingProvider` boundary replaceable.

## Quick start

Requires Python 3.11+ and Node.js 20+; Docker is not required.

```bash
cd apps/api
python -m venv .venv
.venv/bin/pip install -e '.[dev]'

# Index your local Wiki and run the retrieval quality suite
.venv/bin/python -m app.cli evaluate \
  --vault /absolute/path/to/wiki \
  --data-dir ../../../data \
  --cases /absolute/path/to/evaluation-cases.json

# Start the API
CIC_DATA_DIR=../../../data .venv/bin/uvicorn app.main:app --reload --port 8000
```

On Windows PowerShell, use `.venv\\Scripts\\python.exe` and set the environment variable with `$env:CIC_DATA_DIR='../../../data'`.

In another terminal:

```bash
cd apps/web
npm install
npm run dev
```

Open `http://localhost:5173`. Configure the Wiki path, refresh the index, then inspect hybrid search results and their retrieval reasons. The supplied Wiki and evaluation cases are intentionally not committed to this public repository; use local paths for both.

## API flow

```bash
curl -X POST http://localhost:8000/api/knowledge-sources \
  -H 'Content-Type: application/json' \
  -d '{"name":"Real Wiki","root_path":"/absolute/path/to/wiki"}'

curl -X POST http://localhost:8000/api/knowledge-sources/<source-id>/refresh

curl -X POST http://localhost:8000/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"source_id":"<source-id>","query":"your topic","top_k":10}'
```

## Current boundary

This is Sprint A/B scaffolding, not the full P0 Canvas. Project CRUD, LLM health checks, Findings synthesis, Canvas nodes, locking/versioning, Content Concept, output generation and export remain later vertical-slice work.
