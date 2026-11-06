# 中英双语 Windows 版 / Bilingual Windows edition

版本：v0.3.30。此版本沿用 Windows 单体 EXE 发布流程，与 Linux 平台部署包独立。

- 左侧顶部提供 简体中文 / English。首次使用参考浏览器语言，手动选择后保存在本机浏览器。
- 切换时不刷新页面，不卸载白板，不清空未提交的输入。已保存项目及原始 Wiki、用户 Prompt 和供应商返回的正文不会自动翻译。
- 英文新项目使用英文系统初始节点；既有项目不重写。默认内容格式可返回英文说明；自定义格式与 Prompt 保留原文。
- 输出语言优先遵从创作要求及简报，否则跟随用户输入。选择英文界面不会强制翻译中文资料。模型实际生成质量取决于所配模型。
- 应用控制的页面、表单、操作提示、常见任务阶段及诊断使用人工编写的英文词典。第三方原始错误、模型输出和原始日志导出保留源语言，便于排错；这些内容不承诺自动翻译。
- Windows 启动窗口和主要启动失败提示包含英文。语言选择属于浏览器配置，不修改模型、MCP、代理或知识库设置。

Use the language selector at the top of the sidebar. English is selected automatically for an English-language browser on first launch. Your choice is remembered in that browser. Changing language keeps your current project and unsent inputs intact.

Your own text, Wiki files, saved prompts, provider responses, and original diagnostic logs are preserved. For English output, write your instructions in English or explicitly request English in the content brief. Existing Chinese projects are not translated automatically.

Translation source: `apps/web/src/locales/en.json`. Use `t(source, ...values)` for application UI and `uiMessage` only for application status/diagnostic fields. Do not pass user-authored content into these functions. Keep node types, API fields, format IDs, storage keys, and model IDs language-independent.

Validation includes Chinese regressions, bilingual switching with draft preservation, English initial templates, customized prompt preservation, real Chromium page and canvas checks, and the Windows EXE startup/restart/cache-repair suite. Browser checks use mock API fixtures and do not establish live provider connectivity.
