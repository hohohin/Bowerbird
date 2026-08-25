# @bowerbird/agent-worker — Bowerbird Agent Runtime

> 状态：**首版 `bowerbird-controlled-image-edit` 的动态规划、有限澄清、可恢复 RunEngine、确定性上下文组装/压缩、隔离 Run workspace、两阶段 artifact、真实 DeepSeek/方舟 Vision/Seedream adapter、反馈修订二次审批、PreferenceCapsule、可信计量/结算、TTL、容量闸与运行监控均已部署并通过真实 E2E（144 测试全过）**。
> 桌面 Agent 主路径已人工验收，A5 完成；A6 安全/Cloud 回归与 A7 VPS 运维基线完成。Codex Agent CLI 真机 E2E 已成功，但因双重思考/对话耗时过长暂时禁止新建该组合。Dreamina Agent CLI 真机 E2E 按 2026-08-25 用户决定暂时跳过：实现保留、未宣称验证通过，也不再作为当前发布或继续开发门槛。
> 依据：[dev-doc/AGENT-RUNTIME-PLAN.md](../../../dev-doc/AGENT-RUNTIME-PLAN.md) §A2 / §A3。

## 当前已实现

- **冻结 9 个 v1 契约**（TypeScript 类型）：`ModelBackend` / `SkillManifest` / `RunSnapshot` /
  `ToolCall` / `ClarificationProposal` / `IntentPatch` / `VisualEvidenceCard` /
  `VisualProfileDraft` / `VisualProfileCapsule`，外加 `PreferenceCapsule`、events、run。
  - 见 [src/contracts/](src/contracts/)。
- **纯函数 Kernel 门控**（无 I/O）：`PhaseMachine` / `PolicyEngine`（全局工具白名单 + 跨 Run 守卫 +
  审批前置 + 次数/预算上限）/ `ToolLedger`（稳定 `call_id` + `args_hash` 幂等）/ `Budget`。
  - 见 [src/kernel/](src/kernel/)。这是「非法动作在模型外被拒」的确定性实现。
- **确定性上下文构建**：按固定 kind 优先级组装，校验 source/trust/content hash；超预算时只压缩低优先级偏好、视觉和旧工具结果，摘要保留来源 hash，必需块无法容纳时 fail closed。受控编辑三个规划回合均使用同一 24k token 边界。
  - 见 [src/kernel/context-builder.ts](src/kernel/context-builder.ts)。
- **有限澄清**：仅在会改变底图职责、路线或预算的文本歧义处一次一问；稳定 question key + 当前 context hash 去重，每 Run 最多 3 次。每个答案由模型预先映射到白名单 `IntentPatch`，控制面按所选答案编译并事务性清空旧计划审批，恢复后从纯文本分析重新规划。
  - 见 [src/kernel/clarification-policy.ts](src/kernel/clarification-policy.ts)、[src/contracts/clarification.ts](src/contracts/clarification.ts)。
- **FakeModel + FakeTools + eval runner**：确定性、可脚本化；runner 把三者串成可观测的 in-memory Run。
  - 见 [src/fakes/](src/fakes/)、[src/eval/runner.ts](src/eval/runner.ts)。
- **智能精修 Skill**（M0 可运行目标）：结构化意图 → 参考图职责 → 分维度评分 → 必要时精修一次。
  - [src/skills/smart-refinement/](src/skills/smart-refinement/)。
- **系列创作导演 Skill**：manifest + 18 个 eval case **冻结**（契约级，eval 执行在 A3）。
  - [src/skills/series-creative-director/](src/skills/series-creative-director/)。
- **视觉设定 V0**：caption → `VisualEvidenceCard` 规范化、`source_scope_hash`、确定性 map-reduce 提炼、
  token 预算分批；5 个纯 caption fixture。**不读取/上传图片，只用反推结构化数据。**
  - 见 [src/visual/](src/visual/)、[src/fixtures/visual-captions.ts](src/fixtures/visual-captions.ts)。
- **DeepSeek ModelBackend + A0-T1 spike**：单 action 归一化、usage、坏 JSON、并行工具、HTTP 错误与取消均 fail closed；真实两回合已通过，脱敏结果见 [src/fixtures/deepseek-tool-calling.json](src/fixtures/deepseek-tool-calling.json)。
- **A3-T7 指标评测**：18 案例混合真实 DeepSeek 纯文本规划与确定性 Kernel 探针，输出意图/职责/策略/过度规划/结构化/越权/token/预计积分/失败分类报告；不调用 Vision 或生图。DeepSeek V4 路径显式关闭默认 thinking，以兼容 Kernel 的强制单工具动作并避免重复思考耗时。
- **本机预览 step runner**：从 JSON checkpoint 恢复，连续执行纯 workspace/kernel phase，在审批与真实 provider 工具前暂停；审批拒绝不生成，精修最多一次。
  - 见 [src/local/](src/local/)；由桌面开发构建经 stdin/stdout 调用。
- **受控编辑可恢复执行**：动态 `PlanStep[]`、批准 hash/游标、两阶段远端 checkpoint、poll/claim/heartbeat consumer、durable tool dispatcher；Fake Run 覆盖提交后 kill/restart 且副作用恰好一次。
  - 见 [src/cloud-agent/](src/cloud-agent/)、[src/control-plane/](src/control-plane/)、[src/kernel/controlled-run-engine.ts](src/kernel/controlled-run-engine.ts)。
- **运行期图片链路**：批准前不下载参考图；批准后才在 `/workspaces/<run-id>` 校验物化。Seedream 结果先落工作区，再经 `artifact_prepare → signed PUT → artifact commit/hash+magic 校验` 登记；同一 `source_call_id` 幂等恢复。
  - 见 [src/cloud-agent/run-workspace.ts](src/cloud-agent/run-workspace.ts)、[src/providers/ark/controlled-image-executor.ts](src/providers/ark/controlled-image-executor.ts)。
- **反馈修订链路**：用户反馈后才允许方舟 Vision 比较必要参考与当前结果；诊断先落私有 `diagnostic` artifact，再由 DeepSeek 生成必须引用上一结果的新计划，经过新 hash 二次审批后执行一次纠偏生成。
  - 见 [src/providers/ark/feedback-diagnoser.ts](src/providers/ark/feedback-diagnoser.ts)、[src/kernel/controlled-run-engine.ts](src/kernel/controlled-run-engine.ts)。
- **原子结算与恢复**：终态、usage 聚合、hold confirm/rollback 在数据库单事务内完成；过期 `exporting` Run 可重新领取并幂等完成结算。
- **可信计量与短期内容清理**：DeepSeek 回合使用稳定 call id 先记 submitted、持久化脱敏结果再写 usage，恢复不重复请求；Edge 以版本化 `service_costs` 复核 provider/工具/预算。Agent consumer 每 10 分钟清理过期对象和事件正文，VPS 清理超过 24 小时的 orphan workspace，均可幂等重跑。
- **运维与安全**：控制面提供不含用户内容的 queue/lease/status/cost/failure/TTL 指标；VPS 定时输出 health + 磁盘，测试账号与生产统计隔离。生产安全冒烟覆盖 JWT/Worker Token/IDOR/RLS/MIME/幂等冲突，过期 parked Run 自动取消，Worker 重启后的未知上游结果不盲重放。
- **eval**：`node --test` 当前跑 144 个用例，全过；生产双 Worker 并发 claim 专项确认同一 Run 只有一个租约、`attempt_count=1`。

## 当前范围边界

- ✅ 云端 Worker consumer、checkpoint/tool-ledger、workspace/artifact 与生产组合入口已部署 VPS，并通过真实 Supabase/DeepSeek/Seedream E2E
- ✅ Supabase Agent 控制面与 controlled-image-edit `0021`/Edge 已上线
- ✅ 真实 **DeepSeek 文本** `ModelBackend` adapter + 方舟 Seedream `generate_image` + 用户反馈后的方舟 `understand_image` / revision plan
- ✅ 桌面 Agent Run 入口 / 审批 / 反馈 / 产物下载与会话组图入库首版，最后一轮桌面交互已人工通过 —— A4
- ✅ Agent Run 文本 usage/ledger、服务端费率/预算复核、终态原子结算、TTL/orphan 清理、账单 marker、原子单用户/全站容量闸与每日成本预留 —— A5
- ✅ 安全冒烟、Cloud 生图/理解真实回归、隐私文案、Worker 重启故障注入与 VPS 监控/容器约束；Codex Agent 真机已通过并按实测结论暂时与正式 Agent 互斥 —— A6/A7 当前范围完成（Dreamina Agent CLI 真机 E2E 已明确跳过）
- ❌ OpenClaw / Claude Code / MCP / shell / 用户 Skill / 多 Agent —— 永不做（计划 §1.2 / §7.1）
- ❌ 视觉设定读取或上传图片 —— 永不做（计划 §8.2 三条不可变边界）

## 如何运行

零运行时依赖；Node v24 内置 TypeScript 类型剥离，tsc 取自根 workspace。

```bash
# 类型校验
node node_modules/typescript/bin/tsc -p apps/agent-worker/tsconfig.json

# 跑全部 eval（从包目录内）
cd apps/agent-worker && node --test "src/**/*.test.ts"

# A3-T7：真实 DeepSeek 文本规划 + Kernel 指标报告（不看图、不生图）
npm run eval:controlled-image-edit

# 仅运行 Agent consumer（需配置 AGENT_*、DEEPSEEK_*、ARK_*）
pnpm --dir apps/agent-worker worker:agent
```

或：`pnpm --filter @bowerbird/agent-worker typecheck` / `test`（需先 `pnpm install` 把包装入 workspace；
当前为零依赖，未跑 install 也能用上面的直连命令）。

## eval 覆盖对照

| 计划项 | 用例 |
|---|---|
| A0-T6 契约 + 可替换 backend | smoke（ModelBackend 形状）+ FakeModel 驱动全流程 |
| A0-T7 阶段约束（5 类非法动作模型外被拒） | 对抗 1/1b（跳过审批）/ 2（重复生图）/ 3（改预算）/ 4（shell）/ 5（跨 Run 读）+ 端到端 shell 注入 |
| 智能精修四能力 | 结构化意图 / 参考图职责 / 分维度评分 / 至多精修一次（4a happy + 4b 封顶） |
| V0-T3 caption fixture（5 场景） | 单一方向 / 多个方向 / 内容主题误判 / 反推缺失 / 超大数据集 |

## 已知配置与后续项

历史前置清单见 [A1-PREREQUISITES.md](A1-PREREQUISITES.md)；当前状态：
- DeepSeek 文本回合真实 tool-calling + usage 已通过；`deepseek-v4-flash` 默认 thinking 会拒绝 `tool_choice=required`，adapter 已显式发送 `thinking.type=disabled` 并通过真实探针、A3-T7 与 VPS 部署验证
- Vision + Seedream 已完成 VPS 真实出站与同 Run 修订 E2E；区域/时延/并发仍需发布级压测
- `credit_hold` 预算预授权、Agent 原子终态结算与 DeepSeek 文本回合可信 usage/ledger 已统一
- FeaturePolicy 正式字段与首版预算选项已统一上线；对外定价归属仍待运营确认
- VPS 单容器三循环、容器资源/PID/日志约束和无内容健康监控已部署；数据库容量门槛与 Worker 重启租约恢复已验收

> M0 的费率采用「每动作固定积分」降级规则（计划 §9.2），上游 token 不可靠时的可审计兜底；
> 真实 token-based 费率待 A0-T1 确定后由 `service_costs` + Edge 纯函数实现。

## 文件结构

```
src/
  contracts/      v1 契约（model/skill/snapshot/tools/events/clarification/preference/visual-profile/run）
  kernel/         门控 + 动态 Runner + 可恢复 RunEngine + durable tool dispatcher
  cloud-agent/    poll/claim/heartbeat consumer 与 controlled-image-edit Run processor
  control-plane/  Worker Token 控制面、对象/checkpoint/tool ledger 客户端
  fakes/          FakeModel / FakeTools（确定性）
  providers/      DeepSeek ModelBackend（文本回合）+ Ark Seedream 受控步骤执行器
  local/          开发态 checkpoint step runner + stdin/stdout CLI
  skills/
    smart-refinement/        M0 可运行 Skill（manifest.ts + skill.json）
    series-creative-director/ 首个 Skill 冻结（skill.json + eval-cases.json，eval 在 A3）
  visual/          evidence/scope/extract/batch（纯函数，不读图）
  fixtures/        visual-captions.ts（5 场景）+ DeepSeek 脱敏 spike 结果
  spikes/          真实 DeepSeek 两回合 tool-calling 验证（只输出安全摘要）
  eval/            runner.ts + *.eval.test.ts（smoke/smart-refinement/adversarial/visual-fixtures）
  types/           node-ambient.d.ts（零依赖类型声明）
```
