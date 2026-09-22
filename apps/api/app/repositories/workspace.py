from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class WorkspaceRepository:
    """SQLite persistence for projects, canvases, AI runs and generated assets."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    idea TEXT NOT NULL,
                    brief TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS canvases (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
                    viewport_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS canvas_nodes (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'exploring',
                    locked INTEGER NOT NULL DEFAULT 0,
                    x REAL NOT NULL DEFAULT 0,
                    y REAL NOT NULL DEFAULT 0,
                    width REAL NOT NULL DEFAULT 360,
                    height REAL NOT NULL DEFAULT 220,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_by TEXT NOT NULL DEFAULT 'user',
                    parent_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_nodes_project ON canvas_nodes(project_id);
                CREATE TABLE IF NOT EXISTS canvas_edges (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                    source_node_id TEXT NOT NULL,
                    target_node_id TEXT NOT NULL,
                    relation TEXT NOT NULL DEFAULT 'context',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_edges_project ON canvas_edges(project_id);
                CREATE TABLE IF NOT EXISTS ai_runs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    action TEXT NOT NULL,
                    prompt TEXT NOT NULL DEFAULT '',
                    input_node_ids_json TEXT NOT NULL DEFAULT '[]',
                    output_node_ids_json TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL,
                    provider_name TEXT,
                    model_name TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS content_assets (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    format TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    evidence_json TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL DEFAULT 'draft',
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_assets_project ON content_assets(project_id);
                CREATE TABLE IF NOT EXISTS provider_configs (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    protocol TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    secret_ref TEXT,
                    model_name TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    is_external INTEGER NOT NULL DEFAULT 1,
                    temperature REAL NOT NULL DEFAULT 0.3,
                    max_tokens INTEGER NOT NULL DEFAULT 3000,
                    timeout_seconds INTEGER NOT NULL DEFAULT 60,
                    extra_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )

    @staticmethod
    def _decode(row: sqlite3.Row | None, *json_fields: str) -> dict[str, Any] | None:
        if row is None:
            return None
        item = dict(row)
        for field in json_fields:
            if field in item:
                item[field.removesuffix("_json")] = json.loads(item.pop(field) or "{}")
        if "locked" in item:
            item["locked"] = bool(item["locked"])
        if "enabled" in item:
            item["enabled"] = bool(item["enabled"])
        if "is_external" in item:
            item["is_external"] = bool(item["is_external"])
        return item

    def create_project(self, name: str, idea: str, brief: str = "") -> dict[str, Any]:
        project_id = f"prj_{uuid.uuid4().hex}"
        canvas_id = f"cnv_{uuid.uuid4().hex}"
        now = utc_now()
        with self._connect() as db:
            db.execute(
                "INSERT INTO projects(id,name,idea,brief,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (project_id, name, idea, brief, now, now),
            )
            db.execute(
                "INSERT INTO canvases(id,project_id,viewport_json,updated_at) VALUES(?,?,?,?)",
                (canvas_id, project_id, json.dumps({"x": 0, "y": 0, "zoom": 1}), now),
            )
        idea_node = self.create_node(
            project_id,
            {"type": "idea", "title": "原始想法", "body": idea, "x": 80, "y": 120},
        )
        self.create_node(
            project_id,
            {
                "type": "brief",
                "title": "内容简报",
                "body": brief or "可在此补充目标受众、传播目标、语气和限制条件。",
                "x": 80,
                "y": 390,
                "parent_id": idea_node["id"],
            },
        )
        return self.get_project(project_id) or {}

    def list_projects(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM projects ORDER BY updated_at DESC")]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
            return dict(row) if row else None

    def update_project(self, project_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {key: value for key, value in values.items() if key in {"name", "idea", "brief", "status"}}
        if not allowed:
            return self.get_project(project_id)
        allowed["updated_at"] = utc_now()
        assignments = ",".join(f"{key}=?" for key in allowed)
        with self._connect() as db:
            db.execute(
                f"UPDATE projects SET {assignments} WHERE id=?",
                (*allowed.values(), project_id),
            )
        return self.get_project(project_id)

    def _canvas_id(self, project_id: str) -> str:
        with self._connect() as db:
            row = db.execute("SELECT id FROM canvases WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            raise KeyError("Project canvas not found")
        return str(row["id"])

    def get_canvas(self, project_id: str) -> dict[str, Any]:
        with self._connect() as db:
            canvas = db.execute("SELECT * FROM canvases WHERE project_id=?", (project_id,)).fetchone()
            if not canvas:
                raise KeyError("Project canvas not found")
            nodes = db.execute(
                "SELECT * FROM canvas_nodes WHERE project_id=? ORDER BY created_at", (project_id,)
            ).fetchall()
            edges = db.execute(
                "SELECT * FROM canvas_edges WHERE project_id=? ORDER BY created_at", (project_id,)
            ).fetchall()
        return {
            "id": canvas["id"],
            "project_id": project_id,
            "viewport": json.loads(canvas["viewport_json"] or "{}"),
            "updated_at": canvas["updated_at"],
            "nodes": [self._decode(row, "metadata_json") for row in nodes],
            "edges": [self._decode(row, "metadata_json") for row in edges],
        }

    def create_node(self, project_id: str, values: dict[str, Any]) -> dict[str, Any]:
        node_id = values.get("id") or f"nod_{uuid.uuid4().hex}"
        now = utc_now()
        canvas_id = self._canvas_id(project_id)
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO canvas_nodes(
                  id,project_id,canvas_id,type,title,body,status,locked,x,y,width,height,
                  metadata_json,created_by,parent_id,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    node_id,
                    project_id,
                    canvas_id,
                    values.get("type", "note"),
                    values.get("title", "未命名节点"),
                    values.get("body", ""),
                    values.get("status", "exploring"),
                    int(bool(values.get("locked", False))),
                    float(values.get("x", 0)),
                    float(values.get("y", 0)),
                    float(values.get("width", 360)),
                    float(values.get("height", 220)),
                    json.dumps(values.get("metadata", {}), ensure_ascii=False),
                    values.get("created_by", "user"),
                    values.get("parent_id"),
                    now,
                    now,
                ),
            )
        if values.get("parent_id"):
            self.create_edge(project_id, values["parent_id"], node_id, "derived_from")
        return self.get_node(node_id) or {}

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM canvas_nodes WHERE id=?", (node_id,)).fetchone()
        return self._decode(row, "metadata_json")

    def update_node(self, project_id: str, node_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get_node(node_id)
        if not current or current["project_id"] != project_id:
            return None
        content_fields = {"type", "title", "body", "status", "metadata", "parent_id"}
        unlocking = current["locked"] and values.get("locked") is False
        protected_changes = {field for field in values if field in content_fields}
        if current["locked"] and protected_changes and not (unlocking and protected_changes <= {"status"}):
            raise ValueError("节点已锁定，不能修改内容")
        allowed_fields = {
            "type", "title", "body", "status", "locked", "x", "y", "width", "height",
            "metadata", "parent_id",
        }
        clean = {key: value for key, value in values.items() if key in allowed_fields}
        if "metadata" in clean:
            clean["metadata_json"] = json.dumps(clean.pop("metadata"), ensure_ascii=False)
        if "locked" in clean:
            clean["locked"] = int(bool(clean["locked"]))
        clean["updated_at"] = utc_now()
        assignments = ",".join(f"{key}=?" for key in clean)
        with self._connect() as db:
            db.execute(
                f"UPDATE canvas_nodes SET {assignments} WHERE id=? AND project_id=?",
                (*clean.values(), node_id, project_id),
            )
            db.execute("UPDATE projects SET updated_at=? WHERE id=?", (utc_now(), project_id))
        return self.get_node(node_id)

    def delete_node(self, project_id: str, node_id: str) -> bool:
        current = self.get_node(node_id)
        if not current or current["project_id"] != project_id:
            return False
        if current["locked"]:
            raise ValueError("节点已锁定，不能删除")
        with self._connect() as db:
            db.execute(
                "DELETE FROM canvas_edges WHERE project_id=? AND (source_node_id=? OR target_node_id=?)",
                (project_id, node_id, node_id),
            )
            db.execute("DELETE FROM canvas_nodes WHERE id=? AND project_id=?", (node_id, project_id))
        return True

    def create_edge(
        self,
        project_id: str,
        source: str,
        target: str,
        relation: str = "context",
        metadata: dict[str, Any] | None = None,
        edge_id: str | None = None,
    ) -> dict[str, Any]:
        edge_id = edge_id or f"edg_{uuid.uuid4().hex}"
        canvas_id = self._canvas_id(project_id)
        now = utc_now()
        with self._connect() as db:
            db.execute(
                """
                INSERT OR REPLACE INTO canvas_edges(
                  id,project_id,canvas_id,source_node_id,target_node_id,relation,metadata_json,created_at
                ) VALUES(?,?,?,?,?,?,?,?)
                """,
                (edge_id, project_id, canvas_id, source, target, relation, json.dumps(metadata or {}), now),
            )
            row = db.execute("SELECT * FROM canvas_edges WHERE id=?", (edge_id,)).fetchone()
        return self._decode(row, "metadata_json") or {}

    def replace_canvas(
        self,
        project_id: str,
        nodes: list[dict[str, Any]],
        edges: list[dict[str, Any]],
        viewport: dict[str, Any],
    ) -> dict[str, Any]:
        existing = {node["id"]: node for node in self.get_canvas(project_id)["nodes"]}
        incoming_ids: set[str] = set()
        for node in nodes:
            node_id = node.get("id")
            if node_id and node_id in existing:
                incoming_ids.add(node_id)
                values = dict(node)
                values.pop("id", None)
                if existing[node_id]["locked"]:
                    allowed_locked = ["x", "y", "width", "height", "locked"]
                    if values.get("locked") is False:
                        allowed_locked.append("status")
                    values = {key: values[key] for key in allowed_locked if key in values}
                self.update_node(project_id, node_id, values)
            else:
                created = self.create_node(project_id, node)
                incoming_ids.add(created["id"])
        for node_id, node in existing.items():
            if node_id not in incoming_ids and not node["locked"]:
                self.delete_node(project_id, node_id)
        with self._connect() as db:
            db.execute("DELETE FROM canvas_edges WHERE project_id=?", (project_id,))
        for edge in edges:
            source = edge.get("source_node_id") or edge.get("source")
            target = edge.get("target_node_id") or edge.get("target")
            if source in incoming_ids and target in incoming_ids:
                self.create_edge(
                    project_id,
                    source,
                    target,
                    edge.get("relation", "context"),
                    edge.get("metadata", {}),
                    edge.get("id"),
                )
        with self._connect() as db:
            db.execute(
                "UPDATE canvases SET viewport_json=?,updated_at=? WHERE project_id=?",
                (json.dumps(viewport), utc_now(), project_id),
            )
            db.execute("UPDATE projects SET updated_at=? WHERE id=?", (utc_now(), project_id))
        return self.get_canvas(project_id)

    def create_run(self, project_id: str, action: str, prompt: str, input_ids: list[str]) -> str:
        run_id = f"run_{uuid.uuid4().hex}"
        with self._connect() as db:
            db.execute(
                """INSERT INTO ai_runs(
                id,project_id,action,prompt,input_node_ids_json,status,created_at
                ) VALUES(?,?,?,?,?,'running',?)""",
                (run_id, project_id, action, prompt, json.dumps(input_ids), utc_now()),
            )
        return run_id

    def finish_run(
        self,
        run_id: str,
        output_ids: list[str],
        provider: str | None,
        model: str | None,
        error: str | None = None,
    ) -> None:
        with self._connect() as db:
            db.execute(
                """UPDATE ai_runs SET output_node_ids_json=?,status=?,provider_name=?,model_name=?,
                error=?,completed_at=? WHERE id=?""",
                (
                    json.dumps(output_ids),
                    "failed" if error else "completed",
                    provider,
                    model,
                    error,
                    utc_now(),
                    run_id,
                ),
            )

    def list_runs(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM ai_runs WHERE project_id=? ORDER BY created_at DESC", (project_id,)
            ).fetchall()
        return [self._decode(row, "input_node_ids_json", "output_node_ids_json") or {} for row in rows]

    def create_asset(
        self,
        project_id: str,
        format_name: str,
        title: str,
        body: str,
        evidence: list[dict[str, Any]],
    ) -> dict[str, Any]:
        asset_id = f"ast_{uuid.uuid4().hex}"
        now = utc_now()
        with self._connect() as db:
            db.execute(
                """INSERT INTO content_assets(
                id,project_id,format,title,body,evidence_json,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?)""",
                (asset_id, project_id, format_name, title, body, json.dumps(evidence, ensure_ascii=False), now, now),
            )
        return self.get_asset(asset_id) or {}

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM content_assets WHERE id=?", (asset_id,)).fetchone()
        return self._decode(row, "evidence_json")

    def list_assets(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM content_assets WHERE project_id=? ORDER BY created_at DESC", (project_id,)
            ).fetchall()
        return [self._decode(row, "evidence_json") or {} for row in rows]

    def upsert_provider(self, values: dict[str, Any]) -> dict[str, Any]:
        provider_id = values.get("id") or f"prv_{uuid.uuid4().hex}"
        now = utc_now()
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO provider_configs(
                  id,name,protocol,base_url,secret_ref,model_name,enabled,is_external,
                  temperature,max_tokens,timeout_seconds,extra_json,created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name,protocol=excluded.protocol,base_url=excluded.base_url,
                  secret_ref=COALESCE(excluded.secret_ref,provider_configs.secret_ref),
                  model_name=excluded.model_name,enabled=excluded.enabled,
                  is_external=excluded.is_external,temperature=excluded.temperature,
                  max_tokens=excluded.max_tokens,timeout_seconds=excluded.timeout_seconds,
                  extra_json=excluded.extra_json,updated_at=excluded.updated_at
                """,
                (
                    provider_id,
                    values["name"],
                    values.get("protocol", "openai_compatible"),
                    values["base_url"].rstrip("/"),
                    values.get("secret_ref"),
                    values["model_name"],
                    int(bool(values.get("enabled", True))),
                    int(bool(values.get("is_external", True))),
                    float(values.get("temperature", 0.3)),
                    int(values.get("max_tokens", 3000)),
                    int(values.get("timeout_seconds", 60)),
                    json.dumps(values.get("extra", {})),
                    now,
                    now,
                ),
            )
        return self.get_provider(provider_id) or {}

    def get_provider(self, provider_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM provider_configs WHERE id=?", (provider_id,)).fetchone()
        return self._decode(row, "extra_json")

    def active_provider(self) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM provider_configs WHERE enabled=1 ORDER BY updated_at DESC LIMIT 1"
            ).fetchone()
        return self._decode(row, "extra_json")

    def list_providers(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM provider_configs ORDER BY updated_at DESC").fetchall()
        return [self._decode(row, "extra_json") or {} for row in rows]

    def set_setting(self, key: str, value: Any) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at""",
                (key, json.dumps(value), utc_now()),
            )

    def get_setting(self, key: str, default: Any = None) -> Any:
        with self._connect() as db:
            row = db.execute("SELECT value_json FROM app_settings WHERE key=?", (key,)).fetchone()
        return json.loads(row["value_json"]) if row else default
