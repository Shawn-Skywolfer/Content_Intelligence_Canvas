from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


logger = logging.getLogger(__name__)


def read_metadata(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def read_viewport(raw: str | None) -> dict[str, float]:
    try:
        value = json.loads(raw or "{}")
        if isinstance(value, dict) and all(isinstance(value.get(key, 0), (int, float)) for key in ("x", "y", "zoom")):
            return value
    except (TypeError, ValueError):
        pass
    return {"x": 0, "y": 0, "zoom": 1}


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
                CREATE TABLE IF NOT EXISTS magic_jobs (
                    job_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    node_ids_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress INTEGER NOT NULL DEFAULT 0,
                    phase TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    error TEXT,
                    result_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS ix_magic_jobs_project ON magic_jobs(project_id,created_at);
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
            columns = {row["name"] for row in db.execute("PRAGMA table_info(canvas_nodes)")}
            if "summary" not in columns:
                db.execute("ALTER TABLE canvas_nodes ADD COLUMN summary TEXT")
            if "summary_model" not in columns:
                db.execute("ALTER TABLE canvas_nodes ADD COLUMN summary_model TEXT")
            job_columns = {row[1] for row in db.execute("PRAGMA table_info(magic_jobs)")}
            for name, definition in {
                "request_json": "TEXT NOT NULL DEFAULT '{}'",
                "provider_json": "TEXT NOT NULL DEFAULT '{}'",
                "events_json": "TEXT NOT NULL DEFAULT '[]'",
                "attempt": "INTEGER NOT NULL DEFAULT 1",
            }.items():
                if name not in job_columns:
                    db.execute(f"ALTER TABLE magic_jobs ADD COLUMN {name} {definition}")

    @staticmethod
    def _decode(row: sqlite3.Row | None, *json_fields: str) -> dict[str, Any] | None:
        if row is None:
            return None
        item = dict(row)
        for field in json_fields:
            if field in item:
                raw = item.pop(field)
                if field == "metadata_json":
                    item["metadata"] = read_metadata(raw)
                else:
                    try:
                        item[field.removesuffix("_json")] = json.loads(raw or "[]")
                    except (TypeError, ValueError):
                        item[field.removesuffix("_json")] = []
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
        self.create_node(
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
            },
        )
        self.ensure_canvas(project_id)
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

    def delete_project(self, project_id: str) -> bool:
        with self._connect() as db:
            deleted = db.execute("DELETE FROM projects WHERE id=?", (project_id,)).rowcount > 0
            if deleted:
                db.execute("DELETE FROM app_settings WHERE key=?", (f"starter_edges_checked:{project_id}",))
        return deleted

    def _canvas_id(self, project_id: str) -> str:
        with self._connect() as db:
            row = db.execute("SELECT id FROM canvases WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            raise KeyError("Project canvas not found")
        return str(row["id"])

    def ensure_canvas(self, project_id: str) -> None:
        """Repair projects created by older/incomplete builds before opening the canvas."""
        project = self.get_project(project_id)
        if not project:
            raise KeyError("Project not found")
        with self._connect() as db:
            row = db.execute("SELECT id FROM canvases WHERE project_id=?", (project_id,)).fetchone()
            if not row:
                now = utc_now()
                db.execute(
                    "INSERT INTO canvases(id,project_id,viewport_json,updated_at) VALUES(?,?,?,?)",
                    (f"cnv_{uuid.uuid4().hex}", project_id, json.dumps({"x": 0, "y": 0, "zoom": 1}), now),
                )
            node_count = int(
                db.execute("SELECT COUNT(*) FROM canvas_nodes WHERE project_id=?", (project_id,)).fetchone()[0]
            )
            legacy_marker = f"starter_edges_checked:{project_id}"
            already_checked = db.execute("SELECT 1 FROM app_settings WHERE key=?", (legacy_marker,)).fetchone()
        if node_count and already_checked:
            return
        if node_count == 0:
            self.create_node(
                project_id,
                {"type": "idea", "title": "原始想法", "body": project.get("idea", ""), "x": 80, "y": 120},
            )
            self.create_node(
                project_id,
                {
                    "type": "brief",
                    "title": "内容简报",
                    "body": project.get("brief") or "可在此补充目标受众、传播目标、语气和限制条件。",
                    "x": 80,
                    "y": 390,
                },
            )
        self._seed_initial_groups(project_id)
        # Older builds set the brief's parent_id and generated a derived_from edge.
        # Clear that legacy parent marker once, so a later user-drawn edge persists.
        with self._connect() as db:
            starters = db.execute(
                "SELECT id,type,parent_id,metadata_json FROM canvas_nodes WHERE project_id=? AND type IN ('idea','brief')",
                (project_id,),
            ).fetchall()
            ideas = {row["id"] for row in starters if row["type"] == "idea" and read_metadata(row["metadata_json"]).get("starter_group") == "input"}
            for brief in starters:
                if brief["type"] != "brief" or brief["parent_id"] not in ideas or read_metadata(brief["metadata_json"]).get("starter_group") != "input":
                    continue
                db.execute(
                    "DELETE FROM canvas_edges WHERE project_id=? AND source_node_id=? AND target_node_id=? AND relation='derived_from'",
                    (project_id, brief["parent_id"], brief["id"]),
                )
                db.execute("UPDATE canvas_nodes SET parent_id=NULL WHERE id=?", (brief["id"],))
            db.execute("INSERT OR REPLACE INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)", (legacy_marker, 'true', utc_now()))

    def _seed_initial_groups(self, project_id: str) -> None:
        """Add a grouped starter board only while a project still has its two initial nodes."""
        with self._connect() as db:
            rows = db.execute(
                "SELECT id,type FROM canvas_nodes WHERE project_id=? ORDER BY created_at", (project_id,)
            ).fetchall()
        if len(rows) != 2 or {str(row["type"]) for row in rows} != {"idea", "brief"}:
            return
        ids_by_type = {str(row["type"]): str(row["id"]) for row in rows}
        self.update_node(
            project_id, ids_by_type["idea"],
            {"x": 80, "y": 130, "width": 310, "height": 190, "metadata": {"starter_group": "input"}},
        )
        self.update_node(
            project_id, ids_by_type["brief"],
            {"x": 420, "y": 130, "width": 310, "height": 190, "metadata": {"starter_group": "input"}},
        )
        groups = [
            ("input", "01 输入与简报", 40, 40),
            ("research", "02 研究与证据", 820, 40),
            ("thinking", "03 洞察与策略", 40, 690),
            ("output", "04 内容生产", 820, 690),
        ]
        for key, title, x, y in groups:
            self.create_node(
                project_id,
                {
                    "type": "frame", "title": title, "body": "", "x": x, "y": y,
                    "width": 730, "height": 570, "created_by": "system",
                    "metadata": {"starter_frame": True, "group_key": key},
                },
            )
        templates = [
            ("knowledge", "知识材料", "从知识检索加入的原始材料与段落。", 860, 130, "research"),
            ("fact", "事实证据", "可验证的事实、数字与案例。", 1200, 130, "research"),
            ("signal", "变化信号", "值得关注的市场、客户或技术变化。", 860, 350, "research"),
            ("internal_knowledge", "内部知识", "来自内部 Wiki 的观点与方法。", 1200, 350, "research"),
            ("insight", "核心洞察", "把事实和信号转化为有价值的判断。", 80, 780, "thinking"),
            ("challenge", "反向质疑", "检查假设、证据缺口和潜在风险。", 420, 780, "thinking"),
            ("creative_pattern", "创意模式", "沉淀可复用的叙事与表达方式。", 80, 1000, "thinking"),
            ("content_concept", "内容概念", "收敛受众、主张、结构、语气和证据。", 420, 1000, "thinking"),
            ("note", "自由草稿", "输入 Prompt 后，可直接在当前节点生成或改写。", 860, 780, "output"),
            ("output", "内容输出", "公众号、视频脚本和营销内容在这里继续编辑。", 1200, 780, "output"),
        ]
        for node_type, title, body, x, y, group_key in templates:
            self.create_node(
                project_id,
                {
                    "type": node_type, "title": title, "body": body, "x": x, "y": y,
                    "width": 310, "height": 180, "created_by": "system",
                    "metadata": {"starter_template": True, "group_key": group_key},
                },
            )

    def upstream_nodes(
        self, project_id: str, node_ids: list[str], max_depth: int = 6
    ) -> list[dict[str, Any]]:
        """Return directed ancestors, nearest first, while tolerating cycles."""
        canvas = self.get_canvas(project_id)
        by_id = {node["id"]: node for node in canvas["nodes"] if node.get("type") != "frame"}
        incoming: dict[str, list[str]] = {}
        for edge in canvas["edges"]:
            incoming.setdefault(edge["target_node_id"], []).append(edge["source_node_id"])
        selected = set(node_ids)
        seen = set(node_ids)
        frontier = list(node_ids)
        result: list[dict[str, Any]] = []
        for _ in range(max_depth):
            next_frontier: list[str] = []
            for target_id in frontier:
                for source_id in incoming.get(target_id, []):
                    if source_id in seen:
                        continue
                    seen.add(source_id)
                    next_frontier.append(source_id)
                    node = by_id.get(source_id)
                    if node and source_id not in selected:
                        result.append(node)
            if not next_frontier:
                break
            frontier = next_frontier
        return result

    def get_canvas(self, project_id: str) -> dict[str, Any]:
        self.ensure_canvas(project_id)
        try:
            self._layout_completed_research(project_id)
        except (ValueError, TypeError, sqlite3.DatabaseError):
            # Legacy layout is optional: always return the user's original board.
            logger.exception("Could not migrate layout for project %s", project_id)
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
            "viewport": read_viewport(canvas["viewport_json"]),
            "updated_at": canvas["updated_at"],
            "nodes": [self._decode(row, "metadata_json") for row in nodes],
            "edges": [self._decode(row, "metadata_json") for row in edges],
        }

    def _layout_completed_research(self, project_id: str) -> None:
        """Migrate existing research boards once per completed run into three growing columns."""
        seed_titles = {
            "knowledge": ("知识材料", "从知识检索加入的原始材料与段落。"),
            "fact": ("事实证据", "可验证的事实、数字与案例。"),
            "signal": ("变化信号", "值得关注的市场、客户或技术变化。"),
            "internal_knowledge": ("内部知识", "来自内部 Wiki 的观点与方法。"),
            "insight": ("核心洞察", "把事实和信号转化为有价值的判断。"),
            "challenge": ("反向质疑", "检查假设、证据缺口和潜在风险。"),
            "creative_pattern": ("创意模式", "沉淀可复用的叙事与表达方式。"),
            "content_concept": ("内容概念", "收敛受众、主张、结构、语气和证据。"),
            "note": ("自由草稿", "输入 Prompt 后，可直接在当前节点生成或改写。"),
            "output": ("内容输出", "公众号、视频脚本和营销内容在这里继续编辑。"),
        }
        groups = (
            ("input", "01 输入与简报", 40, {"idea", "brief"}),
            ("research", "02 研究与证据", 820, {"knowledge", "fact", "signal", "internal_knowledge"}),
            ("thinking", "03 洞察与策略", 1600, {"insight", "challenge", "creative_pattern", "content_concept"}),
        )
        with self._connect() as db:
            runs = db.execute(
                """SELECT id FROM ai_runs WHERE project_id=? AND action='quick_research'
                AND status='completed' ORDER BY created_at,id""", (project_id,),
            ).fetchall()
            if not runs:
                return
            marker = f"research_layout_v2:{project_id}"
            version = json.dumps([row["id"] for row in runs])
            saved = db.execute("SELECT value_json FROM app_settings WHERE key=?", (marker,)).fetchone()
            if saved and saved["value_json"] == version:
                return
            if saved:
                # Subsequent research runs append below existing cards. Previously edited
                # positions and dimensions are user data and must not be migrated again.
                try:
                    previous_runs = set(json.loads(saved["value_json"]))
                except (TypeError, ValueError):
                    previous_runs = set()
                fresh = db.execute(
                    "SELECT output_node_ids_json FROM ai_runs WHERE project_id=? AND action='quick_research' AND status='completed' ORDER BY created_at,id",
                    (project_id,),
                ).fetchall()
                new_ids: list[str] = []
                for run, outputs in zip(runs, fresh):
                    if run["id"] not in previous_runs:
                        try:
                            new_ids.extend(json.loads(outputs["output_node_ids_json"] or "[]"))
                        except (TypeError, ValueError):
                            pass
                rows = db.execute("SELECT id,type,x,y,width,height,metadata_json FROM canvas_nodes WHERE project_id=?", (project_id,)).fetchall()
                new_set = set(new_ids)
                now = utc_now()
                for key, _, x, types in groups:
                    previous = [row for row in rows if row["id"] not in new_set and row["type"] in types]
                    additions = [row for row in rows if row["id"] in new_set and row["type"] in types]
                    start_y = max((float(row["y"]) + float(row["height"]) + 40 for row in previous), default=130)
                    for index, row in enumerate(additions):
                        db.execute("UPDATE canvas_nodes SET x=?,y=?,updated_at=? WHERE id=?", (x + 34 + (index % 2) * 340, start_y + (index // 2) * 230, now, row["id"]))
                    required_height = max(570, start_y + ((len(additions) + 1) // 2) * 230 + 50 - 40) if additions else 570
                    for row in rows:
                        if row["type"] == "frame" and read_metadata(row["metadata_json"]).get("group_key") == key and float(row["height"]) < required_height:
                            db.execute("UPDATE canvas_nodes SET height=?,updated_at=? WHERE id=?", (required_height, now, row["id"]))
                db.execute("UPDATE app_settings SET value_json=?,updated_at=? WHERE key=?", (version, now, marker))
                return
            rows = db.execute(
                "SELECT * FROM canvas_nodes WHERE project_id=? ORDER BY created_at,id", (project_id,),
            ).fetchall()
            linked = {
                item[0] for item in db.execute(
                    """SELECT source_node_id FROM canvas_edges WHERE project_id=?
                    UNION SELECT target_node_id FROM canvas_edges WHERE project_id=?""",
                    (project_id, project_id),
                ).fetchall()
            }
            remaining = []
            frames: dict[str, str] = {}
            for row in rows:
                metadata = read_metadata(row["metadata_json"])
                if metadata.get("starter_template") and row["id"] not in linked and not row["locked"] and row["status"] == "exploring" and (
                    row["title"], row["body"]
                ) == seed_titles.get(row["type"]):
                    db.execute("DELETE FROM canvas_nodes WHERE id=?", (row["id"],))
                elif row["type"] == "frame" and (metadata.get("starter_frame") or metadata.get("auto_group")):
                    key = metadata.get("group_key")
                    if key in {"input", "research", "thinking"} and key not in frames:
                        frames[key] = row["id"]
                    else:
                        db.execute("DELETE FROM canvas_nodes WHERE id=?", (row["id"],))
                elif row["type"] != "frame":
                    remaining.append(row)
            columns: dict[str, list[sqlite3.Row]] = {key: [] for key, *_ in groups}
            extras: list[sqlite3.Row] = []
            for row in remaining:
                key = next((key for key, _, _, types in groups if row["type"] in types), None)
                (columns[key] if key else extras).append(row)
            height = max(570, 110 + max((len(items) + 1) // 2 for items in columns.values()) * 230)
            now = utc_now()
            for key, title, x, _ in groups:
                metadata = json.dumps({"starter_frame": True, "group_key": key, "layout_version": 2}, ensure_ascii=False)
                if key in frames:
                    db.execute(
                        """UPDATE canvas_nodes SET title=?,x=?,y=40,width=730,height=?,metadata_json=?,updated_at=? WHERE id=?""",
                        (title, x, height, metadata, now, frames[key]),
                    )
                else:
                    canvas_id = db.execute("SELECT id FROM canvases WHERE project_id=?", (project_id,)).fetchone()[0]
                    db.execute(
                        """INSERT INTO canvas_nodes(id,project_id,canvas_id,type,title,body,status,locked,x,y,width,height,
                        metadata_json,created_by,parent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (f"nod_{uuid.uuid4().hex}", project_id, canvas_id, "frame", title, "", "exploring", 0,
                         x, 40, 730, height, metadata, "system", None, now, now),
                    )
                for index, row in enumerate(columns[key]):
                    db.execute(
                        "UPDATE canvas_nodes SET x=?,y=?,width=310,height=190,updated_at=? WHERE id=?",
                        (x + 34 + (index % 2) * 340, 130 + (index // 2) * 230, now, row["id"]),
                    )
            # Authored output nodes are retained below the research columns, without a fourth starter column.
            for index, row in enumerate(extras):
                db.execute(
                    "UPDATE canvas_nodes SET x=?,y=?,updated_at=? WHERE id=?",
                    (820 + (index % 2) * 340, height + 120 + (index // 2) * 260, now, row["id"]),
                )
            db.execute(
                """INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at""",
                (marker, version, now),
            )

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
            db.execute("UPDATE canvases SET updated_at=? WHERE project_id=?", (now, project_id))
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
        if any(key in clean and clean[key] != current[key] for key in ("title", "body")):
            clean["summary"] = None
            clean["summary_model"] = None
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

    def save_node_summary(self, project_id: str, node_id: str, title: str, body: str,
                          summary: str, model_name: str) -> dict[str, Any] | None:
        """Never attach a model summary to a node edited while the model was running."""
        with self._connect() as db:
            db.execute(
                """UPDATE canvas_nodes SET summary=?,summary_model=?
                   WHERE id=? AND project_id=? AND title=? AND body=?""",
                (summary, model_name, node_id, project_id, title, body),
            )
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
        base_updated_at: str | None = None,
    ) -> dict[str, Any]:
        current_canvas = self.get_canvas(project_id)
        existing = {node["id"]: node for node in current_canvas["nodes"]}
        concurrent_nodes = {node_id for node_id, node in existing.items()
                            if base_updated_at and node["created_at"] > base_updated_at and node_id not in {item.get("id") for item in nodes}}
        incoming_ids: set[str] = set()
        for node in nodes:
            node_id = node.get("id")
            if node_id and node_id in existing:
                incoming_ids.add(node_id)
                values = dict(node)
                values.pop("id", None)
                if "metadata" in values:
                    current_metadata = existing[node_id].get("metadata") or {}
                    incoming_metadata = values.get("metadata") or {}
                    if current_metadata.get("asset_id") and not incoming_metadata.get("asset_id"):
                        values["metadata"] = {**incoming_metadata, "asset_id": current_metadata["asset_id"]}
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
                if node_id not in concurrent_nodes:
                    self.delete_node(project_id, node_id)
        incoming_ids.update(concurrent_nodes)
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
        for edge in current_canvas["edges"]:
            if (edge["source_node_id"] in concurrent_nodes or edge["target_node_id"] in concurrent_nodes) and edge["source_node_id"] in incoming_ids and edge["target_node_id"] in incoming_ids:
                self.create_edge(project_id, edge["source_node_id"], edge["target_node_id"], edge["relation"], edge.get("metadata", {}), edge["id"])
        with self._connect() as db:
            db.execute(
                "UPDATE canvases SET viewport_json=?,updated_at=? WHERE project_id=?",
                (json.dumps(viewport), utc_now(), project_id),
            )
            db.execute("UPDATE projects SET updated_at=? WHERE id=?", (utc_now(), project_id))
        return self.get_canvas(project_id)

    def create_magic_job(self, project_id: str, node_ids: list[str], request: dict[str, Any] | None = None,
                         provider: dict[str, Any] | None = None) -> dict[str, Any]:
        job_id = f"magic_{uuid.uuid4().hex}"
        now = utc_now()
        with self._connect() as db:
            db.execute("""INSERT INTO magic_jobs(job_id,project_id,node_ids_json,status,progress,phase,detail,created_at,updated_at,request_json,provider_json)
                VALUES(?,?,?,'running',2,'准备生成','正在准备节点上下文',?,?,?,?)""",
                (job_id, project_id, json.dumps(node_ids), now, now,
                 json.dumps(request or {}, ensure_ascii=False), json.dumps(provider or {}, ensure_ascii=False)))
        return self.get_magic_job(job_id) or {}

    def update_magic_job(self, job_id: str, expected_attempt: int | None = None, **changes: Any) -> None:
        allowed = {"status", "progress", "phase", "detail", "error", "result"}
        values = {key: value for key, value in changes.items() if key in allowed}
        if "result" in values:
            values["result_json"] = json.dumps(values.pop("result"), ensure_ascii=False)
        if not values:
            return
        with self._connect() as db:
            row = db.execute("SELECT * FROM magic_jobs WHERE job_id=?", (job_id,)).fetchone()
            if not row or row["status"] != "running" or (expected_attempt is not None and row["attempt"] != expected_attempt):
                return
            events = json.loads(row["events_json"] or "[]")
            if any(key in changes for key in ("phase", "detail", "status")):
                events.append({"at": utc_now(), "attempt": row["attempt"], "phase": changes.get("phase", row["phase"]), "detail": changes.get("detail", row["detail"])})
                values["events_json"] = json.dumps(events[-200:], ensure_ascii=False)
            db.execute(f"UPDATE magic_jobs SET {','.join(key + '=?' for key in values)},updated_at=? WHERE job_id=? AND status='running' AND attempt=?",
                       (*values.values(), utc_now(), job_id, row["attempt"]))

    def cancel_magic_job(self, job_id: str) -> bool:
        return self.stop_magic_job(job_id, "cancelled")

    def stop_magic_job(self, job_id: str, status: str) -> bool:
        if status not in {"paused", "cancelled"}:
            raise ValueError("无效的任务状态")
        allowed = ("running",) if status == "paused" else ("running", "paused", "failed")
        phase = "已暂停" if status == "paused" else "已取消"
        detail = "任务已暂停，继续时会重新执行本次模型调用" if status == "paused" else "任务已由用户取消"
        with self._connect() as db:
            row = db.execute("SELECT * FROM magic_jobs WHERE job_id=?", (job_id,)).fetchone()
            if not row or row["status"] not in allowed:
                return False
            events = json.loads(row["events_json"] or "[]")
            events.append({"at": utc_now(), "attempt": row["attempt"], "phase": phase, "detail": detail})
            cursor = db.execute(
                f"UPDATE magic_jobs SET status=?,phase=?,detail=?,events_json=?,updated_at=? WHERE job_id=? AND status IN ({','.join('?' for _ in allowed)})",
                (status, phase, detail, json.dumps(events[-200:], ensure_ascii=False), utc_now(), job_id, *allowed),
            )
        return cursor.rowcount > 0

    def restart_magic_job(self, job_id: str, request: dict[str, Any], provider: dict[str, Any]) -> bool:
        with self._connect() as db:
            cursor = db.execute("""UPDATE magic_jobs SET status='running',progress=2,phase='重新准备生成',
                detail='正在使用当前默认模型重新执行任务',error=NULL,result_json=NULL,attempt=attempt+1,
                request_json=?,provider_json=?,updated_at=? WHERE job_id=? AND status IN ('failed','paused','cancelled')""",
                (json.dumps(request, ensure_ascii=False), json.dumps(provider, ensure_ascii=False), utc_now(), job_id))
        return cursor.rowcount > 0

    def get_magic_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM magic_jobs WHERE job_id=?", (job_id,)).fetchone()
        return self._magic_job(row)

    def list_magic_jobs(self, project_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM magic_jobs WHERE project_id=? ORDER BY updated_at DESC", (project_id,)).fetchall()
        return [self._magic_job(row) for row in rows]

    @staticmethod
    def _magic_job(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        job = dict(row)
        job["node_ids"] = json.loads(job.pop("node_ids_json"))
        job["result"] = json.loads(job.pop("result_json")) if job.get("result_json") else None
        job["request"] = json.loads(job.pop("request_json", "{}") or "{}")
        job["provider"] = json.loads(job.pop("provider_json", "{}") or "{}")
        job["events"] = json.loads(job.pop("events_json", "[]") or "[]")
        return job

    def interrupt_magic_jobs(self) -> None:
        with self._connect() as db:
            db.execute("UPDATE magic_jobs SET status='failed',phase='任务已中断',detail='应用重启后任务已中断，请重新提交',error='应用重启后任务已中断',updated_at=? WHERE status='running'", (utc_now(),))

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

    def delete_research_run(self, project_id: str, run_id: str) -> bool:
        """Forget only the research record; its authored canvas nodes remain intact."""
        with self._connect() as db:
            cursor = db.execute(
                "DELETE FROM ai_runs WHERE id=? AND project_id=? AND action='quick_research' AND status!='running'",
                (run_id, project_id),
            )
            if cursor.rowcount:
                remaining = db.execute(
                    "SELECT id FROM ai_runs WHERE project_id=? AND action='quick_research' AND status='completed' ORDER BY created_at,id",
                    (project_id,),
                ).fetchall()
                db.execute(
                    "INSERT OR REPLACE INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)",
                    (f"research_layout_v2:{project_id}", json.dumps([row["id"] for row in remaining]), utc_now()),
                )
            return cursor.rowcount > 0

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
            linked = db.execute(
                "SELECT id,metadata_json FROM canvas_nodes WHERE project_id=? AND type='output'",
                (project_id,),
            ).fetchall()
        node_by_asset = {str(asset_id): row["id"] for row in linked
                         if (asset_id := read_metadata(row["metadata_json"]).get("asset_id"))}
        return [{**(self._decode(row, "evidence_json") or {}), "node_id": node_by_asset.get(row["id"])} for row in rows]

    def edit_asset(self, project_id: str, asset_id: str, title: str, body: str) -> dict[str, Any] | None:
        with self._connect() as db:
            asset = db.execute("SELECT * FROM content_assets WHERE id=? AND project_id=?", (asset_id, project_id)).fetchone()
            if not asset:
                return None
            nodes = db.execute("SELECT id,locked,metadata_json FROM canvas_nodes WHERE project_id=? AND type='output'", (project_id,)).fetchall()
            linked = [node for node in nodes if read_metadata(node["metadata_json"]).get("asset_id") == asset_id]
            if any(node["locked"] for node in linked):
                raise ValueError("关联的白板节点已锁定，请先解锁再修改资产")
            now = utc_now()
            db.execute("UPDATE content_assets SET title=?,body=?,version=version+1,updated_at=? WHERE id=?", (title, body, now, asset_id))
            for node in linked:
                db.execute("UPDATE canvas_nodes SET title=?,body=?,summary=NULL,summary_model=NULL,updated_at=? WHERE id=?", (title, body, now, node["id"]))
        return next((item for item in self.list_assets(project_id) if item["id"] == asset_id), None)

    def delete_asset(self, project_id: str, asset_id: str) -> bool:
        with self._connect() as db:
            asset = db.execute("SELECT 1 FROM content_assets WHERE id=? AND project_id=?", (asset_id, project_id)).fetchone()
            if not asset:
                return False
            nodes = db.execute("SELECT id,metadata_json FROM canvas_nodes WHERE project_id=? AND type='output'", (project_id,)).fetchall()
            for node in nodes:
                metadata = read_metadata(node["metadata_json"])
                if metadata.get("asset_id") == asset_id:
                    metadata.pop("asset_id")
                    db.execute("UPDATE canvas_nodes SET metadata_json=? WHERE id=?", (json.dumps(metadata, ensure_ascii=False), node["id"]))
            db.execute("DELETE FROM content_assets WHERE id=? AND project_id=?", (asset_id, project_id))
        return True

    def update_asset(
        self, asset_id: str, title: str, body: str, evidence: list[dict[str, Any]], status: str = "draft"
    ) -> dict[str, Any] | None:
        current = self.get_asset(asset_id)
        if not current:
            return None
        with self._connect() as db:
            db.execute(
                """UPDATE content_assets SET title=?,body=?,evidence_json=?,status=?,version=version+1,
                updated_at=? WHERE id=?""",
                (title, body, json.dumps(evidence, ensure_ascii=False), status, utc_now(), asset_id),
            )
        return self.get_asset(asset_id)

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
            selected = db.execute("SELECT value_json FROM app_settings WHERE key='active_provider_id'").fetchone()
            provider_id = json.loads(selected["value_json"]) if selected else None
            row = db.execute("SELECT * FROM provider_configs WHERE id=? AND enabled=1", (provider_id,)).fetchone() if provider_id else None
            if row is None:
                row = db.execute("SELECT * FROM provider_configs WHERE enabled=1 ORDER BY updated_at DESC LIMIT 1").fetchone()
        return self._decode(row, "extra_json")

    def list_providers(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM provider_configs ORDER BY updated_at DESC").fetchall()
        return [self._decode(row, "extra_json") or {} for row in rows]

    def delete_provider(self, provider_id: str) -> bool:
        with self._connect() as db:
            removed = db.execute("DELETE FROM provider_configs WHERE id=?", (provider_id,)).rowcount
            if removed:
                selected = db.execute("SELECT value_json FROM app_settings WHERE key='active_provider_id'").fetchone()
                if selected and json.loads(selected["value_json"]) == provider_id:
                    db.execute("DELETE FROM app_settings WHERE key='active_provider_id'")
        return bool(removed)

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
