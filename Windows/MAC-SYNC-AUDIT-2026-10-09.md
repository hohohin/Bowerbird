# 2026-10-09 Mac 增量复核

## 源码身份与遗漏原因

Windows 26.10.901 的源码为 `dev@45d5652`，此前接收 Mac 到 `d537a66`。本轮重新核对远端 `origin/mac@d6027fb8280ce8ab9452fe06ad04bcbcde178bfe`，确认漏掉两个提交：

| 提交 | 实际内容 | Windows 处理 |
|---|---|---|
| `08ada63` | Codex CLI Agent、循环起点/停止后恢复、数据包直接交换、Codex 退出登录、入口开关、原生生图等待、Mac 开发回调及发布准备 | 完整合并共享源码与文档，保留 Mac 条件实现 |
| `d6027fb` | Mac 26.10.801 产物记录与网站下载准备 | 合并历史证据；保留已经上线的 Windows 26.10.901 与 Mac 26.10.801 状态 |

相对 `d537a66` 共 45 个文件、1265 行新增、114 行删除。上次把这两次提交误判为仅 Mac 打包内容，没有完整读取 `08ada63` 的共享源码，这是 Codex 通道遗漏的直接原因。

## 功能逐项核对

| 能力 | 源码与验证入口 | 合并结果 |
|---|---|---|
| Agent 三通道及通道持久化 | `CanvasWorkflowLayer.tsx`、`canvasWorkflow.ts`、`api.ts`、Agent Codex UI 测试 | 本机 DSH、Codex CLI、Cloud 文本通道完整保留 |
| Codex 图文/表格结果 | `commands/agent_ds/codex.rs`、`canvasWorkflowRuntime.ts` | 复用既有结果信封、图片入库与内容 writer，不新增 Runner |
| 独立会话与循环项隔离 | Codex adapter、Agent Codex UI 测试 | 明确 UUID resume，同卡互斥，循环项不污染普通会话 |
| 重复请求/中断/取消 | Codex adapter 与 runtime | 收件记录去重，未知提交不自动重发，取消等待进程结束 |
| 生图原生等待 | `agent_generation_wait.rs`、`main.rs`、`lib.rs` | 主程序在 Tauri/认证/数据库启动前处理无界面等待参数 |
| 默认生图 provider | Agent provider UI 测试 | 锁定标星默认值、恢复原任务、失败不自动换引擎 |
| 循环指定起点与停止后恢复 | `workflowLoop.ts`、runtime、Rust workflow 校验、循环 UI 测试 | 冻结输入，按指定项起跑，保留编号与原执行身份 |
| 数据包直接导出/导入 | Save dialog、Template library、Rust export、模板 UI 测试 | 不落模板库；兼容 Windows v3 封装布局与旧 v1/v2 |
| Codex 退出登录 | `cli_credentials.rs`、`commands/codex.rs`、Settings dialog、退出登录 UI 测试 | 只清理 Bowerbird 私有认证，失败保留状态，登录操作互斥 |
| 暂隐技能/助手/模板入口 | `featureFlags.ts`、Workspace、UI 与专项测试 | 开发/正式入口开关一致；已有数据与交换菜单保留 |
| Mac 开发登录回调 | `macOS/dev-Info.plist`、签名启动与测试脚本 | 保留 Mac 实现，不替换 Windows URL 回调 |
| Windows 已有封装与预览 | v3 模板、preview、enclosure、Rust 事务 | 与 Mac 数据包功能组合，不用 Mac v2 文件覆盖 Windows v3 |
| Windows 原生资源/媒体/私有 CLI | `build.rs`、FFmpeg、CLI launcher 与安装钩子 | 保留现有平台实现与隔离认证协议 |

## 正式构建的额外差异

Mac 最新源码本身仍有开发限制，不能仅靠合并解决正式安装包的旧卡片：

1. `CanvasWorkflowLayer.tsx` 的选择器和图文提示取决于 `import.meta.env.DEV`。
2. `canvasWorkflow.ts` 的图片出口/自动连接输入与 runtime 的本机执行路径取决于 DEV；正式构建进入 Cloud 文本路径。
3. Rust 本机工作流端点调用 `ensure_preview_enabled()`，拒绝非 debug 构建。
4. `.agent-z` 请求根目录使用构建时 `CARGO_MANIFEST_DIR`，安装后仍指向打包机源码目录。

正式包开放需要明确处理这四层，并保留本机 BYO 权益、生图权限/登录/积分与独立私有 CLI 认证。旧开发聊天和编排助手的限制不应顺带解除。自动审批曾拒绝批量解除限制；该操作未执行，用户确认前保持 Mac 原始范围。安装包不能宣称已具备正式版本机图文 Agent。

## 后续正式版授权与修正（2026-10-09）

用户随后明确授权正式版隐藏技能卡片/模板库，开放 Agent 图文输出和 Codex CLI，并重新发版替换 26.10.901。四层生产差异已修正：选择器/图文端口/执行链路解除 DEV，后端仅开放工作流 `agent-text` 并保留 BYO，生产请求改存 AppData。旧开发聊天和规划仍受保护。真实 production bundle 三组 Agent 回归、五项生产条件原生验证及 Rust 全量 464 项通过。候选版本 26.10.902，签名与公开发布正在进行；前次审计中未执行解除限制的记录为历史状态。

## 验证与边界

- TypeScript 类型检查、Vite 正式前端构建、Rust 全部目标编译检查通过。正式 bundle 检查确认 Agent 选择器与 Codex 通道标签被 DEV 分支裁掉，不将此构建视为正式版图文 Agent 可用。
- Rust 全量库测试：**464 passed / 0 failed / 10 ignored**，使用项目内隔离 AppData；新增 Windows 原生假 CLI 覆盖真实 private-profile launcher、含空格/中文路径、stdin、会话恢复、循环隔离、重复请求、错误/缺结果和取消。未调用真实模型。
- **11 组** Chromium 合成 IPC 回归通过：Codex Agent、默认 provider、循环起点/恢复、数据包与模板（34 项）、Codex 退出登录、工作流 UI/入口开关、Agent 图片、Windows 封装、助手（48 项）、planning-v2（52 项）、助手引用（8 项）。首次并行工作流预览加载超时，顺序复跑通过。
- 全部 Mac 增量文件已逐项比较；仍与 Mac 不同的共享源码均为 Windows 原有封装/v3 布局或本轮原生测试，版本和部署文档保持平台实际记录。
- 实际账号模型、用户素材库升级、真实安装后生图和 Mac 原生行为不能由合成测试替代。当前 Windows 公共版本仍为 26.10.901。

本机证据目录：`.tmp/mac-sync-audit-20261009/`。该目录不纳入 Git。
