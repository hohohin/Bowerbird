# Unified Agent Harness test-only 运维 Runbook

适用范围：`bowerbird-controlled-image-edit` 的 `legacy_kernel` / `dsh` 双 runtime，以及尚未公开的 `bowerbird-unified-agent`。本 Runbook 不授权扩大 FeaturePolicy、公开 DSH、修改预算/计费或部署小红书发布能力。

## 1. 每次候选必须冻结的身份

- git commit 或明确的 dirty worktree diff；Worker 镜像 digest 与大小；基础镜像 digest。
- `spikes/unified-agent-harness-u1/profiles/bowerbird-u1/package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` SHA-256，Node/pnpm 版本及所有 DSH 包的精确版本；workspace settings 属于依赖解析权威输入，必须与 lockfile 一起进入构建白名单和证据。
- Skill id/version/instruction hash、tool schema 版本、migration 上限、`agent-run` / `agent-worker` Edge 版本。
- 部署前旧镜像 digest/rollback tag、旧 Edge 源码归档、排除 secret 的 Compose/源码归档；env 备份只能留在服务器 0600 路径，不进入仓库或报告。

缺少任一身份时不得把候选称为可回滚发布。

## 2. 本地升级门

1. 先在 U1 Profile 运行 `pnpm run release:check`；只有明确的升级任务才能改 DSH/ACP 版本，禁止浮动版本或普通依赖批量升级。
2. 逐项阅读 DSH/ACP/adapter 变更，重新核对 ACP lifecycle、工具事件、usage、图片输入、session 恢复与权限默认值。Bowerbird checkpoint 仍是业务权威；不得因上游新增 session resume 而静默迁移历史 Run。
3. 运行：

   ```text
   cd spikes/unified-agent-harness-u1/profiles/bowerbird-u1
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm test

   cd apps/agent-worker
   pnpm typecheck
   pnpm test
   ```

4. 生成 installed-package SPDX inventory。输出文件必须是新路径，脚本以 exclusive create 防止覆盖旧证据：

   ```text
   cd apps/agent-worker
   pnpm run sbom:unified-harness ../../spikes/unified-agent-harness-u1/profiles/bowerbird-u1 <new-output>.spdx.json
   ```

   `bowerbirdAudit` 必须记录 lock hash、安装包数、DSH 包数、精确 `0.1.1-rc.2`（升级时先同步脚本中的已批准版本）和缺失 license 声明。脚本对所有直接依赖的精确版本、已安装 direct package、DSH 版本及 MIT 声明 fail closed；SPDX `CONTAINS` 表示安装清单，不伪装为重建出的完整依赖图。

5. 构建候选后运行只读/断网探针：非 root、read-only rootfs、`cap_drop: ALL`、`no-new-privileges`、无 host port、无 Docker socket、资源上限与 secret 白名单均不得退化；`scripts/dsh-readonly-probe.mjs` 必须连续两次启动、清理 runtime home，并覆盖 planning 与 controlled-model 两条正式入口。

## 3. 镜像扫描与依赖审计

- 扫描器本身也必须用已记录的精确版本或 digest，不得在发布证据中使用未记录的 `latest`。沿用 VPS 可达的 ECR Trivy DB 镜像源，至少输出 vulnerability JSON；HIGH/CRITICAL 必须有修复、不可达性说明和明确接受人，否则维持 test-only、不扩大开放。
- 候选镜像不得为扫描上传到外部服务。推荐先以不挂载候选的容器下载公开 Trivy DB，再把候选导出为临时 tar；真正的 vulnerability/secret 扫描使用 `network none`、只读 tar、只读 rootfs、无 Docker socket。扫描完成后只保留报告与身份哈希，删除临时 tar。
- 另跑 secret 扫描；任何真实 provider key、Supabase secret、Worker token、签名 URL 或 env 文件命中都阻断发布。
- 将 SBOM、扫描 JSON、镜像 digest、lock hash、依赖 diff 和许可证异常放进同一只读发布证据目录。报告不得包含 env 或用户内容。
- DSH/ACP 升级后必须重跑 Profile 精确工具面测试；任何新增 shell/web/fs/subagent/MCP/plugin/telemetry 能力都视为安全回归。

## 4. test-only 发布顺序

1. 确认 Agent 队列为空、无 active lease、TTL backlog 为 0；记录 Worker/Edge 当前健康与版本。
2. 先保存旧 Worker 镜像 rollback tag 与 Edge 源码；migration 必须 additive 且先 dry-run。不要用数据库回滚脚本删除既有 Run 数据。
3. Edge 仍保持 `BOWERBIRD_TEST_DSH_RUNTIME_ENABLED=true` 只对测试账号接受显式 `agentRuntime=dsh`；普通账号与未声明 runtime 的历史 Run 不得变化。
4. Worker 的 `BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED` 与统一 Agent 闸门只在候选容器内显式开启；基础 Compose 的 test-only claim delay 必须为 0。
5. 先跑零 provider create/get/claim/cancel，再跑一组预算内 test-only 真实样本。每次 provider 调用按项目持续授权执行，但仍须事后报告 token、图片/视觉次数、credits、`provider_cost_micros`、失败和 `outcome_unknown`。
6. 运行无内容观察报告；可重复传入已冻结 paired evidence：

   ```text
   cd apps/cloud
   node scripts/report-unified-agent-observations.mjs --days=14 --evidence=<legacy-or-paired-observations.json> --evidence=<recovery-observations.json> --json
   ```

   报告覆盖失败率、取消率、p50/p95、credits、provider cost、tool retry/`outcome_unknown`、call/usage identity 重复及显式质量/recovery 证据。`attempt_count` 或普通审批后的 fresh claim 不能冒充 crash/re-claim 成功。

## 5. 回滚

以下任一情况立即停止新 DSH test Run：工具面扩大、secret 泄漏、call/usage 重复、积分不对账、恢复重复 provider 副作用、持续 `outcome_unknown`、质量回归或资源/安全约束漂移。

1. 先关闭 Edge 的 test-only DSH runtime 接受闸，阻止新 DSH Run；不要改写已存在 Run 的 `agent_runtime`。
2. 让已提交 provider 的 Run按 durable ledger 规则收敛；未知结果保持 `outcome_unknown`，禁止为“完成回滚”盲重放。
3. Worker 指回已记录的 rollback image/tag 并按原安全/资源约束重建；恢复后验证四消费循环、queue、active lease、TTL 与健康指标。
4. 若 Edge 同时变更，部署已归档的旧源码版本；additive migration 默认保留，不做破坏性 down migration。
5. 对受影响测试 Run 逐条核对终态、usage、credits、Artifact 与 provider side effect；在 PROJECT/专项计划记录原因、影响窗口和最终状态。

## 6. 生产决策边界

观察脚本只出证据，不自动给出公开阈值或修改系统。公开档位、预算/计费和“DSH 默认、继续双栈、停止采用”三选一需要产品决策；在决策前保持测试账号显式 opt-in，HTML 与普通账号路径不迁移。
