# U1/U2：DSH + DeepSeek 隔离验证

本目录源于 `UNIFIED-AGENT-HARNESS-PLAN.md` 的 U1 Spike，现同时承载 U2 Harness 的隔离验证；不接生产入口、FeaturePolicy 或 VPS，不代表生产上线。

## 固定边界

- DSH、ACP、DeepSeek adapter 与 base bundle 均精确钉死为 `0.1.1-rc.2`。
- `DSH_HOME` 固定为本目录；session、attachment、spill 和凭据文件不进入版本控制。
- U1 独立 smoke 的子进程只接收操作系统运行所需变量、`DSH_HOME`、关闭遥测的开关，以及显式 smoke 时唯一允许的 `DEEPSEEK_API_KEY` / 可选 `DEEPSEEK_BASE_URL`；U2 正式 processor 改由父进程计量代理持有真实 key，子进程只得到短期 capability 与 loopback base URL。
- 默认命令不联网调用模型。真实 API smoke 必须显式设置 `BOWERBIRD_U1_ALLOW_NETWORK=1`，并自行提供 `DEEPSEEK_API_KEY`。
- Profile 只注册一个无副作用的 `u1_record_observation` 测试工具，用不可猜证明串确认真实 tool loop；它不是 Bowerbird 业务工具，U2 才定义 Tool Gateway。

## 命令

在 `profiles/bowerbird-u1` 目录执行：

```powershell
pnpm install --ignore-workspace --ignore-scripts
pnpm run release:check
pnpm run dump-config
pnpm run acp:probe
pnpm test
# 另行显式注入 DeepSeek 环境变量和 BOWERBIRD_U1_ALLOW_NETWORK=1 后：
pnpm run smoke:network
pnpm run smoke:adapter
# 仅在仓库根目录显式授权一次真实正式纵切时：
node --env-file=apps/cloud/.env spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/formal-vision-smoke.mjs --allow-real-vision
# U3 真实类型产品规划（还需显式设置 BOWERBIRD_U1_ALLOW_NETWORK=1）：
$env:BOWERBIRD_U1_ALLOW_NETWORK = "1"
node --env-file=apps/cloud/.env spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/u3-product-planning-smoke.mjs --allow-real-u3-planning
node --env-file=apps/cloud/.env spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/u3-product-html-execution-smoke.mjs --allow-real-u3-html-execution
# 旧单-compose 基线（另一个付费闸门）：
node --env-file=apps/cloud/.env spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/u3-legacy-html-baseline-smoke.mjs --allow-real-u3-legacy-baseline
# 本地无 provider 费用的 A/B 构建：
pnpm --dir spikes/unified-agent-harness-u1/profiles/bowerbird-u1 run build:u3-blind-comparison -- --baseline-dir=<failed-baseline-run-dir> --candidate-report=<u3-report.json> --output-dir=<blind-output-dir>
Remove-Item Env:BOWERBIRD_U1_ALLOW_NETWORK
```

`release:check` 只读查询 npm registry；出现新候选只触发兼容性套件重跑，不代表兼容性或生产上线已通过。`dump-config` 只组合配置，不启动 ACP、不调用 DeepSeek。`acp:probe` 会启动无 provider secret 的 ACP 子进程，实测握手和生命周期方法；`pnpm test` 会复核发布物、危险插件禁用状态、子进程环境白名单，以及当前 ACP 协议能力边界。`smoke:network`、`smoke:adapter` 与正式纵切会产生真实 API 消耗；脚本不打印 key。`smoke:adapter` 额外验证 Worker 侧 `DshAcpHarnessAdapter` 可通过真实 ACP 子进程从 Bowerbird checkpoint 重建 fresh session。

`formal-vision-smoke.mjs` 是 U2 的高成本显式闸门：缺少 `--allow-real-vision` 会立即拒绝。它复用正式 `UnifiedPlanningRunProcessor`、真实 DSH/DeepSeek 文本回合与 Bowerbird 现有火山方舟 Vision，以仓库 fixture 验证 `list_run_assets → understand_asset → submit_plan → end_turn`、三个父进程代理文本模型 usage、一次方舟 Vision usage、对应 diagnostic artifacts、durable complete、真实 DeepSeek/方舟 key 均不进入子进程，以及审批停车。三个文本回合依次用于列出素材、接收方舟视觉事实、提交计划。DeepSeek 代理明确拒绝图片输入，所有视觉工作只经 `understand_asset` 调用方舟；旧 DeepSeek Vision 配置与 smoke 已退出现役 Profile。完整 SSE 在父进程内按 512 KiB 上限校验，成功结果以 gzip+base64 和原始字节数/hash 存入不超过 64 KiB 的私有 diagnostic artifact，恢复时有界解压并重新验证 SSE/usage。成功只输出脱敏布尔/计数摘要；失败只输出 durable `safeErrorCode`、阶段计数和成功调用数，不打印 prompt、模型正文、provider 正文或 secret，也不部署任何生产组件。DSH 启动会自愈 Profile 的 pnpm 软链接，因此该脚本需要 Profile 目录可写；部署候选使用每进程临时 `DSH_HOME` 维持只读根文件系统。该真实 smoke 可能产生 DeepSeek 与方舟费用，失败后不得自动重跑。

`u3-product-planning-smoke.mjs` 是 U3 真实类型计划质量闸门，必须同时存在 `--allow-real-u3-planning` 与 `BOWERBIRD_U1_ALLOW_NETWORK=1`。它使用仓库内置非敏感样例 `preset-01.webp`（产品）和 `preset-11.webp`（仅排版风格），分别以 `general`、`style` 走一次现有火山方舟 Vision，再由 DSH/DeepSeek 提交结构化计划 v2。同一素材所有 focus 共用一个 durable slot：同参数重放复用，换 focus 在方舟调用前按 args drift 拒绝，避免重复视觉费用。脚本拒绝把风格图文字当作产品文案，要求产品/风格职责、信息架构、不可核验事实的 `not_needed` 决策、视觉档案精确绑定，以及固定的 `compose_html → render_html → inspect_artifact → finalize_output` 批准后工具形状；本次只停车到审批，不生成、不渲染、不部署。输出保留完整计划供人工核对，并用与 Edge 相同的 Cost Policy v1 估算器、版本化 smoke 费率计算权威预算；模型不能提交价格。为覆盖两次 Vision 和最终提交，test-only ACP 整体 prompt timeout 为有界 180 秒；生产默认仍为 90 秒。该 smoke 会产生 3–6 个 DeepSeek 文本回合和精确两次方舟 Vision 费用，失败后不得自动重跑。

`u3-product-html-execution-smoke.mjs` 只执行已通过人工核对的 U3 v2 计划形状，不重跑规划费用。它必须同时存在 `--allow-real-u3-html-execution` 与 `BOWERBIRD_U1_ALLOW_NETWORK=1`，经正式批准后 processor、独立 HTML execution Profile 和父进程 Tool Gateway 执行真实 `compose_html → render_html → inspect_artifact → finalize_output`：compose 使用真实 DeepSeek，render 复用现有 sanitizer/断网资源闭集/整页切片 HTTP wire（本机可用 `BOWERBIRD_E2E_EXECUTABLE` 指定 Chromium），inspect 精确调用一次真实方舟 Vision，finalize 只能选择父进程派生的可见产物。默认产物按 Run 隔离写入 `results/u3-html-execution/<run-id>/`，失败也保存无 secret 的调用/usage 摘要；脚本不部署生产、不自动接受结果，也不会在检查后擅自修图。

`u3-legacy-html-baseline-smoke.mjs` 复用旧 `bowerbird-html-layout-render@0.1.0` 的单 `compose_html_document` 模型阶段和一次现有 renderer，不启动 DSH、Vision 或修订循环。它会产生真实 DeepSeek 费用，必须同时存在 `--allow-real-u3-legacy-baseline` 与 `BOWERBIRD_U1_ALLOW_NETWORK=1`；renderer 拒绝后该 Run 按旧契约失败，不得原地自动重试。`u3-build-blind-comparison.mjs` 不访问任何 provider；它只允许对已生成的基线 HTML 删除 CSS 注释、重跑同一 sanitizer/本地 renderer，再把视觉等价基线与 U3 成品随机编为 A/B。公开报告保存映射 commitment，揭盲前的映射单独保存；视觉救援样本仅用于盲评，不会把失败的旧 Run 改记为成功。

调查结论与继续/止损判断见 [`COMPATIBILITY.md`](COMPATIBILITY.md)。

## 真实 502 的手动定位（会产生 API 用量）

以下命令均从仓库根目录运行，脚本读取 `apps/cloud/.env`，不会打印 key。每次命令结束后先查看结果，不要连续重跑。

第一步只做一个真实 DeepSeek 文本回合，绕过父进程计量代理和方舟 Vision，用于判断 key、模型、DSH adapter 与 DeepSeek 基础链路是否正常：

```powershell
$env:BOWERBIRD_U1_ALLOW_NETWORK = "1"
node --env-file=apps/cloud/.env spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/adapter-smoke.mjs
Remove-Item Env:BOWERBIRD_U1_ALLOW_NETWORK
```

成功标志是 JSON 中 `rebuiltFromCheckpoint=true`、`completedArtifactObserved=true`、`stopReason="end_turn"`。若这一步也报 DeepSeek HTTP 502，问题在父进程代理之外，应先检查 DeepSeek 服务状态、key/余额、区域出口或稍后再试；不要继续跑方舟。

若第一步成功，可选第二步验证 DSH 原生工具循环；它会发起两个完整回合和一个很快取消的回合，费用高于第一步：

```powershell
$env:BOWERBIRD_U1_ALLOW_NETWORK = "1"
node --env-file=apps/cloud/.env spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/network-smoke.mjs
Remove-Item Env:BOWERBIRD_U1_ALLOW_NETWORK
```

成功标志是两个 `proofObserved=true` 且 `inFlightCancelStopReason="cancelled"`。第一、二步通过而正式 smoke 仍为 502，范围即可收敛到父进程计量代理对 DSH 流式响应的校验，或正式 planning 请求与普通请求的差异。

仅在前两步结论明确且接受再次产生 DeepSeek + 方舟费用时，才手动运行完整计量纵切：

```powershell
node --env-file=apps/cloud/.env spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/formal-vision-smoke.mjs --allow-real-vision
```

完整成功时会输出 `ok=true`、`modelUsage=3`、`modelDiagnostics=3`、`visionUsage=1`、`durableSucceededCalls=4` 及两个 secret 留在父进程的布尔项。失败时会出现 `formal_vision_smoke_failed:{...}`；只需回传该 JSON 摘要即可，不要附上 `.env` 内容。`failures[].safeErrorCode` 是下一步定位依据，`state` 按 call id 幂等计数，可判断失败发生在第几个 DeepSeek 文本回合或方舟 Vision 前后。旧 `deepseek_response_invalid` 同时覆盖空正文和超过 60 KiB 两种情况；新版已拆为 `deepseek_response_empty` / `deepseek_response_too_large`，并把可接收的完整 SSE 上限提高到 512 KiB，因此下一次结果可以直接验证这次修复是否命中真实根因。
