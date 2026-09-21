# Retrieval slice architecture

```text
Local Wiki (read-only)
  -> LocalVaultConnector
  -> WikiMarkdownParser
  -> HeadingAwareChunker
  -> LocalHashEmbeddingProvider
  -> LanceDB chunks + SQLite manifest/link graph
  -> BM25 + vector rankings
  -> reciprocal-rank fusion
  -> one-hop WikiLink expansion
  -> heuristic rerank
  -> KnowledgeHit[] with evidence metadata
```

## Decisions

1. The source Wiki is never written to. All runtime artifacts live under `CIC_DATA_DIR`.
2. The file system, not `index.md`, is the document inventory.
3. Document and chunk identifiers are stable SHA-256-derived identifiers.
4. A failed file is reported as a warning and does not abort the source refresh.
5. The offline embedding is an explicit baseline adapter, not a claim of production semantic quality.
6. Every result exposes lexical/vector ranks, WikiLink provenance, file, heading, line range, excerpt and original URLs.
7. Retrieval parameters live in one configuration object.

## Next adapters

- OpenAI-compatible embedding provider;
- external cross-encoder/rerank provider;
- SQLite/Alembic business schema for Projects/Canvas/Nodes/Runs;
- provider health center and keyring-backed secrets.

