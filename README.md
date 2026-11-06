# 内容智能工作台｜Content Intelligence Workspace

基于本地 LLM Wiki 的研究与内容创作工作台，支持中英双语、可编辑白板、AI 多节点加工和项目内容资产管理。

## 最新完整版

当前应用版本：**v0.3.32**。`main` 是完整源码的统一维护分支，已整合此前桌面端、服务器部署、离线打包及功能修复的 PR。

- [下载 Windows 单体 EXE](https://github.com/Shawn-Skywolfer/Content_Intelligence_Canvas/releases/download/v0.3.32/Content_Intelligence_Canvas_Portable_v0.3.32.exe)
- [下载 main 完整源码 ZIP](https://github.com/Shawn-Skywolfer/Content_Intelligence_Canvas/archive/refs/heads/main.zip)
- [查看 Release](https://github.com/Shawn-Skywolfer/Content_Intelligence_Canvas/releases/tag/v0.3.32)
- [v0.3.32 修复与验证说明](docs/release-v0.3.32.md)
- [English / bilingual guide](docs/BILINGUAL.md)

源码包含前端、Python 后端、数据库与检索逻辑、测试、Windows 启动器和独立服务器打包脚本。公开仓库和 Release 不包含私人 Wiki、API Key、用户日志或项目数据；已有本地数据由独立数据目录保存。

## 使用流程

1. **设置**：配置模型及网络，执行真实短文本测试；添加 Wiki 文件夹或导入 Wiki ZIP，刷新知识源。
2. **项目**：输入研究主题，建立项目。
3. **快速研究**：填写问题、内容简报、知识源和研究发现数量。数量可填 3–20，默认 20；查看执行进度和历史研究。
4. **内容白板**：查看研究节点和引用，编辑 Markdown，连接、分组或多选节点，通过 AI 共创生成下游节点。
5. **内容输出**：选择输出形态，填写正向及负向 Prompt，编辑并确认生成稿件。
6. **内容资产**：按项目管理已确认稿件，支持修改、版本、导出、删除及返回对应白板节点。

没有可用模型、资料不足或调用失败时，应用会明确反馈；不会把模板内容伪装成 AI 研究结果。

## 功能

### LLM Wiki 与研究

- 只读 LocalVaultConnector、Markdown/Wiki Parser、标题分块、SQLite 增量清单与 LanceDB 存储。
- BM25、离线向量、RRF 与 WikiLink 混合召回，由大模型规划检索并理解原始资料。
- 研究前完整读取 `_agent_context/overview.md`、`domain-map.md`；按需读取 `relations.md` 和原始词条。
- 引用保留来源文件、标题层级、行号和原始 URL；内容生成回读继承节点所引用的完整 Wiki 原文。
- 快速研究历史可查看、删除，并返回生成的白板节点。

### 白板与 AI 共创

- 节点添加、删除、拖拽、尺寸调整、Markdown 编辑、摘要与全文展开。
- 四向连接点、有向曲线、关联高亮、布局整理、分组与锁定、撤销/重做和键盘快捷键。
- 按选定上游层级继承上下文；内容简报作为默认创作约束。
- 单节点或多节点 AI 加工生成下游节点，保留来源与提交的 Prompt；未提交草稿按节点独立保存。
- 洞察、质疑、创意模式和笔记支持综合 Wiki 与网页资料。
- 输出形态可在设置中自定义默认 Prompt；稿件确认后保存到项目内容资产。
- 任务监测支持并行任务、详情、暂停、取消、继续/重试、删除已停止任务及 LOG 导出。

### 模型、网页工具与网络

- DeepSeek、AIHubMix 和其他 OpenAI-compatible 供应商；模型列表刷新、多模型配置、配置删除与导入/导出。
- 思考参数、输出预算、超时、真实模型测试，以及供应商支持时的额度查询。
- 全局代理及模型、搜索 MCP、DeepSeek 网页工具的独立网络设置。
- 搜索 MCP 接入；优先选择已启用的 DeepSeek 网页搜索，搜索与抓取可独立开关和测试。
- 搜索语法、HTTP 状态与错误详情；抓取正文可作为模型生成上下文。
- 普通完整响应为默认接收方式；流式接收为可选模式。任务详情显示实际阶段、调用时限及供应商确实返回的诊断内容。

## Windows 绿色版

直接运行 Release 中的 EXE。应用释放自己的版本化运行时，通过本地同源服务访问前后端，并核验、替换上一个应用实例。

用户数据保存在 EXE 所在目录的 `ContentIntelligenceCanvas_Data`；启动器与运行时缓存位于当前用户的应用目录。升级前备份数据目录，将新版 EXE 放在原位置运行，保留数据目录。暂停或失败的 AI 任务可在升级后从任务详情继续或重试。

## 服务器部署

服务器版与 Windows portable 是独立部署链路。完整功能需要 Python 后端服务，不能只托管前端静态文件。

- [Linux/K8s front_end 部署规范](packaging/cloud/DEPLOYMENT.md)
- [离线依赖与交付说明](packaging/cloud/OFFLINE.md)
- [Windows 服务器版说明](packaging/server/README.zh-CN.md)
- `scripts/build_cloud_release.py`：服务器前后端交付包。
- `scripts/verify_cloud_release.py`、`scripts/verify_offline_release.py`：结构与离线依赖验证。

离线交付可包含前端产物和后端 wheelhouse；平台自身的基础镜像、Dockerfile 模板及服务权限仍由部署平台管理。不要把桌面 EXE 上传到 Web/K8s 部署链路。

## 从源码运行

建议使用 Python 3.12 和 Node.js 24。

Windows PowerShell：

```powershell
.\scripts\setup.ps1
.\scripts\dev.ps1
```

macOS / Linux：

```bash
./scripts/setup.sh
./scripts/dev.sh
```

开发前端地址为 `http://localhost:5173`。生产与 portable 前端使用同源 API 地址。

## 测试

```bash
cd apps/api
python -m pytest

cd ../web
npm test
npm run build
```

设置 `CIC_REAL_WIKI` 后可执行真实 Wiki 集成测试；未提供时对应测试会跳过。模拟接口回归不能替代实际供应商与企业网络测试。

GitHub Actions 包含 Linux/Windows 后端测试、前端构建和生产同源检查。Windows Release 另行验证真实 EXE 的冷/热启动、中文与单引号路径、两种解包方式、损坏缓存恢复、连续启动、旧实例退出及项目数据保留。

## 数据边界

- 源 Wiki 只读，刷新不会修改 Markdown 原文。
- API Key 不写入普通 SQLite 表，不进入项目导出；本地密钥独立保存在 `CIC_DATA_DIR/secrets.json`。
- 内部数据保护默认开启，禁止向标记为外部的模型发送内部资料；标记为内部的模型可放行。
- 配置备份含明文密钥与代理密码，应仅保存在可信设备。

## 代码与发布管理

日常开发以 `main` 为基线，功能修复通过 PR 合入 `main`。发布分支用于各自的构建链路，发布后的功能与修复须同步回主分支，避免最新源码只留在发行分支中。Windows 与服务器版分别构建、验证和发布。
