# 内容智能工作台：Linux/K8s 源码版

本版本按《应用构建与部署指导文档》v2.8 的 front_end 形态制作。与旧 Windows ZIP 不同，本包不携带 Python、Windows EXE、预装依赖或业务数据，依赖由平台镜像安装，上传体积更小；没有改动 AI 推理算法来宣称运行加速。

## 上传与平台配置

上传外层完整的 `ContentWorkbench-14位时间戳.zip`，不要单独上传里面的 ZIP。根目录含 `front.zip` 和触发 Linux/K8s 链路的 `backend.zip`；前者为静态网页，后者为实际后端源码。服务名为 `ContentWorkbench`，无 WinOs 前缀。平台按自己的 Dockerfile 构建，无需另建 Windows 服务。

backend.zip 根目录同时提供 requirement.txt、requirements.txt、requirements.lock.txt 和 manage.py，检测信号 requirement.txt 为单数。依赖清单引用锁文件。平台应使用 Python 3.11.4，运行 `python manage.py`，安装命令为 `pip install -r requirement.txt`。

必要环境变量：

| 变量 | 值或含义 |
|---|---|
| SERVICE_PREFIX | `/ContentWorkbench`，与前端构建前缀和 Ingress 一致 |
| HOST | `0.0.0.0` |
| PORT | 平台分配的服务端口，未设置默认 8000 |
| DATA_DIR | **必须指向 PVC 挂载目录**，例如 `/data/content-workbench`；未设置兼容默认 `data/`，生产环境不能使用临时容器目录 |
| CORS_ORIGINS | 实际访问域名（仅协议、主机和端口，不带服务路径）；多个用逗号分隔。平台域名尚未提供，不能在包中猜写；同域同源访问不依赖跨域放行 |
| CIC_SERVER_PASSWORD | 可选的工作台 Basic 登录密码，通过平台环境变量配置；不设置时依靠平台已有身份与访问控制 |
| CIC_SERVER_USERNAME | 开启工作台登录后的用户名，默认 admin |

该服务面向受控内网共享空间；平台须设置访问权限与 HTTPS。多个用户共享项目、设置、模型密钥和知识库，不提供租户隔离。若平台网关会替换 Authorization，请使用平台身份控制，不要同时开启会冲突的应用 Basic 登录。

## 路径与健康检查

网页使用相对资源路径。API 及下载链接都通过统一封装加 `/ContentWorkbench` 前缀。Ingress 保留服务前缀转发后端，由后端中间件剥离，并设置 root_path。业务接口不要在 Ingress 再剥一次前缀。

`GET /ContentWorkbench/api/health` 无需登录，返回 `200 {"status":"ok"}`。为兼容平台本地探针，`/api/health` 和任意以 `/api/health`、`/healthz` 结尾的探针路径同样返回 200；**健康接口是前缀严格检查的例外**。普通业务接口 `/api/projects` 必须返回 404；带前缀的 `/ContentWorkbench/api/projects` 才会进入路由（如启用应用鉴权，先返回 401）。探针不访问数据库或模型。

指导书一处要求裸 `/api/health` 返回 200，另一处对照检查要求其返回 404；本实现优先满足统一健康检查要求，使用普通业务接口验证前缀隔离。

## 持久化与使用

使用**单副本、单 worker、单写者**，更新策略建议 Recreate，避免滚动期间双进程并发持有 SQLite/LanceDB 和任务注册表。SQLite 使用 WAL。数据、上传 Wiki、密钥、索引和日志全部进入 DATA_DIR；代码包内不含 data/、数据库、密钥或现有用户数据。不要把 PVC 同时挂给多个运行副本。

部署后，在设置中配置模型及代理/MCP；可上传 Wiki ZIP，保留 _agent_context 的 overview.md 和 domain-map.md，然后刷新索引。客户端本机的 D 盘路径不能当作容器路径；也可把知识库挂载到容器并填写容器可读路径。模型、搜索和 MCP 都从后端发起，服务器必须能访问相应地址。

项目、研究、白板编辑、AI 共创、资产导出沿用原功能。进程重启时未完成任务会被标为中断，可重试；平台不得对生成 API 或任务查询返回缓存数据。

## 验收

1. 上传部署返回成功后，检查 Pod Ready，而不是只看上传状态。
2. 访问带服务前缀的健康接口，确认 200；再测业务接口、创建项目、白板、Wiki ZIP 上传。
3. 验证业务 API 和资源地址均位于服务路径下，错误为 `{"error": ...}`，不要把 S3 文件地址当作应用入口。
4. 在设置中配置并测试实际模型与 MCP；本发行测试不使用用户私有密钥。
5. 重建 Pod 后确认 PVC 中的项目和知识库仍存在。

构建测试使用 Python 3.11.4、锁定依赖、实际解包和本地 HTTP 服务；尚未直接登录企业 cloud-deploy-app 或取得实际域名，平台 Dockerfile、PVC、镜像源访问及 Ingress 必须在内部环境最终验证。
