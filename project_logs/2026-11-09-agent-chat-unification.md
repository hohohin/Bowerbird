# 2026-11-09 Agent 卡片与对话统一（Cloud 已部署，桌面源码待发包）

用户指定以「对话框 → 对话」为准。新 Agent 执行统一复用 `localChatStore` → `local_chat_send`、SQLite 会话和现有四个 provider；不再从 Agent 卡片新建 ds-inbox 或 VPS textRewrite 任务。旧任务只按原身份恢复。桌面源码尚未发布安装包。

## 行为与身份

- 对话发送与 Agent 卡片创建在同一 SQLite 事务中提交。保留原生 chat note 作为历史外键，以同一 nodeId 投影成 `kind:agent` 工作流卡片；画板只显示一个投影。
- 工作流适配层只负责连接输入、视觉规范、输出位置和下游交付。提交前保存 `chatInput.requestId`，按原 requestId 查询 `submittedTurnId`；IPC 回执丢失、刷新、循环恢复不能新建另一轮。取回早期结果不会拿到后续轮次的回复。
- 两个入口共用 provider／Codex 模型与推理强度、详情、续聊、停止、恢复。已有会话保持 provider；模板 v6 保存 provider／模型设置，不携带 conversation、turn 或执行身份。复制卡片同样清除会话身份。
- 移动／移除同步 native history projection；运行中的会话不能删除。移除保留历史，续聊复原同一张卡片。移动／移除已有对话保持原对话权益，新增工作流定义和运行仍由原生 Pro 校验授权。
- 能力以现有对话工具为准：受控建卡与 Codex HyperFrames；其他 provider 的图片仍是本机建卡别名，未新增像素上传、任意文件／命令、自动生图或另一套 Agent loop。旧 Agent 视频／图片交付继续保留恢复路径。

## 文本容量与 Cloud 部署范围

移除合并会重新带入的文本字节限制：前端／SQLite 100000、Codex 迁入历史 300000、Cloud 历史 220000、DSH 桥 300000／1000000、本机响应 2000000、Cloud JSON 300000／320000、Worker 下载／回包 300000／400000、数据库结果 400000、网关聊天请求 20 MiB／回复 1 MiB。文字不按长度裁剪。消息数量、工具协议、现有模型参数、媒体限制、计费和请求身份校验保持原对话契约；实际模型上下文与平台容量仍由上游决定。

本次已配套部署 `chat-proxy`、`chat-worker`（共用 chat.ts）、VPS Worker 两份聊天文件、官网 cloud-proxy.mjs 和定向迁移 `0084_chat_text_capacity.sql`。迁移删除聊天结果字节约束，并让 generation-temp 继承 Storage 全局容量；媒体入口保留各自校验。未顺带推送历史未批准迁移。

部署前已下载现役 Edge 依赖并核对本次文件与修改前基线一致，候选只覆盖本次文件。已启用的 Worker 镜像：`sha256:27bcef4aceef9e2dfcd4b8fa2a8b31d53b819fd62d9781005e22b637c981eb0a`；官网现役 `/opt/bowerbird/website-releases/20261109-agent-chat-unification`，仅 cloud-proxy.mjs 与上一版本不同。原 Skill、环境／Compose、挂载权限和资源限制核对保持不变。

## 验证与边界

- 共用执行、请求回执丢失、原轮次恢复、模板、store 与表格输出 43 项通过。
- 合成完整对话 UI 与 DSH UI 通过：换行、唯一 Agent 卡片、流式回复、停止／失败、续聊、历史移除与恢复、项目隔离、延迟回执、模型入口与原任务恢复；未连接真实模型或用户素材库。
- Worker／DeepSeek 19 项、网关 23 项通过；VPS 隔离候选再次通过同组测试及原 Skill 完整性检查。网关用超过 20 MiB 的聊天文本验证请求及大结果原样传输。
- PGlite 实际执行 0084，验证大结果全文读回、幂等、零价账本、过期清理与原计费边界；Edge 候选 Deno check 通过。
- 原生对话 80 项、工作流 36 项、模板 11 项通过。3 项外部运行时探针按原定义忽略，另明确跳过会写用户 DSH 配置的用例；未启动真实模型。桌面 DSH 协议静态测试 3 项通过，5 项依赖外部运行时的探针未执行。
- TypeScript 相对修改前基线未新增诊断；工作区已有 ProseMirror／Plate 类型诊断，不能声称全仓类型检查通过。日志在 `.tmp/agent-chat-unification/type-compare.log`。
- 浏览器测试页缺失 IndustrialCanvas.css 曾导致装饰 canvas 撑高；仅补测试入口的正式样式，未修改正式装饰逻辑。旧工具事务测试保留历史无投影会话场景，新增 Agent 与工具建卡／撤销共存测试。

证据目录 `.tmp/agent-chat-unification/`；部署清单、读回与验收结果在其 `deploy/`。VPS 暂存 `/tmp/bowerbird-agent-chat-unification-20261109`。桌面源码已编译及隔离验证，未发布新桌面安装包；上述合成 UI／原生测试不代表公开安装包已更新。

## 用户确认后的生产部署与验收

用户明确回复「确认，立即部署」后执行。2026-11-09 19:57:30（北京时间）最终核验通过：

- 0084 已登记，线上迁移全文与本地一致；聊天结果字节约束已删除，状态约束仍在；generation-temp／agent-temp 继承 Storage 平台容量。RLS 强制开启，anon／authenticated 无聊天表直接 SELECT 权限，chat_deepseek 仍为有效 0 Bcoin 价。
- chat-proxy、chat-worker 均为 v3，JWT 设置分别保持 true／false（Worker 保留专用 token 校验）；部署文件读回与候选一致，其他函数版本和 JWT 设置均未变化。
- VPS Worker 运行正常、重启次数 0，原 Skill 导入及文件完整性通过。官网服务 active、Nginx 配置校验通过；本次未修改 Nginx。Worker 两份修改文件读回哈希一致，环境、完整挂载配置与资源限制不变。
- 隔离账号经公网网关完成一次真实 DeepSeek 小对话（输入 521、输出 5 tokens），原 requestId 取回／重放始终为同一任务，变更内容仍拒绝。唯一 hold 和唯一 confirm(0)，账号余额不变；无重复模型提交。
- 大文本用另一个隔离身份创建 uploading 记录并写入明确标注的合成结果，不进入 Worker 队列、不调用模型。公网 create 重放与 get 完整返回 2,280,000 字节回复；请求正文 26,400,065 字节，临时输入 Storage 上传／读回 SHA-256 一致。此项证明传输与存储，不代表模型接受同样大小的上下文。测试对象、合成正文和临时 Auth 已清理，结算审计保留。
- 原用户历史 Agent Run 与 hold 状态对比部署前记录完全一致，没有重提或更改旧任务。

首次 Worker／官网切换因部署脚本逐项比较 Docker Mounts 数组时触发校验失败，自动回退这两项；已应用的 Edge／0084 保持。审查后将完整挂载项按 Destination 排序再比较，仍核验全部路径、权限和字段；未捕获第一次失败时的数组，不能断言其具体顺序。重新确认空队列和原基线后，启用同一候选并全部验收通过。最终只读数据库检查曾遇一次登录 TransportError，重试成功；没有重复提交测试模型任务。

主要证据：`deploy/verified.json`、`deploy/live-test.json`、`deploy/db-after.json`、`deploy/functions-after.json`、`deploy/worker-verify.log`、`deploy/website-verify.log` 与 `complete-activation.log`。Worker 回退镜像为 `sha256:87538bf645e5f70fb4b7ca807079b727e3334e276bdb9b3ea7690d95c7261d5a`（标签 `bowerbird/generation-worker:rollback-agent-chat-20261109`），官网上一版本 `/opt/bowerbird/website-releases/20261109-agent-capacity`；文件备份在 `/opt/bowerbird/deploy-backups/agent-chat-unification-20261109` 及 `-retry`，Edge 前后包均保留。需要回退时先按原任务身份处理在途工作，不撤销账本或重排未知请求；不要重跑已执行的激活脚本。
