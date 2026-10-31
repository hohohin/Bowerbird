# DeepSeek Cloud 对话（源码，未部署）

桌面保有 SQLite 对话历史、工具执行和画板事务。Cloud 仅完成一次受控 DeepSeek 文本请求；不启动 DSH、Agent Run、媒体生成或读取本地图片。固定提示词与 `create_canvas_cards` 定义位于 `supabase/functions/_shared/chat-instructions.txt`、`chat-card-tool.json`，Rust 与 Worker 共用。Worker 使用已有 `DeepSeekBackend.chat`，关闭 thinking、最多 8192 输出 tokens，不重试上游请求。

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

## 配套上线顺序（本次未执行）

1. 单独审核并应用 `0077_chat_completions.sql`；不要用无筛选 `db push` 顺带应用历史未批准迁移。
2. 部署 `chat-proxy`（JWT 校验）与 `chat-worker --no-verify-jwt`（函数内恒定时间校验专用 `CHAT_WORKER_TOKEN`）。`CHAT_ENABLED` 默认关闭。
3. VPS 现有组合 Worker 增加 `CHAT_CONTROL_URL=<Supabase functions/v1/chat-worker>` 与相同 `CHAT_WORKER_TOKEN`，复用已有 `DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL/DEEPSEEK_MODEL`。真实 key 继续只在 VPS；Edge 与桌面不持有。两份 Dockerfile 已复制共享协议及提示词，仍使用当前 Compose 的 `cloud-shared` build context。
4. 前后端配套、官网网关允许 `chat-proxy` 后，验证受控文本 completion、原身份恢复、账本和成本保护，再将 Edge `CHAT_ENABLED=true`。这不代表允许发送图片像素或启用付费价格。
5. 回退时先 `CHAT_ENABLED=false` 拒绝新建，保留 get、Worker 与原队列完成能力；不得删除原 hold／usage 或让未知请求重新排队。

## 动作记录与验证

1. 先检查现有账本和 DeepSeek：发现零价被 hold 表约束挡住，现有模型代理仅在 VPS 本机，故复用单次模型 adapter 与组合 Worker，保留原凭据边界。
2. 先写行为测试并确认缺少协议／迁移失败，再实现输入边界、工具闭集、幂等队列、零价结算、对象 TTL。
3. 补未知传输、结算响应丢失、输入哈希不符与上传失败测试，确认不重复模型或卡片副作用。
4. 离线验证入口：`node apps/cloud/scripts/chat-db.test.mjs <PGlite dist/index.js>`；`node --test src/cloud-chat/runtime.test.ts src/providers/deepseek/backend.test.ts`（agent-worker）；`npm run typecheck`；`deno check .../chat-proxy/index.ts .../chat-worker/index.ts`。

未部署迁移、Edge 或 VPS，未调用真实模型，未修改用户余额。
