"""平台 Python 源码包入口，不在发布包中携带镜像构建文件。"""
import logging
from logging.handlers import RotatingFileHandler
import os
import uvicorn

if __name__ == "__main__":
    os.environ["CIC_SERVER_MODE"] = "cloud"
    from app.config import Settings
    from app.cloud_deployment import create_cloud_app
    settings = Settings.from_env()
    settings.ensure_dirs()
    handler = RotatingFileHandler(settings.data_dir / "logs" / "server.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8")
    logging.basicConfig(level=logging.WARNING, handlers=[handler, logging.StreamHandler()])
    # SQLite 与内存任务注册表只允许一个工作进程，K8s 侧同样必须配置单副本。
    uvicorn.run(create_cloud_app(), host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8000")),
                workers=1, access_log=False, log_config=None)
