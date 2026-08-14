# A1 前置清单（M0 产出）

> 本文件是 M0（A0+V0）交付的「下一阶段 A1 所需准确清单」+「仍未确认前置项」。
> M0 **未实现**任何迁移 / RPC / Function / UI；以下均为 A1 起需要落地的内容。
> 依据：[dev-doc/AGENT-RUNTIME-PLAN.md](../../../dev-doc/AGENT-RUNTIME-PLAN.md) §5 / §6 / §9。

> 2026-08-14 进展：A1-T1 已编码为 `apps/cloud/supabase/migrations/0012_agent_runtime_control_plane.sql`，
> 覆盖 7 表、强制 RLS、own-row SELECT、claim/heartbeat/transition RPC；事务验收脚本为
> `apps/cloud/supabase/tests/agent_runtime.sql`。本机无 Supabase CLI/psql/Docker，待 dev DB 实际执行后再标记验收完成。

## 1. Supabase 迁移（7 张 Agent 表 + 1 个私有 bucket）

按计划 §5 的职责划分（不可合并成一个大 JSON 表）。命名可微调，职责不可变。

| 表 | 关键列 | 唯一/索引 | 说明 |
|---|---|---|---|
| `agent_runs` | id, user_id, skill_id, skill_version, worker_version, kernel_version, status, current_step, progress, input_count, input_manifest_hash, request_object_key, budget_credits, hold_id, actual_credits, pricing_version, lease_owner, lease_expires_at, heartbeat_at, attempt_count, cancel_requested_at, approval_required, checkpoint_object_key, checkpoint_hash, snapshot_schema_version, context_capsule_hash, error_code, safe_message, created_at, queued_at, started_at, finished_at, content_expires_at | idx(user_id,status); idx(status,lease_expires_at) | DB 行**不存**目标全文/完整计划/模型上下文（属短期私有对象） |
| `agent_events` | run_id, seq, type, step, progress, display_payload, created_at, content_expires_at | unique(run_id, seq) | Worker 批量上报；重放幂等 |
| `agent_approvals` | id, run_id, kind, proposal_object_key, estimated_additional_credits, status(pending/approved/rejected/expired), requested_at, decided_at, expires_at | idx(run_id) | 首版 kind 仅 `creative_plan`/`refine_plan` |
| `agent_clarifications` | id, run_id, question_key, context_hash, status, question_object_key, answer_object_key, intent_patch_hash, asked_at, answered_at, expires_at | unique(run_id, question_key) | 防恢复后重复提问；回答须匹配仍有效 context_hash |
| `agent_artifacts` | id, run_id, kind, object_key, mime, bytes, sha256, source_call_id, expires_at, downloaded_at, deleted_at | idx(run_id) | 不存公开 URL；下载由控制面短时签名 |
| `agent_usage_items` | id, run_id, call_id, kind, provider, model, input_units, output_units, image_count, resolution, provider_cost_micros, credits, pricing_version, created_at | unique(run_id, call_id) | Worker 报原始 usage；**Edge 按 pricing_version 重算 credits，不接受 Worker 总额** |
| `agent_tool_calls` | run_id, call_id, phase, tool_name, args_hash, attempt, status(prepared/submitted/succeeded/failed/outcome_unknown), provider_request_id, result_object_key, result_hash, started_at, submitted_at, finished_at, safe_error_code | unique(run_id, call_id) | 副作用账本；submitted 后崩溃须先查询上游再决定重放 |

### RLS / RPC

- 上述 7 表：用户仅 own-row `SELECT`；不能直接 `INSERT/UPDATE/DELETE`，全经 Edge Functions。
- `SECURITY DEFINER` + 固定 `search_path`；沿用现有 `_shared` 鉴权 / 错误码 / safeLog。
- 服务端专属 RPC（事务内）：
  - `claim_agent_run(p_worker_id)` — `FOR UPDATE SKIP LOCKED` 原子认领 queued/可恢复 Run，返回租约 + 短期输入 URL。
  - `heartbeat_agent_run(p_lease_id)` — 续租 + 读取 cancel/approval 信号。
  - `transition_agent_run(p_lease_id, p_to, p_snapshot_ref)` — 校验租约 + 合法状态转换。
  - `append_agent_events(p_lease_id, p_events[])` — 幂等批量追加（unique(run_id,seq)）。
  - `record_agent_usage(p_lease_id, p_items[])` — 幂等记录原始 usage；**credits 由服务端计算**。
  - `register_tool_call(p_lease_id, p_call)` / `tool_submitted` / `tool_complete` — 维护副作用账本。
  - `request_approval(p_lease_id, p_kind, p_proposal_obj, p_estimated)` — 建审批 + 暂停 Run。
  - `register_artifact(p_lease_id, p_artifact)` — 登记输出对象/hash/mime/bytes。
  - `answer_clarification(p_run_id, p_question_key, p_context_hash, p_patch)` — 校验 context_hash 仍有效后写 IntentPatch。
  - `finish_agent_run(p_lease_id, p_usage[])` — 服务端聚合 usage + `credit_confirm(actual)` + 状态收口（同事务）。
  - `fail_agent_run(p_lease_id, p_code, p_safe_msg)` — 按已产生 usage 结算后置 failed。

### 私有对象存储

- 新建 private bucket `agent-temp`；对象 key 用随机 id，**不含文件名/邮箱/用户输入**。
- 签名 URL 单次、短时；TTL：输入/中间状态 ≤24h，最终产物 ≤7d（用户确认下载后提前清理）。
- 接入现有 `ensure_daily_credits` / managed usage guard（0010）/ 请求 id / CORS / 稳定错误码。

## 2. Edge Functions（2 个）

| Function | 鉴权 | actions |
|---|---|---|
| `agent-run` | 用户 Bearer JWT + publishable key | `create` / `enqueue` / `get` / `approve` / `reject` / `answer_clarification` / `result_feedback` / `cancel` / `artifact_url` / `artifact_received` |
| `agent-worker` | 独立高熵 Worker Token（常量时间比较；存 VPS secret + Function secret；**不下发 service_role**） | `claim` / `heartbeat` / `events` / `usage` / `checkpoint` / `tool_prepare` / `tool_submitted` / `tool_complete` / `approval_request` / `artifact` / `finish` / `fail` |

create 时复用现有 `credit_hold(idempotency_key, estimated=budget_credits)`；finish 由服务端 `credit_confirm(actual)`。

## 3. FeaturePolicy 新字段（服务端派生，单一事实源）

```ts
can_use_agent_runs: boolean;
max_parallel_agent_runs: number;     // 并发闸（UI/store/Rust command 三层复核）
allowed_agent_skills: string[];      // 首版 ["series-creative-director"] / ["smart-refinement"]
agent_budget_options: string[];      // 服务端定义的预算档位 id
```

POC 阶段先用服务端 feature flag / 测试账号 allowlist；**正式档位归属必须先更新定价文档再落 FeaturePolicy**。

## 4. service_costs 配置（费率）

- `agent_smart_refinement`（**首个实现 Skill**）：费率按真实 token 换算——**DeepSeek 文本回合**按 prompt/completion tokens、**方舟 Seedream 出图**按张、**方舟 vision 看图**按次；定价版本/生效时间/毛利保护。`maxGenerateAttempts=1`。
- `agent_series_director`：**暂不开发**（manifest + 18 eval case 已冻结，留待 smart-refinement 验证稳定后另立）；费率配置随之延后。
- `visual_profile_extract`：按反推卡数 / 文本 token / 批次数 / 聚合回合计费；上传的是反推 JSON 快照不是图片。
- 方向验证图：按一次普通 Cloud 文生图计费，与提炼分别展示/确认。
- M0 临时费率（[src/kernel/budget.ts](src/kernel/budget.ts) `M0_FIXED_TARIFF`）：每动作固定积分降级规则；A1 起由 `service_costs` + Edge 纯函数替换。

## 5. 仍未确认的前置项（阻塞 A1+ 真实联调，不阻塞 M0）

| # | 项 | 计划任务 | 现状 |
|---|---|---|---|
| U1 | **DeepSeek 文本回合**（`deepseek-chat`；`deepseek-reasoner` 按项目约定禁用）tool calling + usage 返回 | A0-T1 | ✅ **真实两回合 spike 已通过**（2026-08-14）：模型 action → 本地假工具结果 → 模型继续，usage 与 provider request id 可审计；脱敏 fixture 为 `src/fixtures/deepseek-tool-calling.json`。官方新名称 `deepseek-v4-flash` 在当前账号/端点实测 `400 invalid_request_error`，故模型必须由 `DEEPSEEK_MODEL` 显式配置，暂保留已验证的 `deepseek-chat`。**DeepSeek 不接受 image_url → 看图仍方舟 vision、出图方舟 Seedream**。 |
| U2 | **Vision + Seedream 从 VPS 出站**：区域、时延、并发、错误恢复（不得用用户素材，用合成图） | A0-T2 | **未做真实 spike**；复用现有 `_shared/ark.ts` 真实契约（Vision/Seedream 已联调通过），但「从腾讯云轻量 VPS 出站到方舟 + DeepSeek」未验证。 |
| U3 | `credit_hold(p_estimated_amount)` 承载预算上限的最小迁移 | A0-T3 | **仅列清单（见 §1）**；未实现。现有 hold/confirm/rollback（0003/0004/0010）语义足够，A1 直接复用。 |
| U4 | **预算档位 / 定价 / FeaturePolicy** | A0-T5 | ✅ 用户已定（2026-08-14）：smart-refinement **按 token 换算**、series-director **暂不开发**、**3 档（free/pro/studio）都可用**；FeaturePolicy 字段见 §3，POC 用 allowlist（`admin@bowerbird.cn`）。 |
| U5 | **TTL 默认值**：输入/中间 24h、最终产物 7d | A0-T5 | ✅ 用户已确认接受（2026-08-14）。 |
| U6 | **VPS 规格 / 部署方式**（系统/CPU/RAM/磁盘/SSH；Worker 不要求域名） | A7 | ✅ 用户提供（2026-08-14）：腾讯云轻量云 Ubuntu 24.04 / 2vCPU / **2GiB** / 50GiB。⚠️ 2GiB 偏紧，建议加 2G swap + 并发上限 1–2（推理在 DeepSeek/方舟，Worker 只编排）；部署建议 **SSH + Docker**。 |
| U7 | 真实支付 | — | 已暂停（备案/商户资质前置）；不阻塞 Agent Run MVP（A0–A5）。 |

## 6. M0 已落地的契约（供 A1+ 直接对齐）

- 9 个 v1 契约：[src/contracts/](src/contracts/)。
- 工具白名单 + 跨 Run 守卫 + 审批/次数/预算门控：[src/kernel/policy-engine.ts](src/kernel/policy-engine.ts) `GLOBAL_TOOL_REGISTRY` / `evaluatePolicy`。
- 稳定 `call_id` + `args_hash` 幂等：[src/kernel/tool-ledger.ts](src/kernel/tool-ledger.ts)。
- 智能精修 phase graph（A1 状态机须与之一致）：[src/skills/smart-refinement/manifest.ts](src/skills/smart-refinement/manifest.ts)。
- 系列创作导演 phase graph + 18 eval case：[src/skills/series-creative-director/](src/skills/series-creative-director/)。
- 视觉设定规范化 / scope hash / 提炼 / 分批：[src/visual/](src/visual/)。
