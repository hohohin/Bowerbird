# U1 兼容性报告

> 状态：**U1 技术入口通过；允许进入 U2 的隔离 Adapter / Tool Gateway 开发，不授权替换生产 Runtime**
> 日期：2026-08-28
> 范围：npm 发布物、本地隔离 Profile，以及经用户授权复用 Bowerbird Cloud DeepSeek key 的最小真实 API smoke；未修改生产、数据库、FeaturePolicy 或 VPS。

## 版本快照

| 项 | 精确版本 | npm dist-tag 观察 | 许可证 |
|---|---|---|---|
| `@deepseek-ai/dsh` | `0.1.1-rc.2` | `latest` / `next` 均指向该版本 | MIT |
| `@deepseek-ai/dsh-base` | `0.1.1-rc.2` | 随 CLI 同代 | MIT |
| `@deepseek-ai/dsh-acp` | `0.1.1-rc.2` | 必须显式取 `next`；`latest` 仍是 `0.0.1-rc.1` | MIT |
| `@deepseek-ai/dsh-llm-deepseek` | `0.1.1-rc.2` | 必须显式取 `next`；`latest` 仍是 `0.0.1-rc.1` | MIT |
| `@deepseek-ai/dsh-tools` | `0.1.1-rc.2` | 随 base 同代 | MIT |

运行时：Node `24.11.0`、pnpm `11.10.0`、Windows x64。最终解析版本与完整 integrity 以本目录 `pnpm-lock.yaml` 为准。正常使用路径是 npm/npx Profile，不需要克隆 DSH 仓库；GitHub `master` 只用于核对未来能力，不能替代已发布包实测。

## 已确认事实

1. `dsh-base` 的安装依赖包含 shell、文件、Web、Skill、子 Agent 与 workflow 插件。包被安装不等于能力已授权；生产候选必须审计**最终组合配置**，不能只审计 `package.json`。
2. 本 Spike 的文本 Profile 对上述高危行逐项 `disabled: true`，同时关闭 HMR、遥测、`.env` 凭据扫描、pi-ai 多 provider 与 session 全文索引，只额外注册一个无副作用、确定性证明用测试工具。
3. DSH 子进程默认拿不到 Supabase、Worker、方舟、DeepSeek 或其他业务 secret。真实 smoke 需 `BOWERBIRD_U1_ALLOW_NETWORK=1` 与 key 两道显式门；只向子进程放行 DeepSeek key 和可选 base URL。
4. `@deepseek-ai/dsh-llm-deepseek@0.1.1-rc.2` 明确不映射 `tool_choice`。Bowerbird 不能假设现有 Kernel 的 `required` 语义被 DSH 保留，U2 必须继续使用 scoped tool schema、结果校验和有界纠正回合。

## 真实 API 结果

经用户明确授权，smoke 从本机 gitignored `apps/cloud/.env` 一次性读取现有 Bowerbird Cloud DeepSeek key；值不打印、不落专项配置、不传给离线命令。第一次运行发现该 `.env` 行带空格后的行尾中文注释，测试加载器按标准 dotenv 行尾注释规则剥离后成功，源文件未改动。

| 路径 | 结果 |
|---|---|
| 文本 ACP | `initialize` / `session/new` 成功，协议版本 1 |
| 真实 tool loop | 同一 session 连续两轮均调用唯一 `u1_record_observation`；每轮返回由隐藏前缀 + nonce 计算的不同 SHA-256 证明，最终 committed answer 命中对应证明，均以 `end_turn` 收口 |
| 在途取消 | 第三轮请求发出后 150ms 调用 `session/cancel`，prompt 以 `cancelled` 收口 |
| Thinking | Profile 显式 `thinking: disabled`、`reasoningEffort: off`；真实请求正常 |
| Vision base64 | `deepseek-v4-flash-vision-exp` 正确声明 image capability；11,467-byte PNG 经 ACP inline base64 识别为蓝色鸟，`end_turn` |
| Vision 多轮历史 | 第二轮不再附图，仍能从同一 session 回答上一张图的动物，`end_turn` |
| U2 Adapter 重建 | 实际 ACP SDK + DSH 子进程经窄 `DshAcpPort` 创建全新 session；Bowerbird checkpoint 中既有产物 `artifact-existing` 被正确恢复，`end_turn` |
| 错误输出 | 三条 smoke 的 stderr 均为空；脚本仍对可能包含 key 的 stderr 做替换脱敏 |

16×16 图标的首次视觉试验把鸟误判为猫但识别出蓝色，说明低分辨率 fixture 有语义歧义；换为同仓库 128×128 图标后通过。该失败保留为质量风险证据，不把“图片协议可达”混同于“任意尺寸识别可靠”。

## ACP 发布物边界及恢复决策

`@deepseek-ai/dsh-acp@0.1.1-rc.2` 的实际发布物仍然只支持 fresh session：

- `session/list`、`session/resume`、`session/close` 返回 `-32601 Method not found`；
- 连接断开会释放该连接拥有的 session；
- ACP wire 只输出 committed answer，usage、工具生命周期和计划不在 wire 上。

这是真实兼容性缺口，但不再作为“等待新版才能继续”的总停工条件。原因是专项既定边界要求 Bowerbird Run/checkpoint/Tool Ledger 才是业务事实源：rc.2 阶段每个运行进程只使用 connection-scoped fresh session；进程退出即关闭；Worker/DSH 崩溃后由 Bowerbird 的结构化 checkpoint、必要对话摘要和已完成工具结果重建新 session，绝不依赖 DSH session 恢复有成本副作用。U2 必须把这条重建路径做成可测 Adapter 合同；若做不到，再触发恢复止损。

## 离线验证

DeepSeek adapter fixture 确认 reasoning/text/tool-call/usage 可被 adapter 翻译；`tool_choice` 未进入实际请求；非严格 tool arguments 被原样输出，必须继续由 Bowerbird schema/Policy fail closed；损坏 SSE JSON 被归一为 `MALFORMED_RESPONSE`。

`pnpm test` 为 **9/9**；组合配置审计检查 32 个禁用能力行通过，peer dependency 检查通过。`pnpm run acp:probe` 单独、无 provider secret 地复测 initialize/new/cancel 与缺失生命周期方法。`pnpm run release:check` 只在 npm 候选变化时提示重跑矩阵，不再把版本发布本身当作继续开发的门槛。

## 最终判断

- 已完成：精确钉版与 lockfile、最小 Profile、组合配置审计、secret 隔离、ACP 生命周期实测、adapter 结构化/usage/错误 fixture、真实双轮文本 tool loop、真实 Vision base64 与同 session 多轮历史。
- 允许继续：U2 的隔离 `HarnessAdapter`、connection-scoped session 管理、Bowerbird checkpoint 重建合同和受控 Tool Gateway；真实 Adapter 重建 smoke 已通过。
- 仍未授权：生产 FeaturePolicy、VPS 部署、生产流量切换、用 DSH session 作为业务恢复权威。
- U1 后续质量项：Files API 路线（若实际需要）以及“Vision 主模型 vs Pro + understand tool”的真实案例 A/B；它们影响模型/传图方案选择，不阻塞 U2 控制面接口开发。
- 持续止损：若 fresh-session 重建不能保持幂等、必须长期维护 DSH core patch、或必需 action 在有界纠正后仍频繁退化为自由文本，则停止采用。
