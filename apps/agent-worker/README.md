# @bowerbird/agent-worker — Bowerbird Agent Runtime（M0：A0 + V0）

> 状态：**M0 已完成（契约冻结 + FakeModel + 离线 fixture + eval，20 测试全过）**。
> 本包**不含** worker 运行时、Supabase 迁移/Edge Function、真实 model/tool adapter（DeepSeek 文本 + 方舟出图/看图）、桌面 UI。
> 依据：[dev-doc/AGENT-RUNTIME-PLAN.md](../../../dev-doc/AGENT-RUNTIME-PLAN.md) §A0 / §V0。

## M0 做了什么

- **冻结 9 个 v1 契约**（TypeScript 类型）：`ModelBackend` / `SkillManifest` / `RunSnapshot` /
  `ToolCall` / `ClarificationProposal` / `IntentPatch` / `VisualEvidenceCard` /
  `VisualProfileDraft` / `VisualProfileCapsule`，外加 `PreferenceCapsule`、events、run。
  - 见 [src/contracts/](src/contracts/)。
- **纯函数 Kernel 门控**（无 I/O）：`PhaseMachine` / `PolicyEngine`（全局工具白名单 + 跨 Run 守卫 +
  审批前置 + 次数/预算上限）/ `ToolLedger`（稳定 `call_id` + `args_hash` 幂等）/ `Budget`。
  - 见 [src/kernel/](src/kernel/)。这是「非法动作在模型外被拒」的确定性实现。
- **FakeModel + FakeTools + eval runner**：确定性、可脚本化；runner 把三者串成可观测的 in-memory Run。
  - 见 [src/fakes/](src/fakes/)、[src/eval/runner.ts](src/eval/runner.ts)。
- **智能精修 Skill**（M0 可运行目标）：结构化意图 → 参考图职责 → 分维度评分 → 必要时精修一次。
  - [src/skills/smart-refinement/](src/skills/smart-refinement/)。
- **系列创作导演 Skill**：manifest + 18 个 eval case **冻结**（契约级，eval 执行在 A3）。
  - [src/skills/series-creative-director/](src/skills/series-creative-director/)。
- **视觉设定 V0**：caption → `VisualEvidenceCard` 规范化、`source_scope_hash`、确定性 map-reduce 提炼、
  token 预算分批；5 个纯 caption fixture。**不读取/上传图片，只用反推结构化数据。**
  - 见 [src/visual/](src/visual/)、[src/fixtures/visual-captions.ts](src/fixtures/visual-captions.ts)。
- **eval**：`node --test` 跑 20 个用例（smoke 1 + 智能精修 7 + 对抗 7 + 视觉 6，全过）。

## M0 明确不做（边界）

- ❌ Worker 运行时（poll/claim/heartbeat/checkpoint-to-cloud）—— A2
- ❌ Supabase 迁移 / Edge Function / RPC —— A1（清单见 [A1-PREREQUISITES.md](A1-PREREQUISITES.md)）
- ❌ 真实 **DeepSeek 文本** `ModelBackend` adapter + 方舟 `understand_image`/`generate_image` 实现 —— A3（DeepSeek 只做文本回合；出图/看图仍方舟，因 DeepSeek 无视觉）
- ❌ 桌面 Agent Run UI / 审批 UI / 产物下载入库 —— A4
- ❌ 真实积分扣费 / 对账 / TTL 清理 —— A5
- ❌ OpenClaw / Claude Code / MCP / shell / 用户 Skill / 多 Agent —— 永不做（计划 §1.2 / §7.1）
- ❌ 视觉设定读取或上传图片 —— 永不做（计划 §8.2 三条不可变边界）

## 如何运行

零运行时依赖；Node v24 内置 TypeScript 类型剥离，tsc 取自根 workspace。

```bash
# 类型校验
node node_modules/typescript/bin/tsc -p apps/agent-worker/tsconfig.json

# 跑全部 eval（从包目录内）
cd apps/agent-worker && node --test "src/**/*.test.ts"
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

## 仍未确认的前置项（不阻塞 M0，但阻塞 A1+ 真实联调）

见 [A1-PREREQUISITES.md](A1-PREREQUISITES.md)「未确认前置项」一节：
- DeepSeek 文本回合（`deepseek-chat`，支持 tool calling；⚠️ `deepseek-reasoner` 不可用）稳定性 + usage 返回（A0-T1，**已选定 DeepSeek，真实 spike 待做**）
- Vision + Seedream 从 VPS 出站的区域/时延/并发（A0-T2，**未做真实 spike**）
- `credit_hold` 承载预算上限的最小迁移（A0-T3，**仅列清单未实现**）
- 预算档位 / 定价 / FeaturePolicy 正式字段（A0-T5，待运营确认）
- VPS 规格 / 部署方式（A7）

> M0 的费率采用「每动作固定积分」降级规则（计划 §9.2），上游 token 不可靠时的可审计兜底；
> 真实 token-based 费率待 A0-T1 确定后由 `service_costs` + Edge 纯函数实现。

## 文件结构

```
src/
  contracts/      v1 契约（model/skill/snapshot/tools/events/clarification/preference/visual-profile/run）
  kernel/         纯函数门控（phase-machine/policy-engine/tool-ledger/budget）
  fakes/          FakeModel / FakeTools（确定性）
  skills/
    smart-refinement/        M0 可运行 Skill（manifest.ts + skill.json）
    series-creative-director/ 首个 Skill 冻结（skill.json + eval-cases.json，eval 在 A3）
  visual/          evidence/scope/extract/batch（纯函数，不读图）
  fixtures/        visual-captions.ts（5 场景）
  eval/            runner.ts + *.eval.test.ts（smoke/smart-refinement/adversarial/visual-fixtures）
  types/           node-ambient.d.ts（零依赖类型声明）
```
