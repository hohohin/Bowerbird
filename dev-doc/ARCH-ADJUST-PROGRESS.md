# 收费化架构调整 · 当前进度

最近保存的 VPS 发布为 2026-10-24 部署入口与旧路径清理：Worker `834246b4560cc…`、understand-proxy v40、jev-proxy v9；196 项 VPS 回归、两次 DSH 探针及四消费者上线核验通过，未改迁移、价格、env 或 test-only 闸门。扫描与磁盘剩余问题、镜像及回滚以 [Cloud DEPLOY.md](../apps/cloud/DEPLOY.md) 顶部记录为准；官网和 Windows 下载发布以 [DESKTOP-UPDATES.md](DESKTOP-UPDATES.md) 为准。下方按日期保留历史验收，旧镜像/价格不代表当前配置。

## 2026-10-23 Bcoin 新规则：Cloud 已上线，桌面待发版

18:59:12（北京时间）完成 0070–0074、七个 Edge 与 Worker 切换并恢复接单；旧余额／有效期及两个历史未知任务保持。生产隔离账号的商品、试用、原子入账／退款重放通过，真实短理解 1 Bcoin、Pro 1K 生图 10 Bcoin 及重放通过，临时账号已清理。真实支付仍未开放，签名支付回调全链路未验；Cloud 视频、GPT 保持未开放。新规则见 [定价方案当前版](Bowerbird定价方案v2-订阅积分制.md)，版本／证据／回退见 [Cloud 部署记录](../apps/cloud/DEPLOY.md#2026-10-23-bcoin-计费已上线)。桌面包和官网更新通道未发新版，固定文案、试用按钮与新增工作流门控待桌面发版。下方更早部署记录仅为历史，不再用于当前报价。

离线 PGlite 覆盖旧余额／旧分类请求／旧兑换码、新码零赠币、永久充值、订单回调重放、未使用全额退款、禁止回收已冻结额度、订阅退款的后续变更保护、价格快照、参考图加价、分层像素边界与退款、视频五组报价及旧 usage 规则、试用幂等和私有 RPC 权限。Rust 工作流 25 项、Worker 生成／分层／视频／理解回归、Deno 权益签名／短文本边界及账号／图层 Chromium 回归通过；Rust 编译检查通过。桌面全量 TypeScript 保留既有 16 项编辑器错误，未新增本次文件报错。

2026-10-22 jev-proxy v6 已配套 Windows 26.10.2202 上线，兼容新版 42%／旧版 30%；此前已部署补标签实际 token 账本（0067、jev-proxy v5），独立账号一次真实方舟调用及重放计量验证通过；10 月 20 日分类与 10 月 16 日视频复刻实现保留，旧五图计费已被 10 月 23 日 Bcoin 规则替代，其他条目依据仓库内已保存部署记录。产品决策见 [PROJECT.md](../PROJECT.md)，原任务分解见 [ARCH-ADJUST-PLAN.md](ARCH-ADJUST-PLAN.md)，部署操作见 [apps/cloud/DEPLOY.md](../apps/cloud/DEPLOY.md)。

## 已完成与最近部署

P0–P8 基础代码、P6.1 多层权益门控、P9-T2/T3/T4/T5 的既有回归/安全/配置收口已完成。账号、真实 Cloud 图片/理解、积分预授权/结算、幂等、限流、每日额度和桌面/官网余额共享已有真实验收；图片和理解现经 VPS 异步执行，不再按早期同步 Edge 超时方案接续。

| 范围 | 最近保存的发布事实 | 证据与回滚 |
|---|---|---|
| 后台用户管理 | 10 月 22 日：0069、code-admin v4、官网用户清单及测试资格管理上线；真实 API／浏览器／权益／撤权验收通过，临时账号已清理，0068 保持未应用 | [用户管理](../apps/cloud/PRO-REDEMPTION.md#用户管理2026-10-22已上线)，`.tmp/user-admin-20261022/`；官网回退 26.10.2203 目录、Edge 回退已备份 v3 源码，保留审计 |
| 桌面账号网关 | 10 月 22 日：官网受控账号入口与 Windows 26.10.2203 已发布；临时账号邮件验证/刷新/签名权益通过，原机扫码待验；原鉴权、签名及计费保持 | [Cloud 部署](../apps/cloud/DEPLOY.md#55-桌面账号官网网关2026-10-22)，`.tmp/account-gateway-20261022/`；桌面发布回滚保留网关 |
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

10 月 16 日当时 Worker 镜像为 `sha256:b18d88d42633d6287837c3680613108333c1286e3c0f96982ecb3093732f36b8`（2026-10-16），在 9 月 22 日 `sha256:7f3813a80a521dc1194060478fb2ceb100e902ab3c5b84357b1786f0257946fb` 上仅覆盖视频复刻理解模块，保留此前视频、DSH、schema 2/transparent 增量。四类消费者已复核启动，restart 0、只读非 root 保持。当时回退标签 `rollback-replication-format-20261016`（修复前 `7fd069976e49…`）；历史分层与工作流回退标签及源码备份仍保留，见上表。

9 月 18 日桌面与官网已发布 26.9.18，包含工作区既有改动及设置内自动更新；版本清单、公开签名、完整安装包哈希和官网按钮已公网验证。当时官网目录 `20260918-app-updater-v2`，回滚 `20260914-code-admin`；证据 `.tmp/app-updater-release/published.json`。本次未修改收费化 Worker、Edge、数据库或价格，也不代表安装、OAuth、原生网页或真实模型全链路已复验。

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

### 2026-10-23 视频复刻语音转写

最新 2026-10-24：用户选择 text 输出，现役 Worker 更新为 `92bd83125ab2…`，真实普通文字分析与独立转写、一次 3 积分结算通过；保留 thinking 与音轨，桌面读取适配仍为源码。详见 [普通文本分析](VIDEO-REPLICATION.md#2026-10-24-分析改为普通文本cloud-已部署桌面源码待发布)。

后续 2026-10-24：基于 Bcoin 现役镜像定向启用视频分析 `thinking.type=enabled`，新镜像 `30198cd72cf7…`，保留音轨及转写契约。真实分析与转写、一次 3 积分结算和重放通过，测试账号清理完成；详见 [thinking 部署与回退](VIDEO-REPLICATION.md#2026-10-24-豆包分析开启-thinkingcloud-已部署)。

用户授权后更新现有 Worker 的分析提示词与转写归一化，保留 Mini 260428 与分析 3 积分价格。最终镜像 `971c1cb01ef0…`；真实合成语音测试返回根层转写，一次任务一次 3 积分结算，幂等／原键恢复通过。桌面新增本机 Codex 画面分析与转写栏仍为源码待发布，未改已安装应用。完整哈希、任务证据与回滚见 [视频复刻](VIDEO-REPLICATION.md#本次-cloud-部署与真实语音验收)。
