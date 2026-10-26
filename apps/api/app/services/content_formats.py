from __future__ import annotations

from typing import Any

from app.repositories.workspace import WorkspaceRepository


DEFAULT_CONTENT_FORMATS: list[dict[str, str]] = [
    {"id": "wechat", "name": "微信公众号", "positive_prompt": "结构完整，包含标题、导语、小标题、正文和结语；事实性表述标注证据。", "negative_prompt": "不要编造事实、引用或案例。"},
    {"id": "video_script", "name": "视频号 / 短视频脚本", "positive_prompt": "包含开场钩子、逐镜画面、口播与字幕、节奏和结尾行动引导。", "negative_prompt": "不要把不确定的判断写成事实。"},
    {"id": "poster_campaign", "name": "海报 / 营销活动", "positive_prompt": "包含主标题、副标题、核心信息、行动引导和视觉方向。", "negative_prompt": "不要夸大证据或使用未经证实的数字。"},
]


def list_content_formats(repository: WorkspaceRepository) -> list[dict[str, Any]]:
    saved = repository.get_setting("content_formats")
    return saved if isinstance(saved, list) else DEFAULT_CONTENT_FORMATS


def get_content_format(repository: WorkspaceRepository, format_id: str) -> dict[str, Any]:
    match = next((item for item in list_content_formats(repository) if item["id"] == format_id), None)
    if not match:
        raise ValueError("输出形态不存在，请到设置中检查或重新选择")
    return match
