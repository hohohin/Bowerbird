# 收费化架构调整 · 当前进度

2026-10-22 jev-proxy v6 已配套 Windows 26.10.2202 上线，兼容新版 42%／旧版 30%；此前已部署补标签实际 token 账本（0067、jev-proxy v5），独立账号一次真实方舟调用及重放计量验证通过；10 月 20 日托管分类五图计费、10 月 16 日视频复刻分析及改写保持，其他条目依据仓库内已保存部署记录。产品决策见 [PROJECT.md](../PROJECT.md)，原任务分解见 [ARCH-ADJUST-PLAN.md](ARCH-ADJUST-PLAN.md)，部署操作见 [apps/cloud/DEPLOY.md](../apps/cloud/DEPLOY.md)。

## 已完成与最近部署

P0–P8 基础代码、P6.1 多层权益门控、P9-T2/T3/T4/T5 的既有回归/安全/配置收口已完成。账号、真实 Cloud 图片/理解、积分预授权/结算、幂等、限流、每日额度和桌面/官网余额共享已有真实验收；图片和理解现经 VPS 异步执行，不再按早期同步 Edge 超时方案接续。

| 范围 | 最近保存的发布事实 | 证据与回滚 |
|---|---|---|
| 补标签 token 计量 | 10 月 22 日：0067、jev-proxy v5；实际输入/缓存/输出/推理 token、模型、响应 ID 独立持久化；一次真实调用总量 2229 token，重放不重复计量，五图积分规则不变 | [LOCAL-CLASSIFICATION.md](LOCAL-CLASSIFICATION.md)，`.tmp/classification-usage-20261022/`；回滚旧代理，保留账本 |
| 托管分类 | 10 月 20 日：0065/0066、jev-proxy v4、understand-worker v21，Jev 密钥服务器托管；成功五图扣一积分，内部成本预算 0.10 元/张；4 张 Jev + 1 张 Cloud 真实分类、跨请求累计及幂等通过；同日取消分类每用户分钟限流，线上回滚事务验证已满分钟桶后 20 张共 4 积分 | [LOCAL-CLASSIFICATION.md](LOCAL-CLASSIFICATION.md)，`.tmp/classification-deploy-20261020/`，worker 旧源码在其中 `rollback/`；分钟限流取消证据及旧代理/数据库定义见 `.tmp/classification-no-rate-20261020/` |
| 视频复刻分析/改写 | 10 月 16 日：0062/0063/0064、understand-proxy v35、Worker `sha256:b18d88d42633…`（含分镜转场字段容错）；豆包 Seed 2.0 Mini，分析及改写各暂定 3 积分，两项真实结果及独立单次扣费通过 | [VIDEO-REPLICATION.md](VIDEO-REPLICATION.md#2026-10-16-分析上线与真实验收) |
| 视频基础 | 9 月 11 日：数据库 0001–0056 + 0058，12 个 Edge 入口和 Worker 同步；0057 保持未集成预留；视频价格未启用 | [VIDEO-API-INTEGRATION.md](VIDEO-API-INTEGRATION.md#2026-09-11-云端同步部署) |
| Agent 输入/模型 | 9 月 14 日：漏参可纠正、同 actionId 幂等；DSH 使用 `BOWERBIRD_DSH_MODEL=deepseek-flash`，非 DSH 模型独立 | [PROJECT.md](../PROJECT.md)、[历史部署记录](进展归档.md) |
| Pro 兑换码/后台 | 9 月 14 日：0059/0060、redeem-code v1、code-admin v1 与官网 /admin/ 上线；24 项线上检查通过 | [PRO-REDEMPTION.md](../apps/cloud/PRO-REDEMPTION.md#2026-09-14-线上验收与回滚) |
| 分层 | 9 月 14 日：0061，generate-proxy v36、generation-worker v28；20/23 积分测试价，真实拆分/修改与幂等扣费通过 | [LAYER-EDITING.md](LAYER-EDITING.md#2026-09-14-云端部署) |
| 权益签名 | 8 月 27 日上线 Ed25519；9 月 11 日签名冒烟、9 月 14 日兑换后的签名权益刷新通过 | [兑换码验收](../apps/cloud/PRO-REDEMPTION.md)、[部署手册](../apps/cloud/DEPLOY.md) |
| 工作流视觉规范 schema 2 / transparent 生成 | 9 月 22 日：VPS Worker 覆盖层镜像 `sha256:7f3813a80a52…`（含 `workflow.md` 提示词、统一 Agent 公众号排版领域方法）；Edge `visual-profile` v15（schema 2 + `capabilities`）、`generate-proxy` v37（`transparent`）；无新增迁移 | 本文件「2026-09-22 Worker 覆盖层与 Edge schema 2 部署」 |

### 2026-09-22 Worker 覆盖层与 Edge schema 2 部署

部署范围：`cb8f511` 中的云端增量——cloud-visual schema 2（文字要求 workflow 提炼）、cloud-generation `transparent` 透传（映射方舟 `background:"transparent"`）、brand-visual `loadBrandPrompt` 增加 workflow、`prompts/brand-visual/workflow.md` 新提示词、unified-agent 新增 `bowerbird-wechat-article-layout` 领域方法与 `skill.json`、harness 侧 agent-ds 模板组为可选组（不进正典镜像集）与 `allowImageContent` 仅本地开启，对生产行为无变化。

- **方式**：VPS `106.55.44.143` 全量 compose 构建因 apt 源仅 ~11 KB/s 放弃，改用 9 月 14 日先例的「现役镜像 + `COPY src` 覆盖层」：以 `rollback-workflow-20260922`（= 原 `local` `sha256:c0048df86cf2`）为底，覆盖 `/app/src` 并删除旧 `agent-ds-chat.ts`/`.test.ts`；候选 `candidate-workflow-20260922` 验证后打 `local` 标签 `up -d`。apt/pnpm/DSH profile 层未重建，镜像内容等价于全量构建。
- **验证**：镜像内断网只读跑 brand-visual/cloud-visual/cloud-understand/cloud-generation 单测 **37/37**；DSH 只读探针连续两次 `ok:true`（ACP 生命周期、工具面封闭、计量、密钥隔离）；容器四消费循环启动、restart 0；`visual-profile` 线上无 JWT 冒烟返回结构化 401（新版本在服务）。
- **回滚**：镜像标签 `bowerbird/generation-worker:rollback-workflow-20260922` + 源码/环境备份 `/opt/bowerbird/deploy-backups/workflow-schema2-20260922/{source.before.tar, env.generation.before, image.before.txt, image.after.txt}`；Edge 可重部署上一版源码。
- **边界**：未跑真实付费模型串联（schema 2 提炼、transparent 出图均未真实调用）；桌面端未发布（须走「Worker→Edge→桌面」顺序的最后一步）；统一 Agent 仍 test-only。既有问题（先于本次存在）：understand/visual 清理循环对控制面持续 `control_http_500`，两侧函数本次均未改动，未定位。

当前 Worker 镜像为 `sha256:b18d88d42633d6287837c3680613108333c1286e3c0f96982ecb3093732f36b8`（2026-10-16），在 9 月 22 日 `sha256:7f3813a80a521dc1194060478fb2ceb100e902ab3c5b84357b1786f0257946fb` 上仅覆盖视频复刻理解模块，保留此前视频、DSH、schema 2/transparent 增量。四类消费者已复核启动，restart 0、只读非 root 保持。最新回退标签 `rollback-replication-format-20261016`（修复前 `7fd069976e49…`）；历史分层与工作流回退标签及源码备份仍保留，见上表。

9 月 18 日桌面与官网已发布 26.9.18，包含工作区既有改动及设置内自动更新；版本清单、公开签名、完整安装包哈希和官网按钮已公网验证。当前官网目录 `20260918-app-updater-v2`，回滚 `20260914-code-admin`；证据 `.tmp/app-updater-release/published.json`。本次未修改收费化 Worker、Edge、数据库或价格，也不代表安装、OAuth、原生网页或真实模型全链路已复验。

## 保持的边界

- 素材库、长期提示词与视觉规范在本地；云端只处理授权任务。publishable key/URL 构建期内置，refresh token 在 OS keychain；服务端 secret 不下发桌面，Worker 不持数据库 service role。
- 免费仅 Cloud，Pro/Studio 才可用本机 CLI；UI、store、Rust 命令与恢复路径都复核权限。只有签名可信的权益快照才允许 7 天离线 Pro 宽限。
- 模型算力使用真实方舟；真实支付仍暂停，`BOWERBIRD_PAYMENT_MOCK=true`。兑换码不是支付渠道已完成的证明。
- DSH 保持 test-only；已知未知结果任务保留审计，不自动重发、退款或清账。

## 剩余验收

1. P9-T1 真实购买/到账：等待备案、商户资质和渠道决策，恢复时重新核对官方资料。Pro 兑换码发放已验证；Studio、到期降级、历史任务阻断仍需单独验收。
2. 视频：正式启价、四模式真实生成、Cloud→桌面下载入库、重启恢复与账单核对；旧 unknown 提交不能凭时间/相似参数认领。
3. 分层：正式定价和原生桌面完整链路。云端真实测试通过不能代替桌面验收。
4. 微信登录真实联调；DSH 自然小名单质量观察与供应链问题收口。上次 4 CRITICAL / 18 HIGH 没有后续扫描/接受证据，不扩大开放。
