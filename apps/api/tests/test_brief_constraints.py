import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.services.brief_constraints import enforce_brief, hard_rules


def test_no_brief_does_not_add_model_calls():
    ai = SimpleNamespace(complete_json=Mock())
    body, check = enforce_brief(ai, "正文", "", "润色", {})
    assert body == "正文" and check["status"] == "not_configured"
    ai.complete_json.assert_not_called()


def test_reviewer_cannot_waive_program_count_and_repair_receives_originals():
    full = "完整词条" * 2000 + "末尾的必要适用条件"
    ai = SimpleNamespace(complete_json=Mock(return_value=({"compliant": True, "violations": []}, {})),
                         complete=Mock(return_value=("【简报】合规正文", {})))
    events = []
    body, check = enforce_brief(ai, "【简报】" + "过长文字" * 40, "必须以【简报】开头，不超过30字", "润色", {"wiki_evidence": [{"text": full}]}, events.append)
    assert body == "【简报】合规正文" and check["repaired"]
    assert ai.complete_json.call_count == 2
    repair = json.loads(ai.complete.call_args.args[1])
    assert repair["wiki_evidence"][0]["text"] == full
    assert "字数超限" in repair["violations"][0]
    assert any("自动修订" in event for event in events)


def test_semantic_violation_is_repaired_and_persistent_failure_is_rejected():
    ai = SimpleNamespace(complete_json=Mock(side_effect=[({"compliant": False, "violations": ["没有面向技术决策者"]}, {}), ({"compliant": False, "violations": ["仍然夸大可靠性"]}, {})]),
                         complete=Mock(return_value=("修改稿", {})))
    with pytest.raises(ValueError, match="草稿未通过内容简报核对.*仍然夸大可靠性"):
        enforce_brief(ai, "初稿", "面向技术决策者，不夸大可靠性", "润色", {})


def test_explicit_instruction_overrides_specific_brief_rule():
    assert hard_rules("不超过100字，以【简报】开头", "本次不超过200字") == {"max_characters": 200, "prefix": "【简报】"}
    assert hard_rules("不超过100字，以【简报】开头", "取消字数限制") == {"max_characters": None, "prefix": "【简报】"}
    assert hard_rules("不超过100字", "字数改为150字") == {"max_characters": 150, "prefix": None}
    assert hard_rules("不超过100字", "详细润色") == {"max_characters": 100, "prefix": None}


def test_failed_brief_review_does_not_create_output_node_or_asset(tmp_path):
    from app.repositories.workspace import WorkspaceRepository
    from app.services.workflow import ContentWorkflowService
    repo = WorkspaceRepository(tmp_path / "app.db")
    project = repo.create_project("项目", "主题", "不超过10字")
    node = repo.create_node(project["id"], {"title": "输入", "body": "有据可查的材料"})
    ai = SimpleNamespace(complete=Mock(return_value=("超长的初稿或修订稿" * 10, {})),
                         complete_json=Mock(return_value=({"compliant": True, "violations": []}, {})))
    workflow = ContentWorkflowService(repo, SimpleNamespace(manifest=SimpleNamespace(list_sources=lambda: [])), None, ai, None)
    original = repo.get_canvas(project["id"])
    with pytest.raises(ValueError, match="字数超限"):
        workflow.generate_content(project["id"], [node["id"]], "wechat", "草稿", 90, True)
    assert len(repo.get_canvas(project["id"])["nodes"]) == len(original["nodes"])
    assert not repo.list_assets(project["id"])
    assert repo.list_runs(project["id"])[0]["status"] == "failed"
