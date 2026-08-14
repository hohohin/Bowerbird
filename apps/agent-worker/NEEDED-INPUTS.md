# A1 启动前 · 待你确认/提供的信息

> M0 已完成（契约 + FakeModel + eval，20 测试全过）。开 A1（Supabase 控制面）前，
> 下面这些信息需要**你本人**给。直接在本文件的「✍️ 填这里」处编辑即可；密钥类不要写进本文件。
> 详细技术清单见 [A1-PREREQUISITES.md](A1-PREREQUISITES.md)；本文件只列「要你填的」。

## 一览

| # | 待填项 | 阻塞 A1? | 状态 |
|---|---|---|---|
| 1 | DeepSeek 文本模型 | ✅ 是 | ✅ 已定（deepseek-chat） |
| 2 | VPS 规格 + 部署方式 | 🔶 A1 可先用 mock worker，A7 真机必需 | ✅ 已填 |
| 3 | 预算档位 + 定价归属 | 🔶 POC 可用 allowlist，正式发布前定 | ✅ 已填 |
| 4 | TTL 默认值确认 | ❌ 不阻塞，给个确认就行 | ✅ 已确认 |
| 5 | DeepSeek key（文本）+ 方舟 key（出图/看图） | ✅ A3 联调必需 | 🔶 方舟 key 复用现有，DeepSeek 待你提供 |
| 6 | POC 测试账号 allowlist | ❌ 不阻塞，给 1–3 个测试账号 | ✅ 已填 |

---

## ✅ 已确认决策（2026-08-14）

- **文本回合**：DeepSeek `deepseek-chat`（不看图）；出图方舟 Seedream、看图方舟 vision（方舟 key 复用现有，不可省）。
- **首个实现 Skill**：**smart-refinement（智能精修）**；series-director manifest 已冻结、暂不开发。
- **预算**：smart-refinement 按 token 换算，**单次上限 ~15 分**；free/pro/studio **3 档都可用**；POC allowlist `admin@bowerbird.cn`。
- **TTL**：输入/中间 24h、最终产物 7d。
- **VPS**：腾讯云轻量云 Ubuntu 24.04 / 2vCPU / 2GiB / 50GiB；**加 2G swap + Worker 并发上限 1–2**；部署 **SSH + Docker**。
- **唯一待你提供**：**DeepSeek API key**（填 Supabase Edge secret + VPS Worker secret `DEEPSEEK_API_KEY`，不进仓库/聊天）。

---

## 1. DeepSeek 文本模型（已定）

**为什么**：Agent 的「思考回合」（分析素材、出计划、评分、选下一动作）走 DeepSeek API——国内直连、兼容 OpenAI 格式、成本低。
**已定**：用 **`deepseek-chat`**（DeepSeek-V3，支持 function calling / JSON mode）。⚠️ **不要用 `deepseek-reasoner`（R1）**——它是推理模型，不支持 tool calling，Agent loop 跑不起来。

> ✍️ 确认 — 模型：`deepseek-chat`（接受 / 改成 ___）
> ✍️ 填这里 — API base：默认 `https://api.deepseek.com/v1`（接受 / 自定义）
> ✍️ 填这里 — DeepSeek API key 是否就绪：（有，填进 secret / 没有，需我给申请步骤）

**填到哪**：Worker 镜像环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL`；Edge secret 同步。
**关键约束（重要）**：DeepSeek **不接受 image_url（无视觉能力）**——`understand_image`（看图反推）必须仍走**方舟豆包 vision**，出图 `generate_image` 走**方舟 Seedream**。所以方舟 key 不能省。A0-T1 spike 用 `deepseek-chat` 验证「模型发工具动作 → 假工具结果 → 模型继续」+ tool calling 稳定性 + usage 返回。

---

## 2. VPS 规格 + 部署方式

**为什么**：Agent loop 跑在 VPS 常驻 Worker 里（不在 Edge Function，因有审批等待/长任务）。A1 用 mock worker 脚本就能验状态机，但 A7 真机必须有 VPS。
**填什么**：你是否已有/愿意开一台 VPS；系统/CPU/RAM/磁盘；怎么登录部署。

> ✍️ 填这里 — 是否已有 VPS：有
> ✍️ 填这里 — 系统 / CPU / RAM / 磁盘：Ubuntu 24.04 / 2vCPU / 2GiB / 50GiB
> ✍️ 填这里 — 部署方式：看你建议，目前vps是在腾讯云的轻量云购买的

**填到哪**：告诉我即可，我据此写 Worker 的 Dockerfile + 部署脚本。Worker **不需要域名/公网入站端口**，只要能出站到 Supabase + 方舟。

---

## 3. 预算档位 + 定价归属

**为什么**：每个 Agent Run 创建时预扣一个「最大预算上限」（hold），需服务端定义档位。正式归哪个档（免费/Pro/Studio）也要先定。
**M0 临时占位**：smart-refinement = 12 分、series-director = 24 分（[kernel/budget.ts](src/kernel/budget.ts)）。

> ✍️ 填这里 — smart-refinement 预算上限：根据使用的具体token进行换算
> ✍️ 填这里 — series-director 预算上限：series-director暂不开发
> ✍️ 填这里 — 定价归属：3个档位都可用

**填到哪**：你定了后，我落进 `service_costs` 迁移 + [定价方案](../../dev-doc/Bowerbird定价方案v2-订阅积分制.md) + FeaturePolicy。

---

## 4. TTL 默认值确认

**为什么**：云端临时数据（你为该次 Run 选的输入、中间状态、产物）的留存上限。

> ✍️ 填这里 — 输入/中间状态 24h、最终产物 7d：接受

**填到哪**：我据此写清理任务。不阻塞编码。

---

## 5. API key（DeepSeek 文本 + 方舟出图/看图）—— 填 secret，不填本文件

**不要写进本文件/聊天/仓库**。需要**两把**（provider 分工，见 #1）：
- **DeepSeek API key**（文本回合）→ Worker secret `DEEPSEEK_API_KEY` + Edge secret。
- **方舟 API key**（出图 Seedream + 看图 vision，**DeepSeek 无视觉不能替代**）→ 复用现有 `ARK_API_KEY`（已在 Supabase secret），Worker secret 部署时也设一份。
- 加密位置见 [apps/cloud/DEPLOY.md](../cloud/DEPLOY.md) 与现有 `ARK_API_KEY` 同处。

> ✍️ 填这里 — DeepSeek key 是否就绪：（是 / 否）
> ✍️ 填这里 — 方舟 key 是否复用现有 `ARK_API_KEY`：是（你已填「换成 deepseek 的 api」，确认方舟仍保留用于出图/看图）

---

## 6. POC 测试账号 allowlist（可选）

**为什么**：定价/备案未定前，用 allowlist 小流量验证，不公开。

> ✍️ 填这里 — 1–3 个测试账号邮箱（可留空）：admin@bowerbird.cn

---

## 不需要你填（我来做，列出让你心里有数）

- **U3 credit_hold 迁移**：现有 hold/confirm/rollback（0003/0004/0010）够用，A1 直接复用 + 加 Agent 表。
- **FeaturePolicy 代码字段**：`can_use_agent_runs` / `max_parallel_agent_runs` / `allowed_agent_skills` / `agent_budget_options`，我写进 entitlement。
- **7 张 Agent 表 + 12 个 RPC + 2 个 Edge Function**：见 [A1-PREREQUISITES.md](A1-PREREQUISITES.md) §1–§2，全是编码项。
- **U7 真实支付**：已暂停（备案/商户资质前置），不阻塞 Agent Run MVP（A0–A5）。
