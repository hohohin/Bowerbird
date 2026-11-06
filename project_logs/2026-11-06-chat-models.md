# 对话内 Codex 模型与推理强度

2026-11-06，Asia/Shanghai。产品约定以 `PROJECT.md` 为准。

## 范围与复用

- 本机 Codex 对话的新建入口与详情续聊均可选择模型、推理强度；provider 仍属于会话身份，模型参数按下一条消息生效。
- 复用现有 `ChatProviderSelect`、`TacticalSelect`、创作草稿、本地对话轮次以及受限 app-server 通道。仓库没有可直接复用的 Codex 子模型目录，新增只读 `local_chat_models` 从 CLI 获取能力，不写死模型列表。
- 保留默认行为，显式选择按模型支持能力校验；Cloud 不接收 Codex 参数。选择进入请求身份与本地历史，不改变建卡和视频工具权限。

## 动作与理由

1. 检查当前项目、复用地图、对话及错误规范，跨目录检索模型和 reasoning/effort 的既有实现，确认数据来源与复用范围。
2. 并行完成原生协议／持久化和前端选择器，另做只读协议复核。前端先复现模型选择丢失／请求身份不变的预期失败再实现；Rust 先加用例，但首次执行被沙箱和提前注册的新 IPC 编译错误阻挡，没有取得有效业务红灯，不把该阶段记作通过的 TDD 验证。
3. 复用当前 UI 规范及 ui-ux-pro-max 的键盘／加载反馈建议，避免新增样式体系和重复说明。
4. 本轮在已有未提交工作上增量修改；共享文件仅保留本轮增量，不清理其他任务文件。
5. 使用已安装 CLI 导出的 JSON schema 核实 `model/list` 分页、`thread/start`／`thread/resume.model`、`turn/start.effort`；显式重置必须发送解析后的默认值，不能仅省略参数。
6. 用现有合成 IPC 页面验证真实组件交互。选极高后切到仅支持低强度的模型会回到低；提交记录包含选定型号与 `xhigh`，回复期间菜单禁用；续聊改低并输入草稿，刷新／重开后两者均恢复，Escape 保留面板。未读取用户素材库。
7. 独立代码审查未发现阻塞问题。检查可用工具未发现 crapper、dryer、mutator，因此没有声称执行这些工具；以本轮行为回归、协议核对与差异审查明确覆盖范围。
8. 更新 PROJECT、对话专项及 UI 复用地图；检查既有 worktree，未创建或删除 worktree。仅提交本轮代码和文档，保留其他未提交改动。

## 验证

- 前端行为：31/31（创作草稿 11、对话 store 15、输入行为 5）。完整 TypeScript 通过。
- Rust：`cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib local_chat --no-run` 编译通过。测试 EXE 直接运行遇既有 Common Controls v6 清单缺失（0xc0000139），仅对 `.tmp/chat-model-native/tests.exe` 副本嵌入现有 Tauri 清单后运行：65 passed / 2 ignored，含 5 项新增测试；没有修改构建脚本或正式 EXE。日志 `.tmp/chat-model-native/local-chat.log`。
- 完整 Vite 构建通过，产物 `apps/desktop/.tmp/chat-model-build/`；既有大包／混合导入及依赖注释提示不阻塞构建。
- 界面截图 `.tmp/chat-models/chat-models.jpg`（合成数据）。CUA 的部分点击遇浏览器 CDP 超时，改用支持的原生键盘完成验证；未将 Cloud 菜单隐藏列为本轮实测界面结果，相关条件分支经过代码审查。
- 未调用真实模型，未发布安装包或部署 Cloud。真实模型输出质量与原生打包体验不在本轮验收范围。
