from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.knowledge import router as knowledge_router
from app.api.settings import router as settings_router
from app.api.workspace import router as workspace_router
from app.config import Settings

settings = Settings.from_env()
app = FastAPI(title="Content Intelligence Canvas API", version="0.3.3")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(knowledge_router)
app.include_router(workspace_router)
app.include_router(settings_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "phase": "v0.3.3-portable"}
