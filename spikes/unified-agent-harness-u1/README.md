# U1：DSH + DeepSeek 隔离 Spike

本目录只验证 `UNIFIED-AGENT-HARNESS-PLAN.md` 的 U1，不接生产入口、Supabase、积分、FeaturePolicy 或 VPS。

## 固定边界

- DSH、ACP、DeepSeek adapter 与 base bundle 均精确钉死为 `0.1.1-rc.2`。
- `DSH_HOME` 固定为本目录；session、attachment、spill 和凭据文件不进入版本控制。
- 子进程只接收操作系统运行所需变量、`DSH_HOME`、关闭遥测的开关，以及显式 smoke 时唯一允许的 `DEEPSEEK_API_KEY` / 可选 `DEEPSEEK_BASE_URL`。
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
pnpm run smoke:vision
pnpm run smoke:adapter
```

`release:check` 只读查询 npm registry；出现新候选只触发兼容性套件重跑，不代表兼容性或生产上线已通过。`dump-config` 只组合配置，不启动 ACP、不调用 DeepSeek。`acp:probe` 会启动无 provider secret 的 ACP 子进程，实测握手和生命周期方法；`pnpm test` 会复核发布物、危险插件禁用状态、子进程环境白名单，以及当前 ACP 协议能力边界。三个 smoke 会产生少量真实 API 消耗，脚本本身不读取 `.env`，也不打印 key；`smoke:adapter` 额外验证 Worker 侧 `DshAcpHarnessAdapter` 可通过真实 ACP 子进程从 Bowerbird checkpoint 重建 fresh session。

调查结论与继续/止损判断见 [`COMPATIBILITY.md`](COMPATIBILITY.md)。
