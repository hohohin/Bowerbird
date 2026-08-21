/** 功能开关：未完成的功能在此关闭 UI，完成后改回 true 恢复。 */
// 「用途」（preset）：功能尚未开发完成，隐藏创作板「用途」栏与生成会话面板「登记为用途」入口。
export const PRESET_FEATURE_ENABLED = false;
// 「智能精修」（LocalAgentPanel）：功能尚未开发完成，隐藏详情页「再创作」tab 下的卡片。
export const SMART_REFINE_ENABLED = false;
// codex 引导弹窗入口：设置「模型设置」的「查看引导」按钮暂隐，改为卡内「登录授权」一键流程；恢复入口改回 true。
export const CODEX_ONBOARDING_ENABLED = false;
// dreamina 引导弹窗入口：同 codex，设置「模型设置」的「查看引导」按钮暂隐；恢复入口改回 true。
export const DREAMINA_ONBOARDING_ENABLED = false;
// Agent Z（创作板 × Claude Code TUI 互通，dev 测试）：仅 debug 构建且本机能找到 claude CLI 时生效。
export const AGENT_Z_ENABLED = true;
// Agent DS（创作板 × DeepSeek 对话 harness，dev 测试）：对话发生在创作板内（回复追加进编辑器），
// 生图/反推经 .agent-z/rpc 文件契约回桌面端执行；依赖 agent-worker + apps/cloud/.env（与 Agent A/B 同源）。
export const AGENT_DS_ENABLED = true;
