# DSH · Cloud 对话（已部署，测试 0 Bcoin）

## 2026-11-13 Agent 卡片运行回执

北京时间 13:15，生产 `chat-proxy` 从 v7 升至 v8，接受可选的 `run_status`（started、failed、unknown）。JWT 校验开启，重新下载的七份文件与候选逐字节一致。13:17 切换 VPS generation-worker 到 `sha256:394ad4f896f411a1a8406c2ebc12685a0dce92d161e1f32ce37ea0672596ec51`，镜像中已核对工具定义、提示词、回执解析三份文件。切换前在途执行数为零，切换后运行正常；已比对环境变量、挂载及资源限制。首次切换因按顺序比较环境变量列表触发回滚，改为完整条目排序比对后通过。候选断网 DSH 测试 9 项通过。

正式网关隔离账号验证了 v2 真实模型发出的 `runCard: "start"` 和触发卡到生成卡的连线。模拟桌面返回“已建卡、启动失败”，原单成功完成，助手准确报告启动失败。临时账号和请求对象已清理。线上测试没有提交图片生成；终端用户实际启动卡片需要包含本次启动桥的桌面版本。

本地 `.tmp/canvas-card-run-release/before/` 保存 v7 原包，`edge-live.json`、`worker-live.json`、`smoke.json` 保存现役核验。Worker 上保留旧镜像和 `/opt/bowerbird/deploy-backups/canvas-card-run-jIXsHydc/switch.py`，需回退时以 `rollback` 参数执行。

## 2026-11-13 11:36 只受理 DSH v2 新单

生产 `chat-proxy` 从 v6 升至 v7；`chat-worker` 保持 v6。报价的 provider 为 `dsh-cloud`，唯一接受新单的协议为 `dsh-vps-v2`。旧版普通 completion 和 DSH v1 创建新任务返回 HTTP 426，并提示更新 Bowerbird 桌面端。旧原单使用原账号、原幂等键与一致的输入哈希重放。旧任务按原协议领取和结算。此次只变更聊天网关，没有数据库迁移或 VPS 镜像切换。

正式网关使用隔离账号验证了两种旧请求在切换后拒新、没有新建任务与预授权；切换前受理的旧单按键取回与重放成功；新的 DSH v2 请求完成真实模型调用，可按原键重放，且服务端记录原生会话身份。线上回执位于 `.tmp/dsh-vps-native/sole-provider-evidence.json`。已核对现役函数与候选的七个文件；回滚基线为 `.tmp/cloud-provider-cutover/before/` 中的生产 v6。

## 2026-11-13 VPS DSH 原生会话控制面

`dsh-vps-v2` 的 create 接口接收 `conversation_id`、本轮唯一一条 `user` 消息及本轮工具／技能配置。Edge 用实际登录用户创建任务。PostgreSQL 将账号和对话 ID 派生为 Worker 私有会话标识，同时冻结上一个成功任务的 ID。进行中的同会话拒绝另开请求；重复提交原键返回原任务。不同账号即使传相同对话 ID，也会得到独立会话。自动流程每轮使用 `t-` 前缀的唯一 ID，后续请求不能复用。

2026-11-13 北京时间 09:30 在 `wpupyuurwmaeozyvkyuo` 定向部署 0088、0089 以及 `chat-worker` v4、`chat-proxy` v4。原 completion、v1 整轮与 v2 原生会话共存。旧 Worker 只能领取其支持的任务。关闭 `CHAT_DSH_VPS_V2_ENABLED` 可停止新建 v2，同时保留 get、cancel 和原任务结算。普通账号的 v2 可用性以经鉴权的 `quote.dsh_vps_v2_available` 为准，技能仍受原统一 Agent 门控。部署运行记录与候选文件哈希见 `.tmp/dsh-vps-native/edge/`。

09:31 下载两份生产 Edge 共 10 个源文件，逐字节匹配已测候选。生产 Worker 切换至 `sha256:b596d516af107046555d4638ccadb013c1028a72bc8b9454b41baec42b312be7` 并核验原生会话卷后，09:39 开放 DSH v1、v2，随后复核两项开关及 `CHAT_ENABLED` 的服务端摘要均对应 `true`。

## VPS DSH 整轮对话 v1 协议（2026-11-12）

桌面以 `engine: "dsh-vps-v1"` 创建一轮对话，在 `messages` 中发送公开的用户、助手历史和本轮用户输入。Cloud 以原聊天任务、幂等键和租约执行整轮。测试价仍为 0 Bcoin，每轮一次预授权，内部成本按最多 12 次模型调用预留。已有客户端省略 engine，继续使用原单次 completion 协议。

- `chat-proxy.quote` 返回 `dsh_vps_available` 及 `dsh_vps_skills_available`。前者需要聊天可用、零测试价和 `CHAT_DSH_VPS_ENABLED=true`。后者还要求统一 Agent 的服务器开关、测试账号标记和对应权益。创建时重新校验。本机仅提交文字编辑技能 ID，或 H3 技能 ID 和受限参数；技能由 VPS 加载。带技能的轮次关闭建卡工具。
- Worker 单独的 DSH 消费槽在 claim 声明同名 engine，只领取 DSH 整轮任务。原 completion 消费槽及旧版 Worker 继续领取单次 completion。Worker 的 `dsh_poll` 使用有效租约续租并取得轻量回执，`tool_request` 登记单个待办 `create_canvas_cards`。用户的 `get` 仅在租约及内容均有效时返回 `pending_tool: {id,name,arguments}`。桌面以原调用 ID 去重执行，将 `{success:true,created_count}` 或 `{success:false,error:"card_creation_failed"}` 通过 `tool_result` 回传。同 ID 的重复回执须相同。
- 用户按原任务 ID 或幂等键 `cancel`。排队或上传中的任务停止并退预授权，已领取的任务进入 `outcome_unknown` 并保留待核对的预授权。终态清除待办参数和回执。旧 completion 的取消和恢复规则沿用原接口。过期的租约不能发布工具请求、提交回执或续租。
- 部署依赖按顺序为 0088 定向迁移、两个聊天 Edge、能执行 VPS DSH 的 Worker、配套桌面端。先在功能开关关闭时验证旧任务兼容，再验证新 Worker 领取、工具回传、取消与原单取回，最后开放入口。回退先关闭 `CHAT_DSH_VPS_ENABLED`，保留新版 Worker 及 Edge 等待在途 DSH 任务结束。数据库迁移、已有任务和账本予以保留。

## 2026-11-11 聊天失败原因（候选已验证，待部署确认）

聊天 Worker 向 `chat-worker` 上报固定原因码，复用 `chat_completion_jobs.error_code` 保存。连接中断、超时、上游 HTTP 状态、无效 JSON、回复结构和工具参数分别记录。Worker 诊断只写任务编号、状态和原因码。4xx 仍走已拒绝结算，其他提交后无法确认的结果保留原预授权语义。

`chat-proxy` 对已结束且没有可取回回复的任务返回中文原因和 `error.recoverable=false`。新桌面端在会话详情展示原因、隐藏取回按钮，并让工作流结束该步骤。旧任务只按已知终态提示。中断时查询原任务仍可取回成功回复，查询得到终态后保存结论并保留已有文字。

两个 Edge 候选分别从现役 v3 下载后定向修改。VPS 隔离候选镜像为 `sha256:093e33788562ab84dbb02097ca9f52b0e9d23a6ba57d3ca9897fc44d09271a18`。部署范围为两个聊天 Edge 与 VPS 聊天 Worker，无数据库迁移。桌面改动需要新版客户端。候选哈希和验收证据在 `.tmp/chat-upstream-diagnostics/`。

## 2026-11-09 已部署：统一 Agent 卡片文本链路

新 Agent 卡片复用桌面对话服务；聊天 Edge／Worker／官网网关取消应用文字字节拦截，0084 删除 result_json 400000 字节约束并让 generation-temp 继承平台全局容量。128 条消息、工具闭集、模型参数、媒体校验、0 Bcoin 测试价和幂等／租约／TTL 保持现有契约。以下旧接口说明中的 300000 字节上限在线上已移除。

经用户明确确认，0084、chat-proxy／chat-worker v3、VPS 聊天 Worker 和官网网关已部署，2026-11-09 19:57:30（北京时间）核验通过。真实小对话、原请求取回、唯一零额结算通过；26,400,065 字节输入和 2,280,000 字节回复经公网完整往返，大文本采用隔离合成结果，未额外调用模型。RLS、计费、其他云函数与原用户任务状态保持；桌面源码已验证但未发布新安装包。具体范围、现役镜像和证据见[实施记录](../../project_logs/2026-11-09-agent-chat-unification.md)。

桌面保有 SQLite 对话历史、工具执行和画板事务。Cloud 仅完成一次受控 DeepSeek 文本请求；不启动 DSH、Agent Run、媒体生成或读取本地图片。固定提示词与 `create_canvas_cards` 定义位于 `supabase/functions/_shared/chat-instructions.txt`、`chat-card-tool.json`，Rust 与 Worker 共用；2026-11-12 起卡片项为单对象 + `kind` 枚举（不再用联合 `oneOf`），Rust 侧按 kind 丢弃跨类型字段。Worker 使用已有 `DeepSeekBackend.chat`，关闭 thinking、最多 8192 输出 tokens，不重试上游请求。

## 2026-11-07 上线记录

01:34:05（北京时间）完成官网真实对话验收。0077 已定向应用；chat-proxy／chat-worker v2 已部署，CHAT_ENABLED=true，向已登录用户开放。Worker 镜像 `8799ba09e5de45ed620b980f844f1ed8ee99c83cb5ee3bfb359206a1760b7b8e` 基于现役仅加入聊天增量；DeepSeek · Cloud 与 DSH · Cloud 共用此服务。现有 26.11.602 客户端无需重打包，平台 key 仍只在 VPS。

18 项线上检查通过，一次真实回复记录 521 输入／5 输出 tokens、唯一 confirm(0)，重放与原键查询未增加任务，余额保持；临时 Auth 已清理。0078 后补 0077 的兼容演练与线上定义回查确认既有计费／赠币不变；18 项 Worker 回归、Deno、候选断网导入及 7 份 Edge 文件读回通过。完整记录、全量 typecheck 的既有测试声明阻断和验证边界见 [行动记录](../../project_logs/2026-11-07-cloud-chat.md)，发布／回退详情见 [部署指引](DEPLOY.md#2026-11-07-cloud-对话已部署0-bcoin)。

## 接口

`chat-proxy` 使用用户 JWT；仅支持 POST：

- `action:quote` 返回 `provider,service,currency,unit_cost,pricing_version,available`。provider 为 `deepseek-cloud`，service 为 `chat_deepseek`。
- `action:create,idempotency_key,messages,tools_enabled?`：仅接受文本 `user/assistant/tool` 消息，128 条／300000 UTF-8 字节，工具回执必须匹配先前调用。禁止客户端指定 system、模型、工具定义及图片内容。
- `action:get` 携带 `job_id` 或 `idempotency_key`（二选一）；只查询当前用户原请求，不重新提交。

任务响应包含 `job_id,status,charge`；成功额外包含原生 `message`、`usage`、`model`。状态为 `uploading/queued/running/succeeded/failed/outcome_unknown`。消息含 `tool_calls` 时由桌面现有受控编译器执行，再把工具回执作为下一次 completion 输入。`tools_enabled=false` 用于纯聊；它不授予任何本机建卡权益。

## 计费、恢复和内容生命周期

- 0077 迁移创建测试价 **0 Bcoin** 服务。仍原子创建 `credit_holds`、预留用量、成功 `credit_confirm(0)`，零确认流水可审计。只放开 `chat_deepseek` 的零预授权，其他服务约束保留。
- 当前客户端契约只开放零测试价：服务端目录改为非零后，quote 不可用，新 create 拒绝。正式启价须先补每轮多 completion 的预算／报价确认，不能只修改目录静默收费。
- 每 completion 独立幂等身份；同身份同输入返回原任务，不同输入拒绝。未知上游／Worker 租约失效保留 `outcome_unknown` 和待结算 hold，不重排、不自动退款。用户可按原身份取回已有结果。
- 测试零价仍启用账号分钟频率与全局成本限制。目录 `provider_cost_reserve_micros=2000000` 为每次保守内部成本预留，不是用户售价或实测供应商成本。真实 tokens 与模型身份作为独立元数据保留。
- 请求仅暂存私有 `generation-temp/chat/.../request.json`；Worker 使用 180 秒签名 URL 并核对 SHA-256。24 小时后删除请求对象与临时结果；持久保留任务身份、usage 和计费事实，本地已保存历史不受影响。未开始的过期任务退款，已提交但结果未知的任务保留待核对。

## 配套上线顺序

1. 单独审核并应用 `0077_chat_completions.sql`；不要用无筛选 `db push` 顺带应用历史未批准迁移。
2. 部署 `chat-proxy`（JWT 校验）与 `chat-worker --no-verify-jwt`（函数内恒定时间校验专用 `CHAT_WORKER_TOKEN`）。`CHAT_ENABLED` 默认关闭。
3. VPS 现有组合 Worker 增加 `CHAT_CONTROL_URL=<Supabase functions/v1/chat-worker>` 与相同 `CHAT_WORKER_TOKEN`，复用已有 `DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL/DEEPSEEK_MODEL`。真实 key 继续只在 VPS；Edge 与桌面不持有。两份 Dockerfile 已复制共享协议及提示词，仍使用当前 Compose 的 `cloud-shared` build context。
4. 前后端配套、官网网关允许 `chat-proxy` 后，先完成候选离线和空队列检查，再将 Edge `CHAT_ENABLED=true`，立即验证真实文本 completion、原身份恢复与零额账本；失败先关闭开关并保留原任务。图片像素与付费价格仍不开放。
5. 回退时先 `CHAT_ENABLED=false` 拒绝新建，保留 get、Worker 与原队列完成能力；不得删除原 hold／usage 或让未知请求重新排队。

## 动作记录与验证

1. 先检查现有账本和 DeepSeek：发现零价被 hold 表约束挡住，现有模型代理仅在 VPS 本机，故复用单次模型 adapter 与组合 Worker，保留原凭据边界。
2. 先写行为测试并确认缺少协议／迁移失败，再实现输入边界、工具闭集、幂等队列、零价结算、对象 TTL。
3. 补未知传输、结算响应丢失、输入哈希不符与上传失败测试，确认不重复模型或卡片副作用。
4. 离线验证入口：`node apps/cloud/scripts/chat-db.test.mjs <PGlite dist/index.js>`；`node --test src/cloud-chat/runtime.test.ts src/providers/deepseek/backend.test.ts`（agent-worker）；`npm run typecheck`；`deno check .../chat-proxy/index.ts .../chat-worker/index.ts`。

以上为最初源码阶段记录；2026-11-07 已完成本文顶部记录的部署与一次真实模型验收。
