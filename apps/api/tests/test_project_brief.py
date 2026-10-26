import pytest

from app.repositories.workspace import WorkspaceRepository


def test_project_brief_syncs_to_primary_node_and_canvas_edits_sync_back(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("研究", "AIDC 供电方案", "原简报")
    brief = next(node for node in repo.get_canvas(project["id"])["nodes"] if node["type"] == "brief")
    extra = repo.create_node(project["id"], {"type": "brief", "title": "其他参考简报", "body": "独立内容"})
    repo.save_node_summary(project["id"], brief["id"], brief["title"], brief["body"], "旧摘要", "test")
    updated = repo.update_project(project["id"], {"brief": "受众：技术决策者\n目标：比较 TCO"})
    assert repo.get_node(brief["id"])["body"] == updated["brief"]
    assert repo.get_node(brief["id"])["summary"] is None
    assert repo.get_node(extra["id"])["body"] == "独立内容"
    canvas = repo.get_canvas(project["id"])
    for node in canvas["nodes"]:
        if node["id"] == brief["id"]:
            node["body"] = "从白板修改的创作要求"
    repo.replace_canvas(project["id"], canvas["nodes"], canvas["edges"], canvas["viewport"], canvas["updated_at"])
    assert repo.get_project(project["id"])["brief"] == "从白板修改的创作要求"


def test_locked_primary_brief_rejects_project_edit_and_deleted_brief_can_be_recreated(tmp_path):
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("研究", "供电方案", "原内容")
    brief = next(node for node in repo.get_canvas(project["id"])["nodes"] if node["type"] == "brief")
    repo.update_node(project["id"], brief["id"], {"locked": True})
    with pytest.raises(ValueError, match="内容简报节点已锁定"):
        repo.update_project(project["id"], {"brief": "不应保存"})
    assert repo.get_project(project["id"])["brief"] == "原内容"
    repo.update_node(project["id"], brief["id"], {"locked": False})
    repo.delete_node(project["id"], brief["id"])
    repo.update_project(project["id"], {"brief": "重新填写的简报"})
    brief_nodes = [node for node in repo.get_canvas(project["id"])["nodes"] if node["type"] == "brief"]
    assert len(brief_nodes) == 1 and brief_nodes[0]["body"] == "重新填写的简报"
