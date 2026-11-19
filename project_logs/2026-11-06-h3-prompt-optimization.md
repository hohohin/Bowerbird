# H3 独立提示词优化 · 2026-11-06

## 最终范围

用户明确：优化会计费，须由独立按钮选择，不强制 Cloud → 本机串联。最终代码只有「优化提示词」付费按钮，普通生成不优化；对照建议后可选用、编辑，再手动生成。只优化卡片文本，保留原语言与原意，并按三模式提供约束。不新增 Runner、服务端协议、定价、迁移或自动生成步骤。

## 复用与实现

- `ComfyVideoCard`／`CanvasWorkflowLayer`：独立按钮、`ProviderQuota`、原文／结果折叠对照、手动选用。
- `CanvasWorkflowController`：原运行持久化、锁、账号、停止与恢复；优化步骤不改现有视频输出、不触发下游。
- `api.cloudAgentStart/Get/Cancel`：既有 Cloud DSH 纯文本改写，原测试账号权限和 Agent 计费。
- `src/skills/h3-video-prompt/SKILL.md`：保留语言、可见描述、动作及运镜先后、模式区别；作为静态资源打包，不要求在用户电脑另装个人 Skill。

## 验证

- 红：新测试在未实现时按预期失败，普通 H3 没有 Cloud 优化。
- 绿：最终 `h3-prompt-optimization-ui.test.mjs` 验证显式点击才优化、普通生成零 Cloud 调用、优化零视频调用、原文与输出保留、下游不执行、选用／编辑后手动生成、三模式约束、账号门控、停止、网络查询恢复、账号切换、无效输出和未知提交不重发。
- 原有 `comfy-video-modes-ui.test.mjs`、`comfy-video-discard-ui.test.mjs` 通过。旧隔离脚本的无配置 Vite 扫描存在 Plate 路径别名警告，正式组件加载及测试断言通过；新脚本限定入口并设置当前 `@` 别名。
- 完整 TypeScript `tsc --noEmit` 通过；Vite 正式前端隔离构建通过（34.41 秒），保留已有大分块提示。产物仅落在 `.tmp/h3-optimization/build`。
- 新测试深浅色截图：`apps/desktop/.tmp/h3-optimization/{dark,light}.png`。所有调用均为合成数据、模拟 Cloud／H3。
- Skill 官方校验脚本因本机 Python 缺少 PyYAML 未运行完成；已人工检查简单 YAML 元数据、命名、完整性，并由运行测试验证实际传入 Cloud 的 Skill 与参数不超过 4000 字符。

## 交付边界

只修改源码与文档；未发布安装包、未部署 Cloud、未调用真实付费 Agent、未启动 GPU 或操作用户真实素材。真实 DSH 优化内容质量与计费联调待实测。服务端须已支持 `textRewrite`；本轮不扩大 Cloud DSH 的测试账号开放范围。
