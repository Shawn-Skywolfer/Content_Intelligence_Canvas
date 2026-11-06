from app.repositories.workspace import WorkspaceRepository


def test_english_starters_preserve_user_content_and_existing_projects(tmp_path):
    repo = WorkspaceRepository(tmp_path / "locale.db")
    original = "原始想法"
    project = repo.create_project("English project", original, "内容简报", language="en-US")
    canvas = repo.get_canvas(project["id"])
    idea = next(n for n in canvas["nodes"] if n["type"] == "idea")
    brief = next(n for n in canvas["nodes"] if n["type"] == "brief")
    assert idea["title"] == "Original idea" and idea["body"] == original
    assert brief["title"] == "Content brief" and brief["body"] == "内容简报"
    assert any(n["title"] == "02 Research & evidence" for n in canvas["nodes"])
    chinese = repo.create_project("中文项目", "原文")
    assert any(n["title"] == "原始想法" for n in repo.get_canvas(chinese["id"])["nodes"])
    assert repo.get_canvas(project["id"])["nodes"] == canvas["nodes"]


def test_builtin_formats_support_english_without_rewriting_custom_prompts(tmp_path):
    from app.services.content_formats import list_content_formats
    repo = WorkspaceRepository(tmp_path / "formats.db")
    english = list_content_formats(repo, "en-US")
    assert english[0]["id"] == "wechat" and english[0]["name"] == "WeChat article"
    assert list_content_formats(repo)[0]["name"] == "微信公众号"
    custom = [{"id": "custom", "name": "自定义", "positive_prompt": "保留原文", "negative_prompt": ""}]
    repo.set_setting("content_formats", custom)
    assert list_content_formats(repo, "en") == custom
