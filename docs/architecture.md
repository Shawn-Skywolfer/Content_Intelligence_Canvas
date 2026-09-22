# V0.2 纵向闭环架构

```text
Local Wiki（只读）
  → Parser / Heading Chunker
  → SQLite Manifest + LanceDB
  → BM25 / Vector / RRF / WikiLink
  → KnowledgeHit + Chunk Detail + Evidence

Project
  → Idea / Brief
  → Quick Research（Internal Only）
  → Findings + Creative Directions
  → Canvas Node / Edge / Lock / Autosave / Run History
  → Magic Bar / Content Concept
  → WeChat / Video Script / Poster Campaign
  → Markdown / JSON Export

Provider Settings
  → OpenAI-compatible Gateway
  → Minimal Health Call
  → Internal Data Boundary
  → Local Template Fallback
```

## 数据存储

- `app.db`：知识源清单、项目、Canvas、节点、边、Run、内容资产和 Provider 非敏感配置；
- `lancedb/`：知识分块及离线向量；
- `secrets.json`：API Key，仅保存在本机数据目录，不进入 SQLite 和项目导出；
- 源 Wiki：始终只读。

## 核心规则

1. Internal First；Quick Research 不联网；
2. AI 加工默认创建新节点；
3. Locked 节点的内容不能被修改或删除；
4. Findings 和输出保留文件、标题层级、行号、Excerpt 与原始参考 URL；
5. 微信、视频与 Campaign 共用 Content Concept 和 Evidence，但使用不同叙事模板；
6. Provider 故障或数据边界阻断不丢失现有内容，自动降级为本地模板；
7. 所有 Canvas 变化自动保存。

## API 分区

- `/api/knowledge-*`：知识源、索引、检索、完整分块；
- `/api/projects/*`：项目、Canvas、节点、研究、Magic Bar、Concept、内容、Run、导出；
- `/api/providers/*`：模型配置与健康检查；
- `/api/settings/security`：内部数据保护。
