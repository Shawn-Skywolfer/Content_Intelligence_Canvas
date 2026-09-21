# Content Intelligence Canvas｜内容智能白板

一个本地优先、内部知识优先的中文内容工作台。它把现有 Markdown / Obsidian Wiki 作为只读可信知识源，完成：

```text
本地 Wiki → 混合检索 → Findings / Evidence → 内容白板共创
          → Content Concept → 微信公众号 / 视频号 / Campaign → 导出
```

## 当前已实现

- 只读 `LocalVaultConnector`、Markdown/Wiki Parser、Heading-aware chunk；
- SQLite 增量清单、LanceDB 分块与向量存储；
- BM25 + 离线向量 + RRF + 一跳 WikiLink 混合检索；
- 完整结果卡片、前后文、文件/标题/行号/原始 URL；
- Top-K、关键词/语义/WikiLink 权重和单文档上限配置；
- 项目、Idea、Brief、Canvas Node / Edge 持久化；
- 节点拖拽、多选、连接、分组、状态、锁定、自动保存；
- Quick Research（纯 Wiki）、4–8 条 Findings、三条创意方向；
- Magic Bar，AI 默认生成新节点，不覆盖原节点；
- Content Concept；
- 微信公众号、视频号/短视频脚本、海报/Campaign 三种独立内容结构；
- Evidence 引用、Run History、单项 Markdown、项目 Markdown/JSON 导出；
- 自定义 OpenAI-compatible 大模型、真实最小调用健康检查；
- 内部数据保护开关；没有可用模型时自动使用本地模板，应用仍可完整运行；
- 全中文界面。

## Windows 快速启动（无需 Docker）

首次运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup.ps1
```

之后启动：

```powershell
.\scripts\dev.ps1
```

浏览器打开 `http://localhost:5173`。

## macOS / Linux

首次运行：

```bash
./scripts/setup.sh
```

启动：

```bash
./scripts/dev.sh
```

## 手动启动

后端：

```bash
cd apps/api
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
CIC_DATA_DIR=../../data .venv/bin/uvicorn app.main:app --reload --port 8000
```

Windows PowerShell 使用 `.venv\Scripts\python.exe`，并设置：

```powershell
$env:CIC_DATA_DIR=(Resolve-Path ..\..\data)
```

前端：

```bash
cd apps/web
npm install
npm run dev
```

## 第一次使用

1. 打开“设置”，添加本地 Wiki 文件夹并点击“刷新索引”；
2. 可选：配置 OpenAI-compatible 大模型，填写 Base URL、模型名和 API Key；
3. 根据模型服务的数据边界设置“内部数据保护”；
4. 在“项目”输入一句想法；
5. 进入“快速研究”，生成 Findings 和创意方向；
6. 在“内容白板”选择节点，通过 Magic Bar 加工并形成 Content Concept；
7. 在“内容资产”生成三种内容，展开审阅并导出。

## 模型与数据安全

- API Key 不写入普通 SQLite 表，不进入项目导出；
- 本地版密钥保存在 `CIC_DATA_DIR/secrets.json`，文件权限在支持的平台设为仅当前用户可读写；
- 内部数据保护默认开启；被标记为“外部”的模型不会收到内部 Wiki 和白板内容；
- 数据保护阻止模型调用时，研究、Magic Bar 和内容生成会自动使用本地模板；
- 源 Wiki 永远只读，刷新索引不会修改任何 Markdown 文件。

## 验证

```bash
cd apps/api
.venv/bin/pytest

cd ../web
npm run build
```

真实 Wiki、质量评测 cases 和包含内部名称的报告不会提交到公开仓库，使用本地绝对路径运行。
