from __future__ import annotations

import json
import textwrap
from typing import Any

from app.repositories.lance_chunk_store import LanceChunkStore
from app.repositories.workspace import WorkspaceRepository
from app.services.ai.gateway import AIProviderGateway
from app.services.retrieval.hybrid import HybridRetrievalService


FINDING_TYPES = {"fact", "signal", "internal_knowledge", "insight"}


class ContentWorkflowService:
    def __init__(
        self,
        repository: WorkspaceRepository,
        retrieval: HybridRetrievalService,
        chunks: LanceChunkStore,
        ai: AIProviderGateway,
    ) -> None:
        self.repository = repository
        self.retrieval = retrieval
        self.chunks = chunks
        self.ai = ai

    def quick_research(
        self,
        project_id: str,
        source_id: str,
        query: str,
        finding_count: int,
        use_llm: bool,
    ) -> tuple[list[dict[str, Any]], str, bool, str]:
        hits = self.retrieval.search(source_id, query, top_k=max(10, finding_count * 2))
        if not hits:
            raise ValueError("知识库中没有找到相关内容，请先刷新索引或调整问题")
        run_id = self.repository.create_run(project_id, "quick_research", query, [])
        payload = self._fallback_research(query, hits, finding_count)
        trace: dict[str, str] = {}
        used_llm = False
        message = "已使用本地规则生成 Findings；配置并允许大模型后可获得更强的综合归纳。"
        if use_llm and self.repository.active_provider():
            try:
                evidence_payload = [
                    {
                        "chunk_id": hit.chunk_id,
                        "title": hit.title,
                        "heading": list(hit.heading_path),
                        "excerpt": hit.excerpt,
                        "path": hit.source_path,
                        "references": list(hit.original_references),
                    }
                    for hit in hits[:12]
                ]
                result, trace = self.ai.complete_json(
                    "你是企业内容研究助手。只能使用用户提供的内部知识证据，不补充外部事实。"
                    "输出严格 JSON 对象，字段为 findings 和 directions。findings 每项包含 type、title、body、"
                    "evidence_chunk_ids；type 只能为 fact、signal、internal_knowledge、insight。"
                    "directions 恰好三项，每项包含 title、body、source_finding_indexes。",
                    json.dumps(
                        {
                            "research_question": query,
                            "finding_count": finding_count,
                            "evidence": evidence_payload,
                        },
                        ensure_ascii=False,
                    ),
                )
                if isinstance(result, dict) and isinstance(result.get("findings"), list):
                    payload = self._validate_research_payload(result, hits, finding_count)
                    used_llm = True
                    message = "已仅基于内部 Wiki 生成 Findings 和三条创意方向。"
            except Exception as exc:
                message = f"大模型未使用，已安全降级为本地生成：{exc}"

        nodes: list[dict[str, Any]] = []
        finding_nodes: list[dict[str, Any]] = []
        for index, finding in enumerate(payload["findings"]):
            evidence = self._evidence_for_ids(finding["evidence_chunk_ids"], hits)
            node = self.repository.create_node(
                project_id,
                {
                    "type": finding["type"],
                    "title": finding["title"],
                    "body": finding["body"],
                    "status": "candidate",
                    "x": 520 + (index % 2) * 420,
                    "y": 80 + (index // 2) * 290,
                    "created_by": "ai" if used_llm else "system",
                    "metadata": {
                        "research_query": query,
                        "evidence": evidence,
                        "finding_kind": finding["type"],
                    },
                },
            )
            nodes.append(node)
            finding_nodes.append(node)

        direction_x = 1420
        for index, direction in enumerate(payload["directions"][:3]):
            source_indexes = direction.get("source_finding_indexes") or [index % len(finding_nodes)]
            parent = finding_nodes[min(max(int(source_indexes[0]), 0), len(finding_nodes) - 1)]
            evidence = self._merge_evidence(
                [finding_nodes[i].get("metadata", {}).get("evidence", []) for i in source_indexes if 0 <= i < len(finding_nodes)]
            )
            node = self.repository.create_node(
                project_id,
                {
                    "type": "insight",
                    "title": direction["title"],
                    "body": direction["body"],
                    "status": "exploring",
                    "x": direction_x,
                    "y": 120 + index * 310,
                    "created_by": "ai" if used_llm else "system",
                    "parent_id": parent["id"],
                    "metadata": {"route": True, "evidence": evidence},
                },
            )
            for source_index in source_indexes[1:]:
                if 0 <= source_index < len(finding_nodes):
                    self.repository.create_edge(
                        project_id, finding_nodes[source_index]["id"], node["id"], "inspires"
                    )
            nodes.append(node)
        self.repository.finish_run(
            run_id,
            [node["id"] for node in nodes],
            trace.get("provider"),
            trace.get("model"),
        )
        return nodes, run_id, used_llm, message

    def magic(
        self,
        project_id: str,
        node_ids: list[str],
        instruction: str,
        output_type: str,
    ) -> tuple[dict[str, Any], str, bool, str]:
        nodes = self._nodes(project_id, node_ids)
        run_id = self.repository.create_run(project_id, "magic_bar", instruction, node_ids)
        used_llm = False
        trace: dict[str, str] = {}
        title = f"AI 加工：{instruction[:24]}"
        body = self._fallback_magic(instruction, nodes)
        message = "已生成新节点，原节点未被覆盖。"
        if self.repository.active_provider():
            try:
                body, trace = self.ai.complete(
                    "你是 Content Canvas 共创助手。根据选中节点执行指令，输出一段可直接放入新节点的中文内容。"
                    "不得声称输入里没有的事实；保留不确定性；不要覆盖原节点。",
                    json.dumps(
                        {"instruction": instruction, "nodes": self._compact_nodes(nodes)}, ensure_ascii=False
                    ),
                )
                used_llm = True
            except Exception as exc:
                message = f"大模型未使用，已本地降级并创建新节点：{exc}"
        evidence = self._merge_evidence([node.get("metadata", {}).get("evidence", []) for node in nodes])
        created = self.repository.create_node(
            project_id,
            {
                "type": output_type,
                "title": title,
                "body": body,
                "status": "exploring",
                "x": max(float(node.get("x", 0)) for node in nodes) + 440,
                "y": min(float(node.get("y", 0)) for node in nodes),
                "created_by": "ai" if used_llm else "system",
                "parent_id": nodes[0]["id"],
                "metadata": {"instruction": instruction, "evidence": evidence},
            },
        )
        for node in nodes[1:]:
            self.repository.create_edge(project_id, node["id"], created["id"], "transforms")
        self.repository.finish_run(
            run_id, [created["id"]], trace.get("provider"), trace.get("model")
        )
        return created, run_id, used_llm, message

    def create_concept(
        self,
        project_id: str,
        node_ids: list[str],
        title: str,
        use_llm: bool,
    ) -> tuple[dict[str, Any], str, bool, str]:
        nodes = self._nodes(project_id, node_ids)
        run_id = self.repository.create_run(project_id, "content_concept", title, node_ids)
        project = self.repository.get_project(project_id) or {}
        concept_title = title or f"内容概念：{project.get('name', '未命名项目')}"
        body = self._fallback_concept(project, nodes)
        trace: dict[str, str] = {}
        used_llm = False
        message = "已生成待批准的 Content Concept。"
        if use_llm and self.repository.active_provider():
            try:
                body, trace = self.ai.complete(
                    "你是内容策略负责人。将输入整理为中文 Content Concept，必须包含：Working Title、Core Insight、"
                    "Audience、Why Now、Narrative、Key Claims、Key Evidence、Brand Role、Tone、"
                    "Creative Pattern、Visual Direction。不要创造输入之外的事实。",
                    json.dumps(
                        {"project": project, "selected_nodes": self._compact_nodes(nodes)}, ensure_ascii=False
                    ),
                )
                used_llm = True
            except Exception as exc:
                message = f"大模型未使用，已用本地模板生成 Concept：{exc}"
        evidence = self._merge_evidence([node.get("metadata", {}).get("evidence", []) for node in nodes])
        concept = self.repository.create_node(
            project_id,
            {
                "type": "content_concept",
                "title": concept_title,
                "body": body,
                "status": "candidate",
                "x": max(float(node.get("x", 0)) for node in nodes) + 460,
                "y": min(float(node.get("y", 0)) for node in nodes),
                "created_by": "ai" if used_llm else "system",
                "parent_id": nodes[0]["id"],
                "metadata": {"evidence": evidence, "requires_approval": True},
            },
        )
        for node in nodes[1:]:
            self.repository.create_edge(project_id, node["id"], concept["id"], "supports")
        self.repository.finish_run(
            run_id, [concept["id"]], trace.get("provider"), trace.get("model")
        )
        return concept, run_id, used_llm, message

    def generate_content(
        self,
        project_id: str,
        node_ids: list[str],
        format_name: str,
        title: str,
        duration_seconds: int,
        use_llm: bool,
    ) -> tuple[dict[str, Any], dict[str, Any], str, bool, str]:
        nodes = self._nodes(project_id, node_ids)
        run_id = self.repository.create_run(project_id, f"generate_{format_name}", title, node_ids)
        project = self.repository.get_project(project_id) or {}
        output_title = title or self._default_output_title(format_name, project.get("name", "内容项目"))
        body = self._fallback_output(format_name, output_title, nodes, duration_seconds)
        used_llm = False
        trace: dict[str, str] = {}
        message = "已生成内容资产草稿。"
        if use_llm and self.repository.active_provider():
            try:
                system = self._output_system_prompt(format_name, duration_seconds)
                body, trace = self.ai.complete(
                    system,
                    json.dumps(
                        {
                            "title": output_title,
                            "project": project,
                            "content_concept_and_evidence": self._compact_nodes(nodes),
                        },
                        ensure_ascii=False,
                    ),
                )
                used_llm = True
            except Exception as exc:
                message = f"大模型未使用，已用本地模板生成草稿：{exc}"
        evidence = self._merge_evidence([node.get("metadata", {}).get("evidence", []) for node in nodes])
        asset = self.repository.create_asset(
            project_id, format_name, output_title, body, evidence
        )
        output_node = self.repository.create_node(
            project_id,
            {
                "type": "output",
                "title": output_title,
                "body": body,
                "status": "candidate",
                "x": max(float(node.get("x", 0)) for node in nodes) + 470,
                "y": min(float(node.get("y", 0)) for node in nodes),
                "created_by": "ai" if used_llm else "system",
                "parent_id": nodes[0]["id"],
                "metadata": {"asset_id": asset["id"], "format": format_name, "evidence": evidence},
            },
        )
        self.repository.finish_run(
            run_id, [output_node["id"]], trace.get("provider"), trace.get("model")
        )
        return asset, output_node, run_id, used_llm, message

    @staticmethod
    def _fallback_research(query: str, hits: list[Any], count: int) -> dict[str, Any]:
        findings: list[dict[str, Any]] = []
        seen: set[str] = set()
        for hit in hits:
            key = f"{hit.title}|{'/'.join(hit.heading_path)}"
            if key in seen:
                continue
            seen.add(key)
            kind = "internal_knowledge" if "product" in hit.source_path.lower() else "fact"
            heading = " › ".join(hit.heading_path)
            findings.append(
                {
                    "type": kind,
                    "title": heading or hit.title,
                    "body": hit.excerpt[:520],
                    "evidence_chunk_ids": [hit.chunk_id],
                }
            )
            if len(findings) >= count:
                break
        direction_templates = [
            ("从核心矛盾切入", f"围绕“{query}”先讲清最关键的业务矛盾，再用内部证据给出判断。"),
            ("从变化信号切入", "把多个事实放到同一时间线中，解释为什么这个议题现在值得关注。"),
            ("从客户价值切入", "把技术与市场信息转换为客户可感知的风险、收益和行动建议。"),
        ]
        directions = [
            {"title": title, "body": body, "source_finding_indexes": [i % len(findings)]}
            for i, (title, body) in enumerate(direction_templates)
        ]
        return {"findings": findings, "directions": directions}

    def _validate_research_payload(
        self, result: dict[str, Any], hits: list[Any], count: int
    ) -> dict[str, Any]:
        valid_ids = {hit.chunk_id for hit in hits}
        findings = []
        for raw in result.get("findings", [])[:count]:
            if not isinstance(raw, dict):
                continue
            ids = [item for item in raw.get("evidence_chunk_ids", []) if item in valid_ids]
            if not ids:
                continue
            kind = raw.get("type", "insight")
            findings.append(
                {
                    "type": kind if kind in FINDING_TYPES else "insight",
                    "title": str(raw.get("title", "研究发现"))[:160],
                    "body": str(raw.get("body", ""))[:3000],
                    "evidence_chunk_ids": ids,
                }
            )
        if len(findings) < 3:
            return self._fallback_research("研究议题", hits, count)
        directions = []
        for raw in result.get("directions", [])[:3]:
            if not isinstance(raw, dict):
                continue
            indexes = [int(i) for i in raw.get("source_finding_indexes", []) if str(i).isdigit()]
            directions.append(
                {
                    "title": str(raw.get("title", "创意方向"))[:160],
                    "body": str(raw.get("body", ""))[:2000],
                    "source_finding_indexes": indexes or [0],
                }
            )
        while len(directions) < 3:
            index = len(directions)
            directions.append(
                {
                    "title": ["核心矛盾", "变化信号", "客户价值"][index],
                    "body": "基于已确认 Findings 继续发展这一叙事方向。",
                    "source_finding_indexes": [index % len(findings)],
                }
            )
        return {"findings": findings, "directions": directions}

    @staticmethod
    def _evidence_for_ids(ids: list[str], hits: list[Any]) -> list[dict[str, Any]]:
        by_id = {hit.chunk_id: hit for hit in hits}
        return [
            {
                "chunk_id": by_id[item].chunk_id,
                "title": by_id[item].title,
                "path": by_id[item].source_path,
                "heading": list(by_id[item].heading_path),
                "excerpt": by_id[item].excerpt,
                "start_line": by_id[item].start_line,
                "end_line": by_id[item].end_line,
                "references": list(by_id[item].original_references),
            }
            for item in ids
            if item in by_id
        ]

    @staticmethod
    def _merge_evidence(groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        seen: set[str] = set()
        for group in groups:
            for item in group:
                key = str(item.get("chunk_id") or item.get("path") or item)
                if key not in seen:
                    seen.add(key)
                    merged.append(item)
        return merged

    def _nodes(self, project_id: str, ids: list[str]) -> list[dict[str, Any]]:
        nodes = [self.repository.get_node(node_id) for node_id in ids]
        valid = [node for node in nodes if node and node["project_id"] == project_id]
        if len(valid) != len(ids):
            raise ValueError("部分节点不存在或不属于当前项目")
        return valid

    @staticmethod
    def _compact_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "id": node["id"],
                "type": node["type"],
                "title": node["title"],
                "body": node["body"],
                "status": node["status"],
                "evidence": node.get("metadata", {}).get("evidence", []),
            }
            for node in nodes
        ]

    @staticmethod
    def _fallback_magic(instruction: str, nodes: list[dict[str, Any]]) -> str:
        bullets = "\n".join(f"- **{node['title']}**：{node['body'][:300]}" for node in nodes)
        return f"## 处理指令\n\n{instruction}\n\n## 选中内容的合并结果\n\n{bullets}\n\n## 下一步判断\n\n请围绕以上信息继续验证证据、收敛观点。"

    @staticmethod
    def _fallback_concept(project: dict[str, Any], nodes: list[dict[str, Any]]) -> str:
        claims = "\n".join(f"- {node['title']}：{node['body'][:220]}" for node in nodes)
        return textwrap.dedent(
            f"""
            ## Working Title
            {project.get('name', '内容项目')}

            ## Core Insight
            {nodes[0]['body'][:500]}

            ## Audience
            需要理解并据此行动的业务决策者与目标客户

            ## Why Now
            当前内部知识已形成一组可相互支撑的事实与判断，适合进一步收敛为传播主张。

            ## Narrative
            从变化与矛盾出发，用可信事实解释影响，最后落到可执行的价值判断。

            ## Key Claims
            {claims}

            ## Key Evidence
            见本节点关联的 Wiki Evidence。

            ## Brand Role
            以专业、可靠、可验证的方式帮助受众理解复杂议题。

            ## Tone
            专业、克制、清晰、有判断。

            ## Creative Pattern
            矛盾 → 证据 → 判断 → 行动

            ## Visual Direction
            结构化信息卡、关键数字和证据锚点，避免装饰性堆叠。
            """
        ).strip()

    @staticmethod
    def _default_output_title(format_name: str, project_name: str) -> str:
        suffix = {
            "wechat": "微信公众号初稿",
            "video_script": "视频号脚本",
            "poster_campaign": "海报 Campaign 文案",
        }[format_name]
        return f"{project_name}｜{suffix}"

    def _fallback_output(
        self, format_name: str, title: str, nodes: list[dict[str, Any]], duration: int
    ) -> str:
        evidence = self._merge_evidence([node.get("metadata", {}).get("evidence", []) for node in nodes])
        citation_lines = "\n".join(
            f"[{index}] {item.get('path', '')}｜{' › '.join(item.get('heading', []))}"
            for index, item in enumerate(evidence, start=1)
        ) or "[1] 暂无可用 Evidence，请返回白板补充。"
        if format_name == "video_script":
            beats = "\n".join(
                f"- **画面 {index + 1}**：{node['title']}\n  - 字幕：{node['body'][:120]}"
                for index, node in enumerate(nodes[:5])
            )
            return f"# {title}\n\n**建议时长：{duration} 秒**\n\n## 开场 Hook\n\n真正值得关注的，不只是变化本身，而是变化正在重写什么。\n\n## 分镜\n\n{beats}\n\n## 收束\n\n用可信证据看清变化，再把判断变成行动。\n\n## Evidence\n\n{citation_lines}"
        if format_name == "poster_campaign":
            core = nodes[0]["body"][:180]
            return f"# {title}\n\n## 主标题\n\n看见变化背后的确定性\n\n## 副标题\n\n{core}\n\n## 三条核心信息\n\n" + "\n".join(
                f"- {node['title']}：{node['body'][:90]}" for node in nodes[:3]
            ) + f"\n\n## CTA\n\n从可信知识出发，形成下一步行动。\n\n## 视觉方向\n\n留白、证据卡片、单一视觉焦点；事实与判断分层。\n\n## Evidence\n\n{citation_lines}"
        sections = "\n\n".join(
            f"## {node['title']}\n\n{node['body']}\n\n> Evidence：[{min(index + 1, max(1, len(evidence)))}]"
            for index, node in enumerate(nodes[:6])
        )
        return f"# {title}\n\n## 导语\n\n当信息越来越多，真正稀缺的是能够被证据支撑的判断。本文从内部知识出发，梳理关键变化与行动含义。\n\n{sections}\n\n## 结语\n\n事实决定观点能站多稳，洞察决定内容能走多远。\n\n## Evidence\n\n{citation_lines}"

    @staticmethod
    def _output_system_prompt(format_name: str, duration: int) -> str:
        if format_name == "video_script":
            return (
                f"你是视频号编导。基于 Content Concept 和 Evidence 写一份约 {duration} 秒中文短视频脚本，"
                "包含 Hook、逐镜画面、字幕/口播、节奏、结尾 CTA。不得把不确定判断写成事实，事实后标注 [n]。"
            )
        if format_name == "poster_campaign":
            return (
                "你是 Campaign 创意总监。输出中文海报/Campaign 文案包，包含主标题、副标题、三条核心信息、"
                "CTA、视觉方向和 Evidence。语言短、强、有传播力，但不能夸大证据。"
            )
        return (
            "你是微信公众号主编。基于 Content Concept 和 Evidence 写一篇结构完整的中文初稿，"
            "包含标题、导语、小标题、正文、结语；事实性表述使用 [n] 对应 Evidence，不得编造。"
        )
