"""Run with PYTHONPATH=apps/api python apps/api/tests/test_legacy_canvas_sqlite.py.

Uses only SQLite so old canvas recovery remains testable on hosts without LanceDB.
"""

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.repositories.workspace import WorkspaceRepository


class LegacyCanvasTests(unittest.TestCase):
    def test_corrupt_legacy_metadata_does_not_block_open_or_erase_nodes(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "app.db"
            repository = WorkspaceRepository(db_path)
            project = repository.create_project("旧项目", "知识库研究")
            project_id = project["id"]
            original = repository.get_canvas(project_id)
            idea = next(node for node in original["nodes"] if node["type"] == "idea")
            finding = repository.create_node(project_id, {"type": "fact", "title": "用户事实", "body": "正文保留"})
            repository.create_edge(project_id, idea["id"], finding["id"])
            run = repository.create_run(project_id, "quick_research", "知识库研究", [])
            repository.finish_run(run, [finding["id"]], None, None)
            with sqlite3.connect(db_path) as db:
                db.execute("UPDATE canvas_nodes SET metadata_json='invalid legacy value' WHERE id=?", (idea["id"],))
                db.execute("DELETE FROM app_settings WHERE key=?", (f"starter_edges_checked:{project_id}",))

            loaded = repository.get_canvas(project_id)
            self.assertEqual(next(node["body"] for node in loaded["nodes"] if node["id"] == finding["id"]), "正文保留")
            self.assertIn(finding["id"], {node["id"] for node in repository.get_canvas(project_id)["nodes"]})
            self.assertEqual(len(loaded["edges"]), 1)
            repository.update_node(project_id, finding["id"], {"width": 480, "height": 350, "x": 932})
            second = repository.create_node(project_id, {"type": "fact", "title": "第二次研究", "body": "证据二"})
            second_run = repository.create_run(project_id, "quick_research", "再研究", [])
            repository.finish_run(second_run, [second["id"]], None, None)
            refreshed = repository.get_canvas(project_id)
            old_card = next(node for node in refreshed["nodes"] if node["id"] == finding["id"])
            self.assertEqual((old_card["x"], old_card["width"], old_card["height"]), (932, 480, 350))
            new_card = next(node for node in refreshed["nodes"] if node["id"] == second["id"])
            self.assertGreater(new_card["y"], old_card["y"])
            self.assertTrue(repository.delete_research_run(project_id, run))
            self.assertFalse(repository.delete_research_run(project_id, run))
            self.assertIn(finding["id"], {node["id"] for node in repository.get_canvas(project_id)["nodes"]})


if __name__ == "__main__":
    unittest.main()
