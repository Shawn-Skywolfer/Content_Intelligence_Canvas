# 内容智能工作台 Linux 离线依赖版

本包用于 cloud-deploy-app 的 Linux/K8s 链路。上传整个 ContentWorkbench-时间戳.zip，不拆分内部 ZIP；顶层包含 front.zip、backend.zip 和清单。

## 与小体积源码版的区别

前端已编译；后端包含全部锁定的 Python 运行依赖 wheel。requirement.txt 与 requirements.txt 内容一致，强制 --no-index、仅从 ./wheelhouse 安装，并逐项校验 SHA256。部署不需要 npm/pip 依赖镜像源，不需要编译原生 Python 扩展。没有删减白板、研究、知识库、模型配置等功能。

这是完整的应用离线依赖包，**不是容器镜像或操作系统镜像**：平台仍需已备好兼容的 Linux x86_64、CPython 3.11.4 基础镜像（glibc，不能使用 Alpine/musl 或 ARM 镜像）。平台 Dockerfile 须先把完整 backend.zip 内容复制进镜像，再在 backend 根目录执行 pip install -r requirement.txt；如果只复制清单先装依赖，必须将 wheelhouse 同时复制。若 Dockerfile 本身还执行系统包下载或 pip 升级，该平台步骤也需要调整或预先缓存，应用包无法覆盖平台 Dockerfile。

## 配置与启动

- SERVICE_PREFIX=/ContentWorkbench，与网关和前端构建保持一致。
- HOST=0.0.0.0，PORT 由平台注入；入口 python manage.py。
- DATA_DIR 指向持久化 PVC，使用单副本、Recreate 更新策略。
- CORS_ORIGINS 设置实际访问域名；推荐平台统一鉴权、HTTPS。
- 可选 CIC_SERVER_USERNAME（默认 admin）、CIC_SERVER_PASSWORD 启用服务端 Basic 鉴权；避免与平台 Authorization 冲突。
- 健康探针 /api/health 与 /ContentWorkbench/api/health 无鉴权返回 200；无服务前缀的业务接口返回 404。
- API Key、Wiki、项目数据不在公开交付包内。首次部署后在设置页配置模型并上传 Wiki ZIP，数据写入 PVC。现有服务升级沿用同一 DATA_DIR/PVC。
- 离线安装不等于离线 AI：调用外部模型和网页搜索仍需相应网络；可配置内网模型与代理。

## 验证范围

发布流水线在 Linux x86_64、Python 3.11.4 上下载锁定依赖，构建交付包，然后在**禁用外网的网络命名空间**、空白虚拟环境中，从实际 ZIP 安装全部依赖并执行 pip check。随后运行健康检查、鉴权、前缀、项目与白板、Wiki ZIP 上传、重启持久化验收。安装使用无缓存模式并校验哈希。

实际内网平台的基础镜像、Dockerfile、域名、PVC 和入口访问权限仍须部署验收；平台返回 AccessDenied 时应检查访问入口及授权，不能仅凭包已上传认定应用可用。
