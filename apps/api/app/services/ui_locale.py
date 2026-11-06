"""只本地化新建项目的内置种子，不翻译用户资料。"""
BUILTIN_EN = {'原始想法': 'Original idea', '内容简报': 'Content brief', '可在此补充目标受众、传播目标、语气和限制条件。': 'Add your target audience, communication goals, tone, and constraints here.', '01 输入与简报': '01 Input & brief', '02 研究与证据': '02 Research & evidence', '03 洞察与策略': '03 Insights & strategy', '04 内容生产': '04 Content creation', '知识材料': 'Source material', '事实证据': 'Facts & evidence', '变化信号': 'Emerging signals', '内部知识': 'Internal knowledge', '核心洞察': 'Key insight', '反向质疑': 'Challenge assumptions', '创意模式': 'Creative pattern', '内容概念': 'Content concept', '自由草稿': 'Working draft', '内容输出': 'Final content', '从知识检索加入的原始材料与段落。': 'Original sources and passages from your knowledge base.', '可验证的事实、数字与案例。': 'Verifiable facts, figures, and examples.', '值得关注的市场、客户或技术变化。': 'Market, customer, or technology changes worth tracking.', '来自内部 Wiki 的观点与方法。': 'Ideas and approaches from your internal Wiki.', '把事实和信号转化为有价值的判断。': 'Turn facts and signals into meaningful insights.', '检查假设、证据缺口和潜在风险。': 'Examine assumptions, evidence gaps, and potential risks.', '沉淀可复用的叙事与表达方式。': 'Capture reusable storytelling and creative approaches.', '收敛受众、主张、结构、语气和证据。': 'Define the audience, message, structure, tone, and evidence.', '输入 Prompt 后，可直接在当前节点生成或改写。': 'Add instructions in Create with AI to generate a connected draft node.', '公众号、视频脚本和营销内容在这里继续编辑。': 'Refine articles, video scripts, and marketing content here.'}


def localize_new_project(repository, project_id: str, has_brief: bool) -> None:
    with repository._connect() as db:
        rows = db.execute("SELECT id,type,title,body,metadata_json FROM canvas_nodes WHERE project_id=?", (project_id,)).fetchall()
        for row in rows:
            title = BUILTIN_EN.get(row["title"], row["title"])
            # 想法和用户提供的简报必须逐字保留。
            body = row["body"] if row["type"] == "idea" or row["type"] == "brief" and has_brief else BUILTIN_EN.get(row["body"], row["body"])
            db.execute("UPDATE canvas_nodes SET title=?,body=? WHERE id=?", (title, body, row["id"]))
