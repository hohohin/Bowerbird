# Bowerbird Cloud · 部署指引（凭据已备好）

> 目标：把 `apps/cloud/` 的 Supabase 迁移 + Edge Functions 推上云端，完成 Auth/积分/算力的真实联调。
> 前提：你已在 Supabase 控制台拿到 Project URL / publishable key / secret key，并已在 `apps/cloud/.env` 填好方舟 key 与 endpoint id。

## 2026-10-25 后台昵称已上线／微信收款只读核验

仅定向应用 **0076** 并登记迁移历史，`admin_list_users` 新增昵称返回及搜索，鉴权与目标 UUID 保持；0068 未应用。官网在 2401 现役基础上只替换 admin 两个静态文件，现役 `20261025-admin-nickname`，回滚 `20261024-windows-26.10.2401`；所有 Edge（含 `code-admin` v5）、Worker、价格、环境及桌面更新通道未变。本地回归、公网文件、真实同名临时账号 API／浏览器操作及会员积分不变验证通过，临时账号已全部清理。实现、证据和回退见 [后台昵称记录](PRO-REDEMPTION.md#2026-10-25-昵称展示与搜索已上线)。

微信收款只读核验（2026-10-25）：线上 `BOWERBIRD_PAYMENT_MOCK=true`，`create-checkout` v29／`payment-webhook` v30 下载源码与仓库一致，均只实现 Mock。`SUPERUN_WEBHOOK_SECRET` 已存在，但当前用于 Mock 静态签名校验，不能视作真实渠道接入。数据库 18 笔订单全部 `provider=mock`（pending 15／paid 1／refunded 2）；该 paid 状态不代表实际收款。本轮未创建订单、修改支付开关或测试真实扣款。

已有基础为服务端商品价格／快照、订单、订阅和积分原子入账、幂等及内部退款；真实下单、收银台／二维码、渠道通知验签与金额核对、查单／退款、真实小额端到端验收仍未实现或未完成。本次只读配置检查发现的是 Mock 开关与 Mock 回调密钥，没有真实渠道 adapter 的部署证据。**用户随后于 2026-10-25 确认微信支付商户资质已完成，并取消 superun、改走微信支付直连**；商户资质状态以用户确认优先，不再等待申请。Native API v3 接入研究、技术参数和任务卡已补入 [收费化计划 P7](../../dev-doc/ARCH-ADJUST-PLAN.md#p7--订阅与支付)，本次研究未部署支付代码或发起真实交易。`wechat-login` v16 是网站应用 OAuth 登录，与微信支付商户接入独立。现役代码直接将 Mock 设为 false 会返回 503，不会开启收款。只读证据 `.tmp/admin-nickname-20261025/inspection.json` 与 `deployed-before/`。

## 2026-10-24 分类英文规则与 Windows 2401 已发布

本轮先存档源码 fd948497 并推送，再于 20:11（北京时间）定向应用 **0075**、部署 **jev-proxy v10**。从 v9 下载实际依赖构建候选，仅替换 jev 的 index／prompt／protocol、新增 translation 和 Ark 输出上限参数；其余依赖原样。生产 schema 演练事务回滚核对后正式应用，advance_classification 仅将过期依据从 created_at 改为 updated_at，原 Bcoin 结算保留。

候选类型／24 项 Deno／PGlite 与桌面 Rust 回归通过，下载已部署源码逐文件一致，JWT 开启；新表强制 RLS、普通角色无内部准备 RPC 权限、service_role 可执行，匿名请求 401。原价格和其他 Edge 版本保持，Worker 834246b4560cc… 不重部署，0068 未应用。无付费模型调用，线上翻译质量仍待真实样本验收。随后 Windows 2401／SQLite 0045 已上线，官网同步中文错误提示。

本机证据与旧 v9 完整接口备份：`.tmp/release-windows-26.10.2401/cloud/`。保留 0075 表、账本和缓存，不执行 down migration；新版客户端仍在线时不能恢复不支持英文协议的代理，应做向前兼容修复。官网与桌面分发回滚另见 [桌面更新](../../dev-doc/DESKTOP-UPDATES.md)。

## 2026-10-24 VPS 磁盘清理（已完成）

19:53（北京时间）按用户确认清单完成。删除 `/opt/bowerbird/website-releases/` 内明确列出的 30 个旧发布目录、`/tmp/bowerbird-release-windows-*` 内 8 个经 SHA-256 比对的重复安装包；执行 `docker builder prune --filter until=168h --force`，工具报告回收 2.469 GB 构建缓存。磁盘由 98%／约 1.1 GiB 可用降至 **69%／约 14.6 GiB 可用**，实际增加可用空间约 **13.5 GiB**；以磁盘实测为准，不累加 Docker 共享层估算。

**保留与回滚边界**：官网现役 `20261023-windows-26.10.2301`，最近两份回滚 `20261023-cdn-distribution`、`20261023-comfy-tos`，以及含独有视频的 `20260824191404` 均保留。其余 30 个旧官网目录已删除，历史文档所列对应回滚路径仅为当时记录，不再可直接执行。现役旧包下载、全部 Docker 镜像／标签、Worker 回滚、部署备份与证据均保留；旧目录中的 55 份环境配置已存入 VPS 受限备份 `old-release-env.tar`，没有下载到本机。

**验证与证据**：539 个保留文件哈希／权限与符号链接核验通过；77 个镜像标签及其 ID/digest 一致；两个容器 running、restart=0，renderer healthy，官网 PID 与现役链接未变，无服务重启。公网首页／后台、healthz 204、三平台更新跳转及清单、8 个旧包 HEAD 均通过，清单与 Windows 2301 发布基线一致。首轮镜像检查误比较了相对时间 CreatedSince；改按仓库／标签／ID／digest 复核通过，没有重跑清理。清单、日志、结果及公网报告在本机 `.tmp/vps-disk-cleanup-20261024/`，VPS `/opt/bowerbird/deploy-backups/disk-cleanup-20261024/` 保存保留文件校验、镜像清单、旧环境备份及结果。依赖漏洞和既有 understand/visual TTL 缺陷仍需独立处理。

## 2026-10-24 部署入口与旧路径清理（已上线）

19:04（北京时间）完成上线后核验。现役 Worker **`sha256:834246b4560cc60113c4f341c5c519c1c9cdf847585d0d156547dfaafbd4f77d`**，`understand-proxy v40`、`jev-proxy v9`，两条 Edge 均保持 JWT。基于实际现役源码定向清理：Worker 删除未接线 Agent DS 启动链、可选模板模式及其独占图片放行选项，移出未注册系列导演草案；Edge 仅修改各自的 `_shared/ark.ts`，移除无调用的同步生图实现，保留同步理解与 usage 账本。服务器两个 Dockerfile 已补齐六个共享文件，原基础镜像 digest 保留。

**部署范围**：保留线上三份已通过哈希校验的 Skill、449 个依赖包、env、Compose、安全资源约束和 test-only 闸门；未应用迁移，0068/0075 仍未应用，不带 GPT/分类英文规则等其他未发布源码。Edge 理解输出预算仍为已部署的 2000；本地 0075 的 6000 参数扩展未随本轮发布。官网、renderer、桌面及价格不变。仓库中的配置示例、旧脚本退役与历史文档修订不通过覆盖生产 env 生效。

**验证**：候选在 VPS 断网、只读、非 root 容器中 196/196 回归通过；两次 DSH 探针均通过 ACP 初始化、临时目录清理、统一/旧受控 processor、durable ledger、usage 与闭合工具面；四消费者导入与真实合成视频 ffprobe 通过。两条现役 Edge 候选 13 项 Deno 及入口类型检查通过，发布后逐文件下载核对，只有 ark.ts 变化。上线后四类消费者启动、running、restart=0，env 原样、源码哈希及安全约束通过；匿名请求均 401，队列与迁移保持，两个历史 outcome_unknown 不变。未调用真实模型、未产生本轮真实模型用量或用户扣费；本轮不替代新功能真实 E2E。

**扫描与剩余运维**：固定 Trivy 0.74.0 / `sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969` 离线扫描候选，密钥检出 0，漏洞条目 CRITICAL 12 / HIGH 295。候选继承全部原镜像层，前后完整依赖 SBOM 一致；未扩大开放、未升级依赖，也未宣称漏洞已修复。新漏洞库解压约 1.6 GiB 一度耗尽磁盘，已仅删除本轮可再生成扫描缓存；报告与回滚仍保留。基线同库重扫未完成，不能声称有完整扫描差分。此次部署结束时磁盘 98%，可用约 1.1 GiB；随后空间治理已完成，见上方同日磁盘清理记录。依赖漏洞与既有 understand/visual TTL 缺陷仍需独立处理。

**本地检出限制**：此前 Windows 全量检查的 CRLF/统一 Skill 哈希、DSH 符号链接问题没有绕过或修改 manifest；现役下载的三个 Skill 原始内容均通过哈希，候选沿用该版本。禁止把当前本地全部源码直接覆盖 VPS。

**证据与回滚**：本地 `.tmp/vps-cleanup-deploy-20261024/` 保存 published.json、payload-manifest.json、base-comparison.json、两条 Edge 的 rollback/edge/verified 源码及扫描/SBOM/测试证据；VPS `/opt/bowerbird/deploy-backups/vps-cleanup-20261024/` 保存源码备份、0600 env 与验收报告。镜像回滚标签 `bowerbird/generation-worker:rollback-vps-cleanup-20261024` 指向此前 `92bd83125ab2…`；回退时恢复该镜像及本轮改动源码，两条 Edge 可分别重部署已保存的 v39/v8 源码并保持 JWT；无数据库 down migration。环境备份仅留 VPS，不下载入库。

## 2026-10-24 分类英文规则（源码，未部署）

本轮只涉及 `0075_classification_translation_usage.sql`、`jev-proxy` 及其 `_shared/ark.ts` 输出上限参数；不部署其他待办功能。先定向应用 0075，再部署保持 JWT 的 `jev-proxy`，最后加载 SQLite 0045 的新桌面。无新 Secret；继续使用服务器 Jev 和方舟配置。旧客户端无 `prompt_language`，保留原响应；新客户端校验英文协议标记，不能先发桌面再留旧代理。

缺译规则每个请求只准备一批，沿同一图片、原 body／幂等键续传；全部就绪后唯一领取 Jev。新增独立翻译 usage 与短期英文缓存，不存图片。准备期积分预留采用 `pending_settlement`，避免大词表误触通用 30 分钟预留过期；分类自己的 10 分钟无进展清理继续退款，活跃步骤更新活动时间，busy 查询不延活。0075 用精确锚点保留当前 `advance_classification` 财务实现，只调整其补标签过期依据；上线前须在生产函数备份上验证锚点，禁止覆盖现役 Bcoin 结算。每批增加内部供应商预算，用户仍按成功图片结算一次。

离线 Rust 分类 92 项、迁移 10 项、Deno 17 项及现役 Bcoin 模型上的 PGlite 通过，包括 254 条／64 批、并发／丢失缓存确认、长时间预留、重放和失败退款。未调用真实模型。回退保留 0075 账本和数据；新桌面仍在线时不可回退到不支持英文协议的代理。实现与用例见 [分类专项](../../dev-doc/LOCAL-CLASSIFICATION.md#2026-10-24-jev-内部英文规则源码未部署)。

## 2026-10-24 视频复刻普通文本已上线

视频分析改用 `response_format.type=text` 与文字提示词，保留 thinking 和独立语音转写。现役 Worker `sha256:92bd83125ab25006fc1638ba77da2754cd14df93b724e45b60e2079b69c16bc6`；24 项候选回归及真实文字分析／转写／单次 3 积分结算通过，测试账号已清理。环境、Edge、模型、账本不变。回滚标签 `rollback-replication-text-20261024` 指向前次 thinking 镜像。详见 [视频复刻](../../dev-doc/VIDEO-REPLICATION.md#2026-10-24-分析改为普通文本cloud-已部署桌面源码待发布)。

## 2026-10-24 视频复刻 thinking 已上线

在下方 Bcoin 现役 Worker 上定向将视频分析请求改为 `thinking.type=enabled`，运行镜像更新至 `sha256:30198cd72cf7cb414591c5bd91a59f11f12888770c1ef365b94d143c52538cab`；环境、Edge、模型、价格及账本保持。23 项断网回归与真实带语音视频分析通过，返回独立转写、一次 3 积分结算，测试账号已清理。回滚标签 `rollback-replication-thinking-20261024` 指向此前 Bcoin 镜像 `29f3e4b518be…`。完整记录见 [视频复刻](../../dev-doc/VIDEO-REPLICATION.md#2026-10-24-豆包分析开启-thinkingcloud-已部署)。

## 2026-10-23 Bcoin 计费已上线

2026-10-23 **18:59:12（北京时间）**恢复接单。先下载现役七个 Edge 及 Worker 源码、备份计费配置／订单／钱包批次／订阅／数据库函数，再在回滚事务中演练；临时阻止新计费和支付写入，确认活动任务为 0 后，原子应用 **0070–0074**。**0068 未应用**，旧余额与有效期逐条核对未变，两个历史 outcome_unknown 任务保持。新分类每成功图片 1 Bcoin；免费账号可购买算力，不再受旧免费分类每日 10 张限制，全站成本熔断及余额校验保留。

现役 Edge：`generate-proxy v41`、`generation-worker v32`、`understand-proxy v39`、`jev-proxy v8`、`entitlement v41`、`create-checkout v29`、`payment-webhook v30`。均下载实际源码与冻结候选逐文件一致，原 JWT 策略及其他 Edge 版本不变。理解代理首轮候选缺少 image-metadata.ts、打包未成功，补齐后部署 v39；未产生半成品活动版本。

Worker 基于现场现役 `971c1cb0…`（包含当天音轨修复）做最小覆盖，镜像 **`sha256:29f3e4b518be51aeae2ee3d7d994f2d5b5c6e7655151c45a63e7a4d87429ea0a`**；保留原 env、compose、其他模块，不带尚未部署的 GPT Image 源码。模型：Pro `doubao-seedream-5-0-pro-260628`、Lite `doubao-seedream-5-0-260128`、理解 Seed 2.0 Lite、复刻 Seed 2.0 Mini，真实模式保持。候选在 VPS 无网络容器中 **42 项测试通过**，上线后 running、restart=0。

验收：PGlite 财务与迁移回归、12 项 Deno（分类另补免费账号断言复跑 6 项）通过。生产隔离账号验证 6 个商品报价、签名权益、注册／每日不赠币、永久充值、预扣全退、入账／退款重放、Pro 不赠币、一次 7 天试用不延长及过期离线宽限、禁售 Studio、170 分层上限与超长标准理解拒绝。真实短文本理解 **1 Bcoin**、Pro 1K 生图 **10 Bcoin** 成功，重放同一任务，余额共减少 **11**；临时账号已删除，测试财务审计保留。未做本轮真实分层模型调用，分层 pixels／退差额由候选与数据库回归覆盖。

支付边界：创建订单仍为 **Mock、不收真实款**。本机未提供 Mock 回调签名密钥，入账／退款验证通过服务端原子 RPC 完成，不能称为支付渠道回调端到端验收。Cloud 视频三个档位保持 inactive，GPT／Flash 未启价，Agent 原预算和测试门控不变。

本轮仅上线 Cloud；**Windows 仍为 26.10.2301，Mac 与官网更新通道未切换**。桌面新增 Bcoin 文案、试用按钮和工作流原生门控源码待后续桌面发版；旧包的动态生图价格可通过权益刷新获得，固定文案不会随云部署更新。未修改官网页面；官网当前没有该方案的正式购买报价，仍处于 Beta 展示。

证据：`.tmp/bcoin-rollout-20261023/` 下 published.json、release-hashes.json、state-verified.json、sources-verified.json、smoke.json、real-generation.json、rollback/、worker-before.tar；财务快照只保留在本地私有证据中，不提交。VPS 备份 `/opt/bowerbird/deploy-backups/bcoin-20261023/`，旧镜像标签 `bowerbird/generation-worker:rollback-bcoin-20261023`。

回退不能直接把旧 Edge／Worker 套在新账本上：先暂停新计费，保留新价格快照、0070–0074 表列、永久充值及历史流水；已接受的新任务须由兼容新快照的 Worker 完成或按失败状态退款，禁止旧分层接口把 170 预扣全部结算。源码备份用于定向修复／兼容回退，不执行删列、重算旧余额或缩短新充值有效期。临时维护触发器已全部撤除。

上线后只读健康检查发现既有 TTL 清理缺陷：understand_jobs_check2／visual_profile_jobs_check2 要求 succeeded 的 result_text 非空，而旧清理代码将 result_text 置空；现场分别有 473／17 条过期成功记录未标记 deleted_at，最早于 8 月到期。该约束与清理 Edge 不在本轮改动中；真实新任务／扣费验收通过。自动审批拒绝主动调用 cleanup_expired（会删除过期对象并更新记录），因此仅查询约束与计数，没有执行额外清理或修改约束。证据 cleanup-readonly.json；此历史问题需独立修复和数据清理验收。

## 2026-10-22 后台用户管理已发布

仅定向应用 **0069**（0068 保持未应用），`code-admin` **v4** 已上线、JWT 开启，其他 Edge 保持。官网 `/admin/` 新增用户列表／搜索／测试账号筛选及资格授予／取消，复用服务端管理员标记并原子留审计。现役官网目录 `/opt/bowerbird/website-releases/20261022-user-admin`，基于并保留 `20261022-windows-26.10.2203`；仅更新 admin 三文件，账号网关、下载配置和更新通道未改。

真实临时账号 API、浏览器操作、权益刷新、幂等审计、越权／撤权、会员积分不变通过；临时账号已清理，审计保留。证据 `.tmp/user-admin-20261022/`；上线与回滚细节见 [用户管理](PRO-REDEMPTION.md#用户管理2026-10-22已上线)。旧 Edge 位于证据目录 `rollback/`；官网回滚切回 2203 并重启服务。未变官网文件使用硬链接克隆，后续修改须替换 inode，禁止原地写共享文件。未部署 Worker、桌面或 GPT 模型。

## 2026-10-22 分类 v6 与 Windows 26.10.2202 已发布

jev-proxy v6 已上线并下载核对全部依赖源码；matching_version=8 为 42%，无字段的旧客户端保留 30%，未知版本调用前拒绝。Windows 26.10.2202 包含 SQLite 0043/0044 与新版请求字段。13 项 Deno（含真实 handler 的新旧分流）、Rust 最终 652/0/21 和 14 组界面通过；线上未登录请求返回 401，未调用真实模型。原 0067 及五图计费保持，没有迁移或 Worker 部署，0068/GPT 保持未开放。旧 v5 源码备份及发布报告在 .tmp/release-windows-26.10.2202/cloud/；v5 不支持新门槛，新桌面仍在线时不直接回退。

## 42% 分类协议发布准备（2026-10-22，历史准备记录）

发布兼容补充：新版 judge 请求带 `matching_version=8`，云端采用 42%；已发布旧客户端未带字段仍用 30%，未知版本在推理前拒绝。版本字段参与现有请求哈希，重放不能换规则。部署先兼容云端、后新版桌面，无须强制所有客户端同时升级。13 项 Deno 包含真实 handler 的 35% 新旧分流及结算参数，Rust 检查请求字段。

仅部署 jev-proxy；不应用 0068 或其他待迁移项。现役 v5 已下载备份，候选依赖仅 index.ts/protocol.ts 与线上不同；token 账本与五图计费保持。证据及回滚源码 `.tmp/release-windows-26.10.2202/cloud/`。

## Cloud 补标签 token 计量（2026-10-22 已部署）

当前 `jev-proxy` 为 **v5**，数据库新增 **0067**。补标签先建立持久账本，再调用方舟；响应 usage 在标签校验前写入，独立保留，不随 24 小时响应清理删除。缺失或超时标记待核对，不能按零成本统计。部署顺序为定向应用 `0067_classification_usage.sql` → 部署 `jev-proxy`；无新 Secret、VPS 或桌面变更。重部署勿全量 push 其他待迁移项。

12 项 Deno 测试、隔离数据库回归及一次真实方舟补标签通过；生产核验输入 2103 / 缓存 0 / 输出 126 / 总计 2229 token，重复调用无新增账本，用户积分规则保持。证据及旧代理位于 `.tmp/classification-usage-20261022/`。回滚仅恢复其中 `rollback/` 的旧代理，保留 0067 和已保存数据；旧代理不再采集新用量。字段、缺失状态、核算与查询见 [分类专项](../../dev-doc/LOCAL-CLASSIFICATION.md#2026-10-22-cloud-补标签真实-token-账本已上线)。

## Jev 同步托管分类（2026-10-20 历史初次部署）

> 以下保留首次部署与五图一积分的历史证据，不是当前重部署步骤。10 月 23 日 Bcoin 已改为每张成功图片 1 Bcoin、无免费分类配额；当前迁移与验收以本文顶部 Bcoin 和 0075 状态为准，禁止回灌旧价格/免费额度。

0065/0066 已定向应用；`jev-proxy` v4 / `understand-worker` v21 已上线，Jev Secret 已配置。用户确认 `JEV_CLASSIFICATION_COST_MICROS=100000`（0.10 元/张保守成本预算，不是用户售价）。临时测试账号的 4 次真实 Jev + 1 次 Cloud 补标签验证了五张扣一积分及重复请求幂等；证据 `.tmp/classification-deploy-20261020/`。以下为当时执行顺序。

1. 审核并应用 `0065_classification_proxy.sql`、`0066_classification_no_rate_limit.sql`；不要直接对有其他待迁移内容的工作区执行未筛选的全量 push。
2. 在 Supabase Secrets 配置 `JEV_API_KEY` 和 `JEV_CLASSIFICATION_COST_MICROS`。后者为一次 Jev 判断加最坏一次 Cloud 补标签的保守人民币微元预算，必须根据实际供应商费用填写；不从客户端读取密钥，也不能以用户售价代替供应商成本。沿用 `DAILY_COST_LIMIT_CNY`、`FREE_CAPTION_DAILY_LIMIT`；分类不再读取 `RATE_LIMIT_PER_USER_PER_MIN`。继续使用方舟 Vision 配置，生产设置 `BOWERBIRD_CLOUD_MOCK=false`。
3. 部署 `jev-proxy`（用户 JWT + 内部 `requireUser`），再部署 `understand-worker --no-verify-jwt`。已有 worker 的 `cleanup_expired` 负责清理分类挂起请求和过期响应，不承担分类推理。每次新分类也会尝试清理。
4. 构建并重启新桌面后端后再启用客户端入口；旧后端仍要求本地 Jev Key。上线以同一测试账号验证第 1–4 张实际扣 0、第 5 张扣 1、跨批次累计、Jev/Cloud 混合、无法判断/失败/重复请求及 24 小时响应清理。

新接口在单次请求中同步完成 Jev 或补标签调用，不上传对象存储、不创建 worker 排队任务、不轮询。数据库只保留计费/幂等记录及 24 小时响应；图片只在请求内存中。一次图像流程先暂时预留 1 积分（并发请求各自预留），完成后实际扣 0 或 1 并释放余款。取消等待不撤回已经完成的云端结果，云端产生有效标签即算成功；不以客户端声明作为计费依据。挂起超过 10 分钟按未完成退还预留款；供应商成本预算不退回，避免失败重试绕过熔断。免费账号沿用云理解额度，失败/无法判断退还次数，补标签不重复扣次数。

线上与隔离验收详情见 `dev-doc/LOCAL-CLASSIFICATION.md`。当前成本参数为保守预算，需按后续实际供应商账单校准；分类每用户分钟限流已取消，当前代理传入 NULL 跳过分钟门控及计数。五图计费、免费每日额度和全站成本预算保留。0066 必须先于 v4 代理部署；旧代理和数据库函数备份位于 `.tmp/classification-no-rate-20261020/rollback/`，回退先恢复旧代理，再恢复旧数据库函数。

## GPT Image 2.5（2026-10-22 源码接入，未部署／未启价）

普通 Cloud 生图新增两个独立服务：`image_gpt25_sunburst` → `gpt-image-2.5-sunburst`，`image_gpt25_flare` → `gpt-image-2.5-flare`。使用现有 generation 队列、租约、产物上传与积分结算；本轮不改 Agent 的 `generate_image` 工具或本机 Codex 路线。模型与 `quality=high` 固定在 Worker，单任务生成一张 PNG。文本调用 `/v1/images/generations`，参考图调用 `/v1/images/edits` 的 JSON `images[].image_url`，支持七档比例和透明背景。自动比例在桌面无法推断时使用 1024×1024，明确比例按原比例输出、最长边不超过 1536。

**API key 填写位置：**

- 本地准备：现有 gitignored `apps/cloud/.env` 已预留 `OPENAI_API_KEY=`，在等号后填写；也可使用 `.env.local`，模板见 [.env.example](.env.example)。本地在 `apps/agent-worker` 目录启动时显式使用 `node --env-file=../cloud/.env src/cloud-generation/main.ts`（选择 `.env.local` 时相应改路径），该文件还须包含原有 Worker 配置。
- **线上实际生效位置：VPS `/opt/bowerbird/agent-worker/.env.generation`**，加入同名 `OPENAI_API_KEY`。两个模型共用一个有对应模型权限的 OpenAI API key；文件权限保持 `0600`。本地填写不会自动同步到 VPS。
- Compose 的 `env_file` 已加载该文件；更新 Worker 镜像后需重建容器使新环境生效。此 key 不用设置为 Supabase Secret，也不进入桌面、网页或 DSH 子进程。未配置时仅 GPT 两档在提交前失败，方舟保持可用。

上线顺序：

1. 同步新 Worker 源码并构建候选镜像，完成离线检查，填写 VPS key；部署时保留现役镜像与环境备份。
2. 应用 `0068_gpt_image_25.sql`。迁移创建两条 `active=false / unit_cost=0 / pricing_ready=false` 的档位；只迁移不会把未定价模型开放给用户。
3. 分别确认 Sunburst / Flare 的每张积分价格，再在同一更新中设置各自 `unit_cost`（正整数）、`parameters.pricing_ready=true`、`active=true`，增加 `pricing_version` 并更新 `updated_at`。数据库约束拒绝零价或未确认价格直接启用。测试中的 17/18 分仅为隔离夹具，不是产品价格。
4. 刷新账号权益后，桌面现有动态 provider 列表会显示两项，key 分别为 `bowerbird-cloud-image_gpt25_sunburst` / `bowerbird-cloud-image_gpt25_flare`；无需为此修改桌面选项。完成真实生成、参考图编辑与单次扣费验收后记录部署证据。

OpenAI 明确拒绝参数／权限／配额时沿失败回滚处理；网络中断、408/5xx、无效成功响应或产物上传失败保留 `outcome_unknown`，不自动重发或退款。回滚时先停用两档、等待在途 GPT 任务结算，再恢复旧 Worker，避免旧 Worker 将新 service 当方舟默认档处理；保留迁移与账本。

离线验证（仓库根目录；不加载真实 key、不访问模型）：

```powershell
node --test apps/agent-worker/src/cloud-generation/*.test.ts
node --test --test-name-pattern="passes only the loopback model proxy" apps/agent-worker/src/harness/node-dsh-acp-port.test.ts
node apps/cloud/scripts/gpt-image-db.test.mjs <本地PGlite目录>/dist/index.js
```

协议依据：[OpenAI Images generation](https://developers.openai.com/api/reference/resources/images/methods/generate)、[Images edits](https://developers.openai.com/api/reference/resources/images/methods/edit)。

本轮验证：35 项 cloud-generation 测试、DSH 环境白名单单测、Worker 完整 TypeScript、桌面动态档位映射及 PGlite 计费回归通过。完整 DSH port 套件中的两项生命周期测试受当前 Windows `symlink EPERM` 阻挡；密钥隔离使用不创建链接的 `buildDshChildEnvironment` 测试验证，未改动该运行时。

2026-10-22 11:49（北京时间）本地真实访问：直连超时，经系统代理后 `GET /v1/models/gpt-image-2.5-sunburst` 与 Flare 对应查询均为 200。使用新增 provider 的实际请求／解析代码分别提交一次 high / 1024×1024 生图，两次均为 `429 / credit_balance_exhausted / insufficient_quota`，未返回图片或 usage，无自动重试。Sunburst 请求 ID `req_5d0c811b4a0d44889760e4ff03c53063`，Flare `req_c1285a5d68c6471abebac135e1d7dd82`。证据及不含密钥的测试脚本位于 `.tmp/gpt-image-real-20261022/{access.json,generation.json,probe.mjs,generate.mjs}`。本次直接测试 OpenAI API，未走 Bowerbird 积分或生产任务队列；不能推断供应商费用为零。待补足 OpenAI API 额度后继续真实出图验收，线上仍未部署／启价。

## 需要手工做的事（按顺序）

### 1. 安装 Supabase CLI

任选其一：

- **npx**（无需全局安装）：
  ```bash
  npx --yes supabase@latest --version
  ```
- **Scoop**（Windows）：
  ```powershell
  scoop install supabase
  ```
- **Homebrew**：
  ```bash
  brew install supabase
  ```

验证：
```bash
npx --yes supabase@latest --version
```

下文的 `supabase ...` 命令在未全局安装时可统一替换为 `npx --yes supabase@latest --agent no ...`。

### 2. 登录并链接项目

```bash
npx --yes supabase@latest --agent no --output-format text login
# 会打开浏览器授权，授权后回终端
npx --yes supabase@latest --agent no link --project-ref <你的-project-ref>
```

`<project-ref>` 在 Supabase 项目 Settings → General → Reference ID。

### 2.1 配置 Auth 回调 URL（托管项目必须手工同步）

打开 Supabase Dashboard → Authentication → URL Configuration：

1. 在 **Redirect URLs** 添加 `bowerbird://auth/callback**`（桌面 PKCE 回调会附带动态 `state` 查询参数，不能只填无查询串的精确地址）。
2. 本地官网开发再添加 `http://127.0.0.1:5173/**` 与 `http://localhost:5173/**`。
3. 官网上线后，把正式 HTTPS origin 设为 **Site URL**，并把同一 origin 加入 Redirect URLs。
4. Magic Link 邮件模板的按钮应使用 `{{ .ConfirmationURL }}`；若自定义模板直接使用 `{{ .SiteURL }}`，代码传入的 redirect URL 不会生效。

未命中 Redirect URLs 时，Supabase 会回退到 Site URL；控制台默认值通常是 `http://localhost:3000`，表现为邮件链接验证后跳到无法访问的本机地址。
Windows 用 `tauri dev` 验收时，桌面端会在 debug 环境运行时注册 `bowerbird://`；安装包则由系统安装过程注册。

> Supabase 内置 SMTP 仅供试用，整个项目最多发送 2 封 Auth 邮件/小时；这与 OTP 接口的 60 秒单邮箱冷却、30 次/小时额度是不同层级。需要持续联调或对外发布前，应在 Authentication → Emails → SMTP Settings 配置自定义 SMTP。

### 3. 推送数据库迁移

```bash
cd apps/cloud
npx --yes supabase@latest --agent no db push --dry-run
# 只审阅待迁移列表，不直接全量 push；按本次发布清单定向应用并登记迁移。
# 当前 0068 未应用，0075 尚待部署，不可因补齐历史编号而自动执行。
```

上面 dry-run 仅列出差异。未加 dry-run 的全量 push 会执行待迁移文件，不能用于当前有意保留编号空洞的部署。以下为历史依赖关系，并非当前完整迁移上限：早期 Agent Runtime 要求至少到 `0039_agent_clarification_answer.sql`。`0010` 必须先于新版 `generate-proxy` / `understand-proxy`；`0011` 必须先于新版 `entitlement` / `generate-proxy` / `understand-proxy`；`0015` 必须先于异步版 `generate-proxy`、`generation-worker` 与 VPS consumer；`0019` 必须先于异步版 `understand-proxy`、`understand-worker` 与 VPS understand consumer；`0028`–`0030` 必须先于支持 Codex/即梦本机生图停车交接的链路；`0031`/`0032` 必须先于文本 usage 可信计量和定时 TTL 清理版 `agent-worker`；`0033`/`0034` 必须先于 Agent 账单 marker 与原子容量闸版 `entitlement` / `agent-run`；`0035` 负责过期未租约 parked Run 的原子取消，`0036` 负责生产/测试监控样本隔离，`0037`/`0038` 修复已部署早期迁移遗留的 Codex Run、本机任务与 usage provider 数据库约束，`0039` 原子应用有限澄清答案并使旧计划审批失效。统一 Agent 进入多图片最终结果版本前，必须先应用 `0053_unified_agent_multi_final_results.sql`，使数据库终态结算与 Edge 的多 `final_result` 策略一致；legacy Skill 仍要求唯一最终结果。

### 4. 部署 Edge Functions 并注入 Secrets

以下为入口与配置参考；每次只部署发布清单涉及的函数与 Secret，不整段重放。新建 Agent 仅支持 unified DSH，Edge/Worker 两侧闸门见 [Runbook](../agent-worker/UNIFIED-HARNESS-RUNBOOK.md)。生图模型只配置在 VPS；同步理解与 Jev 补标签仍需要 Edge 方舟 Vision 配置。

```bash
# 部署函数
supabase functions deploy generate-proxy
supabase functions deploy generation-worker --no-verify-jwt
supabase functions deploy understand-proxy
supabase functions deploy understand-worker --no-verify-jwt
supabase functions deploy entitlement
supabase functions deploy create-checkout
supabase functions deploy payment-webhook
supabase functions deploy agent-run
supabase functions deploy agent-worker --no-verify-jwt
supabase functions deploy visual-profile
supabase functions deploy visual-profile-worker --no-verify-jwt
supabase functions deploy wechat-login --no-verify-jwt

# 注入 secrets（从 .env 读取；只上传一次，函数运行环境持有）
supabase secrets set SUPABASE_URL=$SUPABASE_URL
supabase secrets set SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY
supabase secrets set SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
supabase secrets set ARK_API_KEY=$ARK_API_KEY
supabase secrets set ARK_BASE_URL=$ARK_BASE_URL
supabase secrets set ARK_VISION_MODEL=$ARK_VISION_MODEL
supabase secrets set ALLOWED_ORIGINS="https://bowerbird.cn,http://127.0.0.1:5173,http://localhost:5173"
supabase secrets set DAILY_COST_LIMIT_CNY=500
supabase secrets set COST_CNY_PER_CREDIT=0.047
supabase secrets set PROXY_TIMEOUT_MS=140000
supabase secrets set RATE_LIMIT_PER_USER_PER_MIN=10
supabase secrets set AGENT_GLOBAL_ACTIVE_LIMIT=100
supabase secrets set BOWERBIRD_CLOUD_MOCK=false
supabase secrets set GENERATION_WORKER_TOKEN=$GENERATION_WORKER_TOKEN
supabase secrets set UNDERSTAND_WORKER_TOKEN=$UNDERSTAND_WORKER_TOKEN
supabase secrets set AGENT_WORKER_TOKEN=$AGENT_WORKER_TOKEN
supabase secrets set VISUAL_PROFILE_WORKER_TOKEN=$VISUAL_PROFILE_WORKER_TOKEN
supabase secrets set BOWERBIRD_PAYMENT_MOCK=true
supabase secrets set SUPERUN_WEBHOOK_SECRET=$SUPERUN_WEBHOOK_SECRET
supabase secrets set WECHAT_APP_ID=$WECHAT_APP_ID
supabase secrets set WECHAT_APP_SECRET=$WECHAT_APP_SECRET
supabase secrets set WECHAT_REDIRECT_URI=$WECHAT_REDIRECT_URI
```

> ⚠️ 目前 `.env` 里 `BOWERBIRD_CLOUD_MOCK=false` 已开启真实方舟；`BOWERBIRD_PAYMENT_MOCK=true` 保持 Mock 支付，**不要**提前改 false。

### 4.0 Entitlement 非对称签名（P9：7 天离线 Pro 宽限）

```bash
# 1) 生成密钥对（脚本会输出 secrets set 命令与桌面构建公钥）
node apps/cloud/scripts/gen-entitlement-keypair.mjs

# 2) 私钥进 Edge Secret（值即脚本输出的 ENTITLEMENT_SIGNING_KEY=...）
supabase secrets set ENTITLEMENT_SIGNING_KEY=<base64 PKCS#8 DER>

# 3) 公钥进桌面构建：追加到 apps/cloud/.env(.local)（本地构建 build.rs 自动读取）
#    BOWERBIRD_ENTITLEMENT_PUBKEY=<base64 原始 32 字节>，官方构建则注入构建环境同名变量

# 4) 重新部署 entitlement（此后响应 signature_version=1 + Ed25519 签名）
supabase functions deploy entitlement
```

验收：桌面登录后 `entitlement.json` 缓存含非空 `signature`；断网重启 app，权益面板仍显示 Pro/Studio（Fresh/Grace），7 天后降级 free。未配置 Secret 时函数自动回落 `signature_version=0`（在线可信、无离线宽限），不会报错。轮换 = 换密钥对 + 同步换桌面内置公钥发版；旧签名验签失败自动降级，用户在线重同步即可。

`generation-worker` / `understand-worker` / `agent-worker` / `visual-profile-worker` 必须使用 `--no-verify-jwt` 部署，因为 VPS 使用专用 Worker Token 而不是用户 JWT；Function 内部会常量时间校验各自的 `GENERATION_WORKER_TOKEN` / `UNDERSTAND_WORKER_TOKEN` / `AGENT_WORKER_TOKEN` / `VISUAL_PROFILE_WORKER_TOKEN`。VPS 只持这些 Token、DeepSeek 与方舟 Key，绝不能持 Supabase secret/service-role。

`understand-proxy` 由 `UNDERSTAND_ASYNC` 控制双模式，当前部署保持 `true`。首次迁移时曾按函数 → VPS → 兼容桌面 → 开关的顺序上线；这不是更新现有部署时关闭开关的要求。同步理解 adapter 仍服务兼容模式及 Jev 补标签，必须保留；已无调用的 Edge 同步生图 adapter 已移除。

### 4.1 部署 VPS Worker（生图、理解、Agent、视觉规范四类消费者）

把 `apps/agent-worker/{Dockerfile.unified-harness-candidate,compose.generation.yml,src,scripts}` 部署到 `/opt/bowerbird/agent-worker`，把 `spikes/unified-agent-harness-u1/profiles/bowerbird-u1` 部署到 `/opt/bowerbird/dsh-profile`，并在首次安装时创建权限 `0600` 的 `.env.generation`。更新现有部署时保留服务器配置与已验收 test-only 闸门；下面关闭闸门的模板不能覆盖现役 env。仓库内 Compose 默认使用相对 Profile 路径；VPS 扁平目录必须通过同一 env 文件显式覆盖 build context：

```dotenv
GENERATION_CONTROL_URL=https://<project-ref>.supabase.co/functions/v1/generation-worker
GENERATION_WORKER_TOKEN=<与 Supabase Secret 完全一致的高熵随机值>
GENERATION_WORKER_ID=lighthouse-guangzhou-1
ARK_API_KEY=<方舟 Key>
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_IMAGE_MODEL=<Seedream Pro endpoint id（image_hd 与 image_fast 档共用 + 未知档兜底）>
ARK_IMAGE_MODEL_LITE=<Seedream Lite model id（image_lite 与遗留 image_sd 档；官方 Lite 即标准版 doubao-seedream-5-0-260128）>
ARK_IMAGE_SIZE=2K
BOWERBIRD_CLOUD_MOCK=false
GENERATION_POLL_INTERVAL_MS=2000
GENERATION_HEARTBEAT_INTERVAL_MS=30000
UNDERSTAND_CONTROL_URL=https://<project-ref>.supabase.co/functions/v1/understand-worker
UNDERSTAND_WORKER_TOKEN=<与 Supabase Secret 完全一致的高熵随机值>
UNDERSTAND_WORKER_ID=lighthouse-guangzhou-1
AGENT_CONTROL_URL=https://<project-ref>.supabase.co/functions/v1/agent-worker
AGENT_WORKER_TOKEN=<与对应 Edge Secret 一致的独立高熵随机值>
AGENT_WORKER_ID=lighthouse-guangzhou-1
AGENT_HEARTBEAT_INTERVAL_MS=20000
AGENT_WORKSPACE_ROOT=/workspaces
DEEPSEEK_API_KEY=<DeepSeek Key>
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
VISUAL_PROFILE_CONTROL_URL=https://<project-ref>.supabase.co/functions/v1/visual-profile-worker
VISUAL_PROFILE_WORKER_TOKEN=<与对应 Edge Secret 一致的独立高熵随机值>
VISUAL_PROFILE_WORKER_ID=lighthouse-guangzhou-1
ARK_VISION_MODEL=<豆包 Vision endpoint id>
ARK_REPLICATION_VIDEO_MODEL=doubao-seed-2-0-mini-260428
ARK_REPLICATION_TEXT_MODEL=doubao-seed-2-0-mini-260428
RENDERER_URL=http://html-renderer:3917
RENDER_INTERNAL_TOKEN=<与 html-renderer .env.renderer 完全一致的高熵随机值>
BOWERBIRD_DSH_BUILD_CONTEXT=/opt/bowerbird/dsh-profile
BOWERBIRD_CLOUD_SHARED_BUILD_CONTEXT=/opt/bowerbird/cloud-shared
BOWERBIRD_UNIFIED_AGENT_DSH_ENABLED=false
BOWERBIRD_CONTROLLED_IMAGE_EDIT_DSH_ENABLED=false
BOWERBIRD_DSH_MODEL=deepseek-flash
```

```bash
cd /opt/bowerbird/html-renderer
cp .env.renderer.example .env.renderer
chmod 600 .env.renderer
# 生成至少 32 字节随机 token，填入 .env.renderer；同一值也填入 agent-worker/.env.generation
sudo docker compose -f compose.renderer.yml up -d --build

cd /opt/bowerbird/agent-worker
sudo docker compose --env-file .env.generation -f compose.generation.yml up -d --build
sudo docker compose --env-file .env.generation -f compose.generation.yml ps
sudo docker compose --env-file .env.generation -f compose.generation.yml logs --tail 50
```

`html-renderer` 只连接 `internal: true` 的 `bowerbird-internal` 网络，无宿主端口和公网出口；Worker 同时连接默认出站网络与该内部网络，通过固定 `RENDERER_URL` 调用。先启动 renderer 创建内部网络，再启动 Worker。两个 env 文件中的 `RENDER_INTERNAL_TOKEN` 必须一致且权限为 `0600`，不得写入仓库或日志。

Worker 容器不映射入站端口、只读根文件系统、非 root、丢弃全部 capabilities，并限制 1536 MiB 内存、1.75 CPU、256 PID、256 MiB workspace tmpfs 与 10 MiB × 3 JSON 日志。容器入口为 `src/main.ts` 组合入口：按 `GENERATION_CONTROL_URL` / `UNDERSTAND_CONTROL_URL` / `AGENT_CONTROL_URL` / `VISUAL_PROFILE_CONTROL_URL` 是否配置分别启动生图、理解、Agent 与视觉规范四个消费循环，互不阻塞。方舟同步请求（生图与理解）不设置 120/135 秒主动终止；等待期间每 30 秒向 Bowerbird 控制面续租。Agent 循环每 10 分钟运行 TTL/orphan 清理并输出不含用户内容的控制面与磁盘健康指标；可在运维端运行 `node apps/cloud/scripts/check-agent-runtime-health.mjs` 做阈值探测。

视频 Worker 镜像安装 `ca-certificates` 与 `ffmpeg`（包含 `ffprobe`），并从 `cloud-shared` 构建上下文复制 `video-contract.ts`、`task-authorization.ts`、`layer-contract.ts`、`image-metadata.ts`、`replication.ts`、`bcoin-text.ts` 到 `/cloud/supabase/functions/_shared/`，保持源码跨包导入路径。VPS 上将仓库 `apps/cloud/supabase/functions/_shared/` 中这六个文件同步到 `/opt/bowerbird/cloud-shared/`；不得把包含 `.env` 的整个 Cloud 目录当作构建上下文。直接调用 `docker build` 时也要传 `--build-context cloud-shared=<上述目录>`。生产 `/tmp` 为有界 640 MiB，覆盖单个 500 MiB 视频探测文件；其他 CPU/内存/PID 限制不变。候选镜像需在无网络、只读根目录和可写 `/tmp` 下运行 `node /app/scripts/video-readonly-probe.mjs`，核验生产入口导入及真实合成 MP4 探测；加 `--max-size` 用合法 MP4 free box 检查 500 MiB 上限（采用 640 MiB /tmp 和原 1536 MiB 内存限制），不调用模型或替代真实下载/并发验收。视频上线同时需要 `0058` 迁移和 `generate-proxy` / `generation-worker`；迁移默认不启价，价格须另行确认。

### 5. 微信扫码登录（H5，备案域名 bowerbird.cn）

登录链路：桌面/官网 → 系统浏览器打开 `open.weixin.qq.com/connect/qrconnect`（appid/回调域由 `wechat-login` GET 按 Secrets 组装）→ 微信回调到备案域名静态中转页 [website/wechat-callback.html](../../website/wechat-callback.html)（VPS 直接伺服该静态文件）→ 按 `state` 前缀分流：`dt_` 跳 `bowerbird://wechat/callback` deep link 由桌面 Rust 校验后 POST 换会话；`web_` 中转页同源校验 sessionStorage 后自行 POST 换会话。`wechat-login` Function 用 service role `generateLink(magiclink)` 取得 `hashed_token` 与 GoTrue 返回的 `verification_type`，再调用 `/auth/v1/verify` 铸真实 GoTrue 会话（unionid→确定性合成邮箱建号，0070 后注册不再赠送 Bcoin）。

```bash
supabase functions deploy wechat-login --no-verify-jwt   # §4 的 secrets（H5 段）备好后执行
```

微信侧与 VPS 侧手工步骤：

1. 微信开放平台 → 网站应用 → 授权回调域填 `bowerbird.cn`（不带协议、不带路径）。
2. `wechat-callback.html` 随官网 `dist/` 一起部署（`WECHAT_REDIRECT_URI=https://bowerbird.cn/wechat-callback.html`）；与官网同源，nginx/官网 server.mjs 无需任何改动。
3. `ALLOWED_ORIGINS` 必须包含 `https://bowerbird.cn`（官网浏览器直调该函数走 CORS）。
4. Supabase Dashboard 无需改动：微信链路不经过 GoTrue redirect/邮件模板，会话由 service role 经 `generateLink`+`verify` 直接签发。

### 5.5 桌面账号官网网关（2026-10-22）

桌面账号传输入口为 `https://bowerbird.cn/api/account`。实现位于 `website/account-proxy.mjs`，由 `website/server.mjs` 挂载；桌面 `CloudConfig.account_api_url` 在官方构建中固定配置，测试配置为空时才使用测试 Supabase 地址。微信 GET/POST、邮件 OTP、PKCE/refresh token 交换、签名权益和兑换走此入口；生成、理解、分类及 Storage 仍使用各自现有 Cloud 路径。本次不改 Edge Function、SQL、计费或密钥。

- 严格开放上述方法和路径；邮箱验证仅 GET `/auth/v1/verify`，token grant 仅 `pkce` / `refresh_token`。上游从服务器公开配置读取，函数区域固定 `ap-northeast-1`，不接受客户端目标地址。官网仍只配置 publishable/anon key，不放 service role；权益和兑换原样转发用户 Bearer，由 Supabase 校验。
- 输入 64 KiB、输出 1 MiB，上游 20 秒超时；不跟随上游重定向、不自动重发授权码或刷新令牌、不转发 cookie。邮件验证只允许桌面 `bowerbird://auth/callback`、官网同源，以及原有开发 Site URL `http://localhost:3000`。返回的 state/code 保持完整，登录客户端继续执行 pending state / PKCE 校验。
- Nginx `/api/account/` 禁止 access/error 请求日志、缓存和 Referer 泄漏，限制上传及等待时间；Node 不记录请求正文、查询参数、用户令牌。网关错误只输出固定文案与错误码，桌面仍使用 `accountErrorMessage`。有效业务 JSON 字节保持，客户端继续使用原公钥验签权益。
- 按 IP 限制账号 120 次/分钟、邮件 5 次/10 分钟，最多 10,000 个内存桶；仅在 loopback 且显式信任代理时使用 Nginx 覆写的 `X-Real-IP`。Supabase 自身限流仍生效；不使用需要 secret key 的 `Sb-Forwarded-For`，故 Auth 上游也可能按 VPS 出口聚合限流。扩容时应单独评估，不能靠放宽鉴权解决。
- Supabase 的 magic link / confirmation 两个模板，仅将原 `ConfirmationURL` 链接改成官网 verify 路径，保留 `TokenHash`，type 分别 `magiclink` / `signup`，`RedirectTo` 经 Go 模板 `urlquery` 编码。原 Site URL、回调白名单保持；已发送的旧邮件仍是旧入口。管理 API 同时将 `mailer_templates_custom_contents` 中对应的自定义模板状态置 true；应核对内容和此派生状态，而不是忽略所有额外字段变化。

首轮网关发布目录 `/opt/bowerbird/website-releases/20261022-account-gateway`，此前目录 `20261022-windows-26.10.2202` 保留。`account-proxy.mjs` SHA-256 `1e0bcd8680bcc19d5d45e6efe7de02af248503772228496e01e078641e1cf49a`。服务器 `/tmp/bowerbird-account-gateway-20261022/` 保存部署/回滚脚本及 Nginx 原配置；本机 `.tmp/account-gateway-20261022/` 保存原邮箱模板、只读回查与链路报告。回滚模板须先逐字核对现值仍为本次内容，再只恢复这两个模板；最后回滚网关，避免已发新邮件失效。后续桌面发布会继承网关，不能只回退目录而遗忘仍在使用新路径的客户端。

验证：Node 网关 10 项和官网更新入口回归、Rust Cloud 44 项、TypeScript；候选/现役/公网二维码 HTTP 200、无效刷新 400、匿名权益 401、邮件验证 303；实际 Rust CloudClient 四项网关对照通过。独立临时账号经真实邮件验证（admin generateLink，不发邮件）、刷新和权益查询通过，Ed25519 验签成功，无效兑换被拒绝，账号已删除。真实 PKCE 邮件投递及另一台电脑的微信扫码完整回跳尚待实机确认，不能用这些测试声称原机已登录成功。

部署时曾因完整复制下载目录耗尽磁盘；已对本轮目录与上一版相同的 38 个不可变包逐字节核对，再原子共享硬链接，释放 1,149,724,089 bytes，所有下载路径保留。后续发布只对不可变安装包共享链接，配置、首页、更新 JSON 必须独立复制，避免修改现役或回滚清单。

### 5.6 ComfyUI TOS 安装授权（2026-10-23）

新增 `comfy-download` v1：平台 `verify_jwt=true`，函数再通过 `requireUser` 验证身份，实时读取订阅并允许有效 Pro／Studio 或 `app_metadata.bowerbird_test=true`。仅为 `_shared/comfy-download-manifest.json` 的六个固定资源签发 1 小时 GET URL，不接收自定义桶/主机/路径、不扣积分、不转发大文件。签名与原生清单交叉检查及官方 SDK 向量验证见 [本机 H3](../../dev-doc/COMFYUI-LOCAL-VIDEO.md#tos-安装下载接入2026-10-23服务已上线客户端待发布)。

Secrets 仅新增 `COMFY_TOS_ACCESS_KEY_ID`、`COMFY_TOS_SECRET_ACCESS_KEY`，从用户填写的根 `.env.tos` 安全导入，临时 env 文件已删除；不放进网页或桌面。Supabase Secrets 更新使既有 15 个函数版本号各加 1，原代码包 SHA/JWT 配置逐一相同，无其他函数源码、数据库迁移、价格或 Worker 部署。

官网 `/api/account/functions/v1/comfy-download` 仅 POST，经现有无日志、no-store、限流网关；10:16:15（北京时间）现役 `/opt/bowerbird/website-releases/20261023-comfy-tos`，前版 `/opt/bowerbird/website-releases/20261023-tos-distribution` 保留。唯一文件差异 `account-proxy.mjs`，SHA-256 `363bdde73b028bcaf90cb31dfb0af756abeab7955c61cf0b87f3eb2bd875a53e`；回滚时原子恢复前版 symlink 并重启 `bowerbird-website.service`，必要时另移除本次新函数及其专用 Secrets。不要还原其他函数或改桶 ACL。

代码、候选/现役/公网拒绝未授权、三平台更新保持、账号网关及 6 个对象真实签名 Range/匿名/过期拒绝已验证。自动审批阻止了临时生产账号写入验收，因此没有声称线上真实 Pro 登录至下载的完整链路通过；全新安装/GPU 和新客户端发布仍待完成。证据本机 `.tmp/tos-migration/comfy-*` 及 VPS `/tmp/bowerbird-comfy-tos/`。当前公开桌面包仍使用旧安装器，须发布包含新原生代码的版本。

### 5.7 生成与签名文件官网网关（2026-10-28，已部署，客户端待发布）

**后续客户端发布：** 2026-10-28 15:29:20（北京时间）Windows **26.10.2801** 已签名发布，源码 be4a3f11；generate-proxy、参考视频上传、图片／视频与分层包下载已包含官网网关路由。官网现役 `/opt/bowerbird/website-releases/20261028-windows-26.10.2801`，回滚 `/opt/bowerbird/website-releases/20261028-cloud-gateway`，Nginx 与生成／账号代理保留；无 Edge／Worker／价格／支付变更。原故障电脑完整生成和实际账单尚待用户更新后验收。包与发布证据见 [桌面自动更新](../../dev-doc/DESKTOP-UPDATES.md)。

`website/cloud-proxy.mjs` 由 `server.mjs` 挂载到 `/api/cloud/`；独立于账号入口，不放宽账号的 64 KiB 限制。桌面 `CloudConfig.endpoint("generate-proxy")` 使用现有官方账号配置的同源 `/api/cloud/functions/v1/generate-proxy`，其他函数保持原路由。`generation_transfer_url` 只接受原配置 Supabase 同源、HTTPS、私有生成桶的签名地址，再改为官网入口，保留原 token 查询字符串；账号网关配置为空的隔离测试仍使用测试上游。

- POST 只开放 `generate-proxy`，要求用户 Bearer、JSON 对象，最多 20 MiB；固定区域 `ap-northeast-1`，正文和正常业务 JSON 原样转发，响应 JSON 最多 1 MiB。Supabase 继续校验用户、任务归属、价格和预授权。共用该函数的图层任务也走此入口，其 JSON 文件走下述签名下载。
- PUT 只开放 `storage/v1/object/upload/sign/generation-temp/jobs/<UUID>/inputs/video-<index>.mp4|mov?token=...`，要求 MP4／QuickTime MIME 和精确 Content-Length，最多 200 MiB；GET 只开放相同桶下 `jobs/<UUID>/outputs/result.png|jpg|webp|mp4|json` 的签名路径。没有通用代理目标、任意对象或管理入口。
- 文件流式转发，不缓存在内存或磁盘；下载传输上限 500 MiB，桌面原有图片 20 MiB／视频 500 MiB／图层包 256 MiB 和大小／SHA-256 校验保持。签名由原 Storage 颁发，网关不签发凭据，不向 Storage 额外转发用户 Bearer／Cookie／API key。
- 上游仅取既有 `SUPABASE_URL` 和 publishable/anon key，不需要 service role。拒绝跳转，不自动重发任何请求；中断或超时保留原任务查询语义，不改变幂等键、上传完成确认或计费。请求总上限 180 秒，客户端断开即中止上游；每 IP 300 次/分钟、最多 10,000 个内存桶、全局最多 8 个在途请求。仅 loopback 加显式 `BOWERBIRD_TRUST_PROXY=1` 才接受被 Nginx 覆写的 X-Real-IP。

部署顺序：

1. 基于现役官网创建独立候选目录，复制 `server.mjs` 与 **`cloud-proxy.mjs`**，保留现役账号模块、配置、静态文件、安装包和更新清单；不要用旧本地整站覆盖现役。仅不可变下载包可共享硬链接。
2. 将 `website/deploy/cloud-gateway.nginx.conf` 合入官网 TLS server，保持 `/api/account/` 原配置。新入口 200 MiB 上限、关闭请求／响应缓存与缓冲、关闭重试及请求日志；Node 上游仍为 `127.0.0.1:4173`。候选及 `nginx -t` 通过后才原子切换并重启／重载。
3. 验证公网未登录生成 401、非法路径拒绝、健康检查及旧账号／三平台更新入口。使用独立测试会话验证原任务查询、签名上传下载；真实付费模型验收单独记录，不能用匿名 401 声称生成成功。
4. 网关在线验收后才发布包含新路由的桌面版本。旧桌面仍走旧生成路径；仅部署官网不能修复已安装旧包。客户端发布前可以完整回退官网候选；发布后必须保留新入口，除非同步回退所有受影响客户端，不回退数据库／账本／Worker。

验证：`node --test --test-timeout=10000 website/scripts/cloud-proxy.test.mjs website/scripts/account-proxy.test.mjs website/scripts/app-updater.test.mjs` 共 27 项通过；Rust `cloud::` 46 项、`commands::layers` 4 项通过。覆盖模拟 10054／超时不重发、原任务身份／业务错误保持、恶意目标与跳转拒绝、请求限额、真实 Node fetch 回环上传／下载、上游未完成即收到文件字节、客户端断开取消、并发上限、慢请求及账号／更新兼容。没有调用真实模型，也没有在故障电脑验证；官网网关及 Nginx 配置已上线，现役 Windows 包仍为 26.10.2401，客户端尚待发版。视频服务和价格继续保持既有关闭状态，不随此网关发布自动开启。


**2026-10-28 部署证据：** 北京时间 14:58 完成，现役官网为 `/opt/bowerbird/website-releases/20261028-cloud-gateway`，上一版 `20261025-admin-nickname` 保留。从现役复制，84 个原文件逐项保持，只有 `server.mjs` 改动并新增 `cloud-proxy.mjs`；不可变安装包共享硬链接，配置、首页、后台和更新清单保持独立原副本。现役环境保持 root 600，候选使用 sudo 启动，未放宽权限。Node 18.19.1 下 27 项回归通过；Nginx 配置检查、候选 4174／现役 4173／公网健康、二维码、匿名及无效用户生成鉴权、无效上传／下载签名拒绝、非法路由和三平台更新回归通过，页面／后台／清单哈希与部署前一致。临时候选已退出，官网服务 active。只读／拒绝请求没有创建生成任务或扣费；不能以此代替已登录原机生成验收。

`server.mjs` SHA-256：`97db617660fd78df2066757e7b1d80272ec995a193958b56a1388850adf77f21`；`cloud-proxy.mjs`：`375895f636e317659bc4ddfd0ae6d945341423a86e1d1abe740ec1a158623e0e`；原 `account-proxy.mjs` 仍为 `363bdde73b028bcaf90cb31dfb0af756abeab7955c61cf0b87f3eb2bd875a53e`。本机证据 `.tmp/cloud-gateway-20261028/`，服务器 `/tmp/bowerbird-cloud-gateway-20261028/` 保存候选／现役／公网报告、原 Nginx 配置与 `rollback.sh`。该脚本仅允许当前为本轮或原基线，恢复原目录和 Nginx 并重启／重载；客户端发布后不得直接撤销新入口。没有部署 Edge、Worker 或数据库迁移，没有修改视频开关／定价、账号配置、安装包或更新清单。发版对话接手时必须基于本轮现役目录，保留新的 `cloud-proxy.mjs` 与 Nginx 入口，不能用旧整站覆盖。

## 6. 验证

```bash
# 1. RLS/积分测试（需要本地 Node + Supabase CLI）
cd apps/cloud
supabase db reset
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/billing.sql
node scripts/test-billing.mjs
node scripts/test-payment.mjs
node --env-file=.env scripts/test-payment-webhook-smoke.mjs  # 本地有回调密钥时同时验证正确签名分支

# 2. Edge Functions 冒烟（需要本地 Deno + Supabase CLI）
supabase functions serve --env-file .env
# 另一个终端：
curl -H "Authorization: Bearer <测试用户 access token>" \
  "$SUPABASE_URL/functions/v1/entitlement?forceFunctionRegion=ap-northeast-1"

# 3. 真实注册 → 预授权 → 方舟出图 → 确认扣分 → 清理临时账号
# 会产生一次真实方舟费用；脚本从 .env 读取凭据，不输出 key。
$env:CLOUD_E2E_FUNCTION_REGION='ap-northeast-1'
node --env-file=.env scripts/test-cloud-e2e.mjs
Remove-Item Env:CLOUD_E2E_FUNCTION_REGION

# 4. VPS 异步链路（生图/理解，需 VPS Worker 已上线；UNDERSTAND_ASYNC 翻 true 后）
node scripts/test-generation-e2e.mjs basic     # 多参考图真实出图 + 失败回滚
node scripts/test-understand-e2e.mjs basic     # 真实 Vision 反推 + 失败回滚与免费额度回补
node scripts/test-understand-e2e.mjs guard     # 幂等重放 + 越权 404
node scripts/test-understand-e2e.mjs crash-create   # 配合 VPS 上 kill -9 Worker：输出 CRASH_JOB_ID
node scripts/test-understand-e2e.mjs crash-check <CRASH_JOB_ID>  # Worker 重启后验证 outcome_unknown 冻结

# 5. Agent 控制面（不调用模型、Vision 或生图；并发脚本只在 claimable Agent 队列为空时运行）
node --env-file=.env scripts/test-agent-clarification.mjs
node --env-file=.env scripts/test-agent-concurrent-claim.mjs
node --env-file=.env scripts/check-agent-runtime-health.mjs
```

## 7. 桌面端/官网真机验收

- 桌面端：构建前通过构建环境或 gitignored `apps/cloud/.env(.local)` 提供 `SUPABASE_URL` + publishable key；官方构建会将二者内置，用户设置不能修改。启动 app → 确认设置中 Bowerbird Cloud 显示“官方服务已配置” → 邮箱 Magic Link 登录 → 创作板选「Bowerbird Cloud」出图 → 查看积分扣减与流水。正式调用默认路由到东京 `ap-northeast-1`。
- 官网：把 `SUPABASE_URL` 与 `SUPABASE_PUBLISHABLE_KEY` 填到 `website/.env.local` 与 Render 环境变量，重启后登录验证共享积分。

## 支付（Mock）

`create-checkout` / `payment-webhook` 现役仍只提供 **Mock 契约**（验签、幂等、状态机）。2026-10-25 用户确认商户资质已完成，后续按微信支付直连实施，不再等待 superun。当前开关不是启用真实支付的实现；须先完成 [P7 技术接入与验收](../../dev-doc/ARCH-ADJUST-PLAN.md#p7--订阅与支付) 再开放购买。现有 `SUPERUN_WEBHOOK_SECRET` 只供旧 Mock 使用，不作为微信支付凭据，也不在本次研究中删除。

## 注意事项

- Supabase secret/service-role 与支付 secrets 只在 Edge Functions；方舟生图 Key 还会存在于受限 VPS Worker。桌面端只持构建期内置的 URL/publishable key，用户不能编辑。
- `DAILY_COST_LIMIT_CNY` 是上海自然日的全站预估成本上限；单次预估成本 = 预扣积分 × `COST_CNY_PER_CREDIT`（默认 ¥0.047）。`RATE_LIMIT_PER_USER_PER_MIN` 是同账号每分钟首次上游请求数；同一幂等键重放不重复占用额度，也不会重复提交上游。
- `BOWERBIRD_CLOUD_MOCK` 与 `BOWERBIRD_PAYMENT_MOCK` 是两个独立开关：前者控制算力，后者控制支付。
- 部署完成后请告诉我「已部署」，我会继续真机验收（登录 → 积分 → 生成 → 流水 → 扣费/回滚）。
