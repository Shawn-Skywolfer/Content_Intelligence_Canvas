from __future__ import annotations

from typing import Any

from app.repositories.workspace import WorkspaceRepository


DEFAULT_CONTENT_FORMATS: list[dict[str, str]] = [
    {"id": "wechat", "name": "微信公众号", "positive_prompt": "结构完整，包含标题、导语、小标题、正文和结语；事实性表述标注证据。", "negative_prompt": "不要编造事实、引用或案例。"},
    {"id": "video_script", "name": "视频号 / 短视频脚本", "positive_prompt": "包含开场钩子、逐镜画面、口播与字幕、节奏和结尾行动引导。", "negative_prompt": "不要把不确定的判断写成事实。"},
    {"id": "poster_campaign", "name": "海报 / 营销活动", "positive_prompt": "包含主标题、副标题、核心信息、行动引导和视觉方向。", "negative_prompt": "不要夸大证据或使用未经证实的数字。"},
]


DEFAULT_CONTENT_FORMATS_EN = [{'id': 'wechat', 'name': 'WeChat article', 'positive_prompt': 'Include a title, introduction, section headings, body, and conclusion. Cite evidence for factual claims.', 'negative_prompt': 'Do not invent facts, quotations, or examples.'}, {'id': 'video_script', 'name': 'Short-form video script', 'positive_prompt': 'Include an opening hook, shot-by-shot visuals, voiceover, captions, pacing, and a closing call to action.', 'negative_prompt': 'Do not present uncertain judgments as established facts.'}, {'id': 'poster_campaign', 'name': 'Poster / campaign', 'positive_prompt': 'Include a headline, subheading, key message, call to action, and visual direction.', 'negative_prompt': 'Do not overstate the evidence or use unverified figures.'}]

def list_content_formats(repository: WorkspaceRepository, language: str = "zh-CN") -> list[dict[str, Any]]:
    saved = repository.get_setting("content_formats")
    if isinstance(saved, list):
        return saved
    if language.lower().startswith("en"):
        return [dict(item) for item in DEFAULT_CONTENT_FORMATS_EN]
    return DEFAULT_CONTENT_FORMATS


def get_content_format(repository: WorkspaceRepository, format_id: str) -> dict[str, Any]:
    match = next((item for item in list_content_formats(repository) if item["id"] == format_id), None)
    if not match:
        raise ValueError("输出形态不存在，请到设置中检查或重新选择")
    return match
