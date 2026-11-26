# DSH · Cloud 对话

## 现行 v2 接口

- 桌面通过统一 Cloud 网关调用 `chat-proxy`。`quote` 以用户 JWT 查询 `dsh-cloud` 及 `dsh_vps_v2_available`，并声明可用工具字段。只有标记试用账号可新开免费轮次。
- `create` 携带 `dsh-vps-v2`、幂等键、`conversation_id`、本轮一条用户消息和当轮工具／技能配置。并行新建同一会话会被拒绝。独立工作流轮次使用新的 `t-` 会话 ID。客户端通过受控编译器完成建卡并走 `tool_result` 回执。
- `get` 按原用户、job ID 或幂等键读取。`cancel` 停止原任务。旧 completion 与 v1 新单返回 426，已受理任务按原协议查单或结算；取消或结果未知按原任务身份处理。
- `chat-worker` 校验专用 Worker Token 和租约。数据库派生账号隔离的会话键，Worker 按上次成功任务的原生快照续聊。持久会话卷只存原生会话状态，临时输入与输出沿私有 Storage 生命周期清理，账本与用量事实独立保存。[Worker](../agent-worker/README.md) · [Cloud 部署](DEPLOY.md)

## 测试期与正式计费

DSH · Cloud 当前处于 DSH 上云测试阶段，用户暂时免费使用。现行测试价为 **0 Bcoin**，上游模型费用由 Bowerbird 承担。

正式收费按实际消耗的 token 计算。一轮对话触发多次模型调用时，累计当轮各次调用的实际用量，再按适用费率结算。首版 1.60 倍系数已确认，单轮授权上限和启费时间待验收及确认。0094 和 0095 已上线。0096、配套 Edge 和 VPS Worker 已关闭态部署，线上仍按 0 Bcoin 试用。[部署回执](#2026-11-26-0096-关闭态部署)

## 实际 Token 到 Bcoin 的映射草案

2026-11-21 定价讨论。充值已核对 ¥1 = 20 Bcoin。按 DeepSeek 公布的人民币费率逐次计算，再乘 `20 × 平台系数` 折为 Bcoin。列出成本等值的 `1.00` 与含平台成本的 `1.60` 两种方案。`1.60` 参考现有 Cloud 视频采用的系数，DSH 费率需独立确定。每月 800 赠币若全部用于本方案，两个系数对应的供应商标价成本分别约 ¥40 和 ¥25。年付 12 次同样的赠币分别对应 ¥480 和 ¥300，应结合实际使用、支付费用与运维成本评估。现阶段测试价仍为 0 Bcoin。[现行 Bcoin 规则](../../dev-doc/Bowerbird定价方案v2-订阅积分制.md) · [DeepSeek 官方人民币价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

第七轮独立复审复核了数值，并建议正式收费首版采用 `1.60` 系数及固定用户费率。用户已确认 `1.60`。工程候选以公开峰时价为固定基准，同一费率版本全天执行。Flash 为每百万 token `1.28／64／256 Bcoin`，Pro 为 `9.60／288／864 Bcoin`，顺序均为缓存命中输入、未命中输入、输出。当前尚无自然用量样本用于加权。后续调价使用新费率版本。平台内部供应商对账记录实际时段。下表保留决策对照。[第七轮复审](https://gemini.google.com/u/1/app/7000ffa86b500fd5?pli=1&pageId=none)

| 模型与时段 | 1.00 倍命中／未命中／输出 | 1.60 倍命中／未命中／输出 |
| --- | ---: | ---: |
| Flash 高峰 | 0.80／40／160 | 1.28／64／256 |
| Flash 空闲 | 0.40／20／80 | 0.64／32／128 |
| Pro 高峰 | 6.00／180／540 | 9.60／288／864 |
| Pro 空闲 | 3.00／90／270 | 4.80／144／432 |

表内单位为每百万 token 的 Bcoin。每次只取 0095 已核实的缓存命中输入、未命中输入和输出，分别乘费率后合计。输入总量与缓存分类核对，只有一类缺失且另一类与总量可信时可取差值。输出已含推理 token，推理字段只供说明。一轮触发的多次模型调用含压缩和工具回合，按各次用量计入，同一调用身份只计一次。用户费率版本随建单冻结。后台按登记提交时间记录北京时间，供应商公开峰时为周一至周五 09:00–12:00 与 14:00–18:00，法定节假日除外。跨时段以实际供应商回执核对。[DeepSeek 用量字段](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/) · [峰谷定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

整数钱包兼容方案按 `10⁻⁹ Bcoin` 存精确费用及同账号 DSH 余数。结算事务锁定账号的 DSH 余数与账本，按轮次幂等地用 `floor(当时余数＋本轮费用)` 扣整币，剩余继续累计。明细列本轮费用、实际扣币和结转余数。每轮不设最低扣费，余数不随赠币的 30 天到期而清零，也不折现。按首版拟议费率，相同的 1,000 未命中输入和 300 输出，Flash 为 0.1408 Bcoin，Pro 为 0.5472 Bcoin。Flash 主调用和压缩调用分别使用 8,000／2,000／1,000 和 12,000／3,000／500，整轮为 0.7296，两轮依次扣 0、1，余 0.4592。已用整数算术复核。

建议已交付的轮次按已核实用量收费，用户主动停止只计已核实的调用，平台故障且未交付由平台承担。用量缺失、冲突、模型身份未能归类的部分在原任务保留期内待核，超期仍缺证时释放对应预授权。已确定部分仍须与该轮终态一致。退款按原轮精确费用冲销，用数学向下取整回算负差，返还整币须追溯实际整币扣款对应的积分批次。赠币沿用原到期日，已过期批次返还时不增加可用余额。算例为两轮各 0.6，第二轮扣 1 后余 0.2，冲销第一轮则返还 1、余 0.6，此处实际扣款来自第二轮。需验收并行轮次、旧回执重放、退款追溯和授权边界。

启费前需为客户端明确展示固定费率及该轮预授权上限。按 `ceil(该轮费用上限)` 冻结整币，涵盖任意小于 1 Bcoin 的结算时余数。并发轮次可能在建单与结算之间改变余数，因此上限不依赖建单时的余数。服务器在送出上游前检查已发生费用、待核风险和下一次调用的可验证最坏成本。结算在同一事务校验费用上限与实际冻结积分批次总额，然后才调用 `credit_confirm`。对账按轮次唯一结算回执核验，通用账本退回多冻积分也会产生 `confirm` 明细。270,300 组独立整数边界计算通过。现役 Cloud 建单和桌面能力判断只接收零价，需要配套升级后才可启费。免费试用旧轮次按原零价结束。[通用结算入口](supabase/migrations/0023_credit_confirm_full_allocation_refund.sql)

### 2026-11-21 按 Token 结算的工程候选

- 0096 初始目录为关闭。报价绑定账号适用范围和所选模型，桌面人工发送确认费率及预授权整币后，在建单前复核当前账号、模型、计价版本、整币上限、输出上限。原单按原键读取，费用用原任务 ID 读取。自动工作流无明确授权时拒绝付费提交。原生和网页模拟验证均通过。[桌面协议](../../apps/desktop/src-tauri/src/commands/local_chat.rs) · [Edge 报价与建单](supabase/functions/chat-proxy/index.ts)
- VPS 每次调用携带原任务 ID、租约、调用 ID、模型及实际发出的 `max_tokens`，取得数据库授权才请求固定官方上游，授权不明确时不重放。以官方组合上下文 1,048,576 为保守上限，最坏费用为「全未命中上下文 × 未命中单价＋允许输出 × 输出与未命中单价之差」。示例以单次 16,384 输出计算，Flash 至少需冻 71 Bcoin、Pro 312 Bcoin，实际按用量结算。该例仅说明一笔最坏风险，运营的整轮上限及输出限制尚待确认。钉版 DSH Pro 回环共 7 次普通、工具续调及压缩调用均逐次匹配并记录用量。43 项 Worker 定向回归与全量类型检查通过。[Worker 上游调用](../agent-worker/src/cloud-chat/dsh.ts) · [DeepSeek 接口上限](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
- 独立 PostgreSQL 18.7 按生产迁移顺序 0095→0094→0096，通过并行锁、超授权、实冻不足拒绝、原键重放、取消、过期和跨轮退款测试。两个实际 Edge handler 与该数据库组合验证了报价、建单、领取、授权、用量和唯一终态回执。用户在运行中停止且用量迟到时，按同一租约补报，完整回执在后续轮询结算。已登记的 `unknown` 如超期仍缺可信用量，按期限释放对应冻结。待核和终态费用可按原用户原任务查询。[0096 与结算](supabase/migrations/0096_chat_paid_billing.sql) · [隔离数据库用例](scripts/chat-paid-db.fixture.mjs)
- 当日 0096、配套付费 Edge／Worker 和桌面正式包均待部署，线上为 0 Bcoin。2026-11-21 01:58:28 对现役 0095 的只读聚合为零个模型调用及零个可比结算样本。原试用单按零价结算。最新发布按下方部署回执执行。
- 第八轮后，模型别名改由受控付费目录读取并按轮冻结。Flash 与 Pro 的配置不能混用。无效配置拒绝新付费报价，未知型号仍保留原 0095 回执，到期免收该调用。目录不向普通账号及匿名公开后台别名，报价与钱包回执也不携带该列表。真实 PostgreSQL 角色、目录轮换、旧单快照、未知回执及 Edge 组合复跑通过。02:26:46 生产只读聚合仍无自然用量。

### 0096 部署、放量与暂停

1. 部署前读回迁移履历，核对 0094／0095 和 0096 的应用状态、现役两个 Edge 的文件和 JWT 配置、VPS Worker 的镜像与挂载以及五类活动队列。确认 0096 与现用钱包、分镜交易和服务目录兼容。将候选差异叠到已核实的现役基线，保留并行发布的 Edge 和 Worker 改动。备份现役版本和配置。获批后定向应用 0096，在保持付费接单关闭的情况下依次发布 `chat-proxy`、`chat-worker` 和 VPS Worker。核对三张新增账务表的强制 RLS 和受限权限、两条付费目录初始不可报价、原零价轮次可查可停、Worker 控制面拒绝无效令牌。
2. 获批上限后，同一事务配置 `chat_paid_flash_v1` 与 `chat_paid_pro_v1` 的 `unit_cost`、`parameters.max_output_tokens` 和 `active`。保留 `pricing_version=20261121`、对应模型别名与已确认费率。事务内回读 `quote_chat_paid_turn`，两条报价均须可用，且版本、模型、整币预冻、输出上限与获批值一致。
3. 确认配套桌面可用，VPS Worker 具备受支持的 DeepSeek 上游地址和持久会话卷。启用 Edge 的 `CHAT_DSH_TOKEN_BILLING_WORKER_ENABLED` 和 VPS 的 `BOWERBIRD_DSH_TOKEN_BILLING` 后核对付费领取能力。先以 `CHAT_DSH_VPS_V2_TEST_ONLY=true`、`CHAT_DSH_TOKEN_BILLING_ENABLED=true` 开试点。此时仅 `app_metadata.bowerbird_test=true` 可新建付费轮次。旧客户端不能开新免费轮次，已受理原轮次按原价完成。验证核准的普通和 Pro 账号分别通过第 6 轮，核对 Flash／Pro 实耗、余数、主动停止、余额不足与回退。用 Pro 画板验收工作流的统一确认和多步执行。复核实账和日桶后，经批准将 `CHAT_DSH_VPS_V2_TEST_ONLY` 设为 `false` 开放其他账号。
4. 暂停时把 `CHAT_DSH_TOKEN_BILLING_ENABLED` 设为 `false`，同时把 `CHAT_DSH_VPS_V2_TEST_ONLY` 恢复为 `true`，将可能恢复的 0 Bcoin 试用报价限制在试用账号。暂停所有 v2 新单时，同时关闭 `CHAT_DSH_VPS_V2_ENABLED`。保持 `CHAT_ENABLED=true`，保留付费原键续传、查单、工具回执、取消和费用回执。若须拒绝仍运行旧环境的新付费请求，在单独事务将两条付费目录设为 `active=false`，核对两条报价关闭。已冻结轮次和结算使用各自快照。环境切换传播期间继续盘点新进入的订单和预冻。
5. 保持付费 Edge 和 VPS Worker 运行，直至已受理订单和待核费用有终态回执。按 `chat_completion_jobs.status` 监控 `uploading`、`queued`、`running`，并通过 `hold_id` 和 `job_id` 关联 `credit_holds`、`chat_paid_receipts` 检查未决账务。对照同账号 `chat_paid_accounts.carry_nano`、结算与退款流水。到期订单等待原 Worker 释放并读回。处理完所有未决账务后才退出付费领取。保留 0096 表、原回执和账本。

| 候选输出上限 | Flash 最低整币预冻／¥500 最多新轮 | Pro 最低整币预冻／¥500 最多新轮 |
| ---: | ---: | ---: |
| 16,384 | 71 Bcoin／225 | 312 Bcoin／51 |
| 32,768 | 74 Bcoin／216 | 321 Bcoin／49 |

上表按当天空桶、单一模型计算。新付费轮次按 `ceil(预冻 Bcoin × 1,000,000 ÷ 32)` 微元占用 `CHAT_DAILY_COST_LIMIT_CNY`，北京时间换日。已受理轮次取消或返还钱包预冻不会回补日桶，免费与付费轮次共用该桶。日预算按试点或全量的目标日轮次、模型比例和实际预冻值核定，另核对每账号默认每分钟 10 轮。最低预冻按一次最坏调用向上取整。以 16,384 输出为例，Flash 首次已核费用超过 0.745408 Bcoin 或 Pro 超过 0.572928 Bcoin 后，同一轮下一次等上限调用会超过最低预冻。试点须验证工具续调和上下文压缩，按实测确定整轮预冻。

下列只读查询有结果时继续保留付费领取和结算能力。

```sql
select j.status, h.status as hold_status, count(*) as jobs,
       min(j.content_expires_at) filter (where r.job_id is null) as first_unsettled_deadline
from public.chat_completion_jobs j
join public.credit_holds h on h.id = j.hold_id
left join public.chat_paid_receipts r on r.job_id = j.id
where j.paid_billing is not null
  and (j.status in ('uploading', 'queued', 'running') or r.job_id is null
       or h.status in ('held', 'pending_settlement'))
group by j.status, h.status;
```

### 2026-11-26 0096 关闭态部署

- 经用户确认定向应用 0096，规范 LF 正文 SHA-256 为 `d82380f86c66b46b40bb08a7a436c6213f9f61f235520692ed61722a914424c9`。已按包含 0104 的生产顺序隔离重放。事务与独立只读复核确认旧 98 条迁移记录逐条一致。三张付费表启用强制 RLS，七个付费 RPC 仅服务角色能执行。付费账号、调用授权和回执均为零。原 10 条 0095 用量、两项试点保护策略和分镜退款触发器均保留。
- 北京时间 13:22:43 读回 `chat-proxy` v20 和 `chat-worker` v14，均为 ACTIVE。Proxy JWT 继续开启，Worker 由专用令牌校验。两个包的十个运行文件与候选逐一匹配。付费接单与付费领取开关均未设置，Flash 与 Pro 目录停用。原有 7 个试用账号继续按 0 Bcoin、每日 5 轮受理，对话日预算为 ¥500。
- 北京时间 13:23:06 现役 VPS 切换至 `sha256:8ea827b1c1de29e567c0414e9eee62e4f7d0088687ebf25c5c4f1544a977c68c`。基于原镜像仅覆盖四个计量文件，在 VPS 断网通过 44 项回归。生产读回核对宿主与容器文件、配置和持久会话挂载，重启、OOM 和消费错误均为零。切换前后六类队列均为空。官网网关及直连的匿名报价和查单均返回 401，Worker 控制面接受有效令牌并拒绝无效令牌。部署烟测未提交真实模型调用或扣款。
- 本机发布回执位于 `.tmp/dsh-paid-release-20261126/`。关闭态回退可分别恢复已备份 Edge v19／v13 的源码包及 JWT 设置。先确认共用 Worker 六类队列为空，再用该目录 `worker.ps1 -Mode Restore` 恢复 `bowerbird/generation-worker:rollback-dsh-paid-20261126` 及四份宿主文件。保留 0096 和全部历史账本。启费仍须确认配套桌面包、整轮预冻、日预算和试点范围，并核对真实供应商账单。

## 逐次模型用量记录（0095 已部署）

- DSH v2 在发送上游前，用 Worker 专用令牌和当前任务租约登记调用 ID、请求模型和提交时间。压缩及工具回合沿同一代理登记。重复调用 ID 不再发送，应用和数据库各自执行既有的每轮 12 次限制。
- 观测需要最终 SSE 事件同时给出输入和输出 token，且同一响应内无冲突。可校验的缓存命中／未命中数、供应商返回的模型与请求编号一并记录。超长结果被拒绝显示时仍保留完整用量。HTTP 错误只记录状态。缺失、冲突、断流或取消没有完整证据时标记用量未知，Worker 中断只留下可能已提交的记录。均不填推测用量或零。
- 观测响应丢失时至多重送这份观测一次，由数据库按原调用拒绝冲突。取消与租约过期停止授权新调用。Worker 在授权返回后再次确认取消状态，授权等待期间取消时保留已登记的记录，并阻止发送上游。原租约仍可在任务 24 小时有效期内补报已登记调用。按提交瞬间的北京时间划分业务日，结果跨午夜也沿用原日。
- 用量表只在服务端可读，只有 Worker 控制面可经租约 RPC 写入。保留不含提示词和回复正文的用量与状态。旧任务可继续查原单、取回和结算，未记录逐次证据的历史不回填。既有成功轮次的汇总用量和 0 Bcoin 结算继续沿用。
- 配套顺序为单独应用 0095、部署 `chat-worker` Edge、切换带计量的 VPS Worker。0095 依赖 0089 的 v2 会话身份，可在 0094 之前应用。旧 Edge 未宣告支持时新 Worker 继续旧协议，旧 Worker 可读取新版领取响应。混合版本期间的真实用量须按对应调用证据核对。
- 本地验收覆盖原生 PostgreSQL 18.7 的并发、重放、权限、跨日和零额结算，Deno Edge 的 Worker 令牌和 RPC 协议，以及实际 DSH ACP 的默认 Flash、显式 Flash／Pro、压缩多次调用和观测回执重放。代理回归覆盖分片或冲突用量、取消后的零上游请求及既有 Agent 行为。模型响应用合成夹具提供。
- 2026-11-20 经用户批准部署，北京时间 23:41 数据库读回确认 0095、强制 RLS 和 Worker RPC 权限。`chat-worker` v8 升至 v9，三份源码与定向制品一致，错误令牌返回 401，`chat-proxy` 保持 v12。沿用现役镜像的四文件覆盖件在 VPS 断网容器通过实际 DSH ACP 合成测试。五类队列均为空后，于 23:42:58 切换至镜像 `sha256:5591562270ee809b13b912b5c3821e90a9155b2680e65b81cf38b91acc4ed8df`。宿主与容器文件、配置摘要和启动状态通过核验，保留 DSH 依赖和现役语音转录版本。
- 0095 当次生产读回时 0094 尚未应用，现行唯一启用的对话报价仍为 0 Bcoin。Worker 错误令牌返回 401，持有效令牌回报不存在的任务租约返回 409。部署后四个带启动事件的消费循环已启动，控制面错误、重启与 OOM 均为零。11 月 20 日 23:44:16、23:46:08、23:59:35 及 11 月 21 日 00:17:07、00:57:31 的只读采样均无自然对话用量及对应结算。隔离测试已验证逐次记录与零额流水，首条生产自然样本待观察。本次部署验收未主动发起模型请求。
- 回退先将组合 Worker 恢复到 `bowerbird/generation-worker:rollback-chat-metering-0095-20261120`。原镜像为 `f8ac9a4bb014…`，四份宿主源文件和脚本在 `/opt/bowerbird/deploy-backups/dsh-model-metering-0095-20261120/`。检查五类队列后运行该目录下的 `worker-release.sh restore`。如需回退 Edge，使用预检包 `edge-before` 中的 v8 源码按原配置重新部署。保留 0095 用量表和已记录的观测。生产读回与断网回执在 `.tmp/dsh-model-metering-0095-preflight/`。

<a id="对话日额度与成本分桶0094-候选待部署确认"></a>

## 对话日额度与成本分桶（0094 已上线）

**2026-11-21 已上线，免费限试用账号。** 用户确认后暂停 v2 新开。北京时间 02:05:42 事务提交 0094，迁移哈希 `4193a9b74b621c9530395dffc14164d71e25c0a6538f7f01ad81af1326f12541`。当日尚无对话预留，共用桶 2 笔、¥2.82 保持。目录仍是 0 Bcoin、每模型调用固定预留 ¥2，每账号每日 5 新轮。试用开关信任 Auth 的布尔标记，生产聚合为 7 个已标记账号。独立桶上限 ¥500，按每轮内部预留 ¥24 得全站最多 20 新轮，实际供应商费用另行按 Token 产生。

02:06:19 定向部署现役 v12 基线的 `chat-proxy` 候选。读取七份线上源码，全部匹配，复制到本机隔离并通过四项合成回归。管理面更新配置会提升函数版本。核验 `chat-worker` 的三份源码与 0095 部署版相同。02:09:27 恢复仅标记账号新开，现役 `chat-proxy` v16 ACTIVE、JWT=true，`chat-worker` v12 ACTIVE、JWT=false，复核三个目标环境值。公网匿名报价及按原键查询各返回 401。已有原单查询、取消和结算保持原入口。没有触发真实模型调用。0095 保持，0096 未应用，源端和数据库回执在仓库 `.tmp/dsh-admission-0094-preflight/`。紧急回退先关 v2 新开，保留分桶和原单，再定向恢复先前 Edge 制品。

### 上线前候选及历史检查

- DSH · Cloud 仍为 0 Bcoin。新对话从服务目录读取每账号每日可受理轮数 `free_turns_per_day`，候选为 5。以北京时间零点划分，服务端受理新轮并建立预留时计数，之后取消、上传失败或结果未知均保留当日计数。按原键重放、取回和取消均不新增计数。共用分钟限流继续执行。
- `CHAT_DAILY_COST_LIMIT_CNY` 仅控制对话成本桶，候选沿用原 500 元限额。每轮沿用 ¥2 × 12 次调用的固定内部预留，以当前预留约束推算全站每日最多 20 轮。5 轮的账号上限使单账号最多预留该桶默认值的约四分之一。供应商实际账单另行对账，两个上线额度须随部署配置确认。
- 0094 通过现有 hold 锁与入队事务同时应用账号日额度、共用分钟限制和对话成本上限。拒绝时回滚任务、hold 及计数。生成、视频、理解等既有用量调用仍读写 `system_usage_daily`，对话读写 `system_chat_usage_daily`。每账号总请求与成本统计保持合计，`usage_daily.chat_request_count` 独立记录对话次数。
- 部署前关闭 v2 新提交并等待已开始的创建请求退出，原任务 get、cancel 与 Worker 结算仍可用。以同一事务应用 0094，将当日可确认为对话的旧预留移进对话桶，同步账号用量。发现预留缺成本或共用桶无法对账时，迁移整体回滚，保持关闭 v2 新提交，核对数据后再试。随后部署配套 `chat-proxy` 并核对现役配置、已有原单和两个用量桶，确认新函数就绪才打开新单。无 Worker、桌面或网关发布依赖。
- 紧急回退关闭 v2 新提交并保留 0094 的用量状态，已有任务继续查询、取消和结算。若临时恢复旧 Edge，须保持新提交关闭，等待兼容 0094 的 Edge 恢复后再开放。

2026-11-20 第一轮复审确认了隔离逻辑。当前候选的 500 元 ÷ 24 元每轮预留仅支持 20 个新轮次，需要先确定本轮的开放范围。¥24 来自既有 12 次调用上限与固定每次预留，这个固定值与实际模型支出上限无对应保证。真实费用取决于模型、输入输出 token 与峰谷时段。0095 上线前的任务只记录成功轮的输入输出 token 合计，缺逐调用、未完成流和缓存证据。限量试用可沿用当前规则并明确受众。若开放到目标日轮数，需核定账单样本和日预算，再以每次模型调用为粒度预留与结算，保留无用量或结果未知的预留。 [DeepSeek 官方人民币计价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- 本地 PostgreSQL 18.7 应用 91 个既有迁移和 0094。从两个连接复核同账号不同会话并发、已入队旧单结算、原键重放、当天成本转移、归属缺失回滚以及对话和理解成本双向独立。使用不同时区的连接和前一日封顶记录验证北京时间换日后的独立桶。Deno 四项测试通过，包含独立环境配置与两种日限额响应。验证使用隔离数据库和模拟 HTTP，无真实模型调用。
- 0095 上线后再次只读核对，0094 和专用对话桶仍未生效。核对现役 `reserve_managed_usage` 与 0066 一致，隔离 PostgreSQL 复跑先 0095 再 0094。基于现役 `chat-proxy` v12 准备定向候选，保留六个共享依赖，Deno 四项验证通过。临时关闭 v2 建单时，已有请求仍可按原键或任务 ID 查询、取消和完成结算。账号日轮次与平台日成本上限可独立配置。两个上线值及开启范围仍待确认。
- 2026-11-21 补齐可选试用账号门控。`CHAT_DSH_VPS_V2_TEST_ONLY=true` 时，报价能力与新建 v2 请求均要求 Supabase Auth 的 `app_metadata.bowerbird_test` 为布尔 `true`。默认关闭，沿用现役登录账号范围。未获准账号发起或按原键重发 `create` 返回 403，现有任务可按键或 ID 查询、取消、提交已有工具回执和完成结算，结果保留期沿用原规则。仓库和基于现役 v12 的独立候选分别通过 4 项 Deno 回归，覆盖默认范围、不可由用户编辑的数据标记及原单行为。门控尚未启用。
- 钉版 DSH 的合成请求复核了 Flash、Pro、最大思考强度、建卡与压缩，普通请求 `max_tokens` 为 393,216，压缩为 8,192。假设直接按官方峰时标价、单选项、每次总上下文不超 1,048,576、输出不超 393,216、输入全冷，公开标价的 12 次普通调用计算值为 Flash 约 ¥53.48、Pro 约 ¥198.18。此处按钉版请求规格估算，当前代理未独立强制该输出值，尚无供应商实账样本。¥500 控制的是固定预留桶，单轮按 ¥24 预留。以上支持讨论免费试用范围及新轮数，实际支出上限需单独设计和验证。[DeepSeek 官方人民币计价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

## 历史协议与部署流水

以下记录包含切换前的报价、部署顺序和已退役协议。新单按本页开头的 v2 契约执行。

<details>
<summary>展开部署记录与旧协议</summary>

## 2026-11-18 续聊恢复修复已部署

北京时间 01:23，删除原生会话恢复后对不存在的 `agent.model.select` 的调用，模型选择沿用 `agents.resume` 的 `agentOptions`。配套 `chat-worker v8`、`chat-proxy v11` 区分输入读取失败与 DSH 启动／恢复失败。现役源码读回、原会话副本恢复及固定 DSH 多轮合成测试通过。无需更新桌面端；已失败原单保留终态。部署镜像、回退与验证边界见 [故障修复记录](../../project_logs/2026-11-18-dsh-chat-resume.md)。

## 2026-11-13 Agent 卡片运行回执

北京时间 13:15，生产 `chat-proxy` 从 v7 升至 v8，接受可选的 `run_status`（started、failed、unknown）。JWT 校验开启，重新下载的七份文件与候选逐字节一致。13:17 切换 VPS generation-worker 到 `sha256:394ad4f896f411a1a8406c2ebc12685a0dce92d161e1f32ce37ea0672596ec51`，镜像中已核对工具定义、提示词、回执解析三份文件。切换前在途执行数为零，切换后运行正常；已比对环境变量、挂载及资源限制。首次切换因按顺序比较环境变量列表触发回滚，改为完整条目排序比对后通过。候选断网 DSH 测试 9 项通过。

正式网关隔离账号验证了 v2 真实模型发出的 `runCard: "start"` 和触发卡到生成卡的连线。模拟桌面返回“已建卡、启动失败”，原单成功完成，助手准确报告启动失败。临时账号和请求对象已清理。线上测试没有提交图片生成；终端用户实际启动卡片需要包含本次启动桥的桌面版本。

本地 `.tmp/canvas-card-run-release/before/` 保存 v7 原包，`edge-live.json`、`worker-live.json`、`smoke.json` 保存现役核验。Worker 上保留旧镜像和 `/opt/bowerbird/deploy-backups/canvas-card-run-jIXsHydc/switch.py`，需回退时以 `rollback` 参数执行。

## 2026-11-13 11:36 只受理 DSH v2 新单

生产 `chat-proxy` 从 v6 升至 v7；`chat-worker` 保持 v6。报价的 provider 为 `dsh-cloud`，唯一接受新单的协议为 `dsh-vps-v2`。旧版普通 completion 和 DSH v1 创建新任务返回 HTTP 426，并提示更新 Bowerbird 桌面端。旧原单使用原账号、原幂等键与一致的输入哈希重放。旧任务按原协议领取和结算。此次只变更聊天网关，没有数据库迁移或 VPS 镜像切换。

正式网关使用隔离账号验证了两种旧请求在切换后拒新、没有新建任务与预授权；切换前受理的旧单按键取回与重放成功；新的 DSH v2 请求完成真实模型调用，可按原键重放，且服务端记录原生会话身份。线上回执位于 `.tmp/dsh-vps-native/sole-provider-evidence.json`。已核对现役函数与候选的七个文件；回滚基线为 `.tmp/cloud-provider-cutover/before/` 中的生产 v6。

## 2026-11-13 VPS DSH 原生会话控制面

`dsh-vps-v2` 的 create 接口接收 `conversation_id`、本轮唯一一条 `user` 消息及本轮工具／技能配置。Edge 用实际登录用户创建任务。PostgreSQL 将账号和对话 ID 派生为 Worker 私有会话标识，同时冻结上一个成功任务的 ID。进行中的同会话拒绝另开请求；重复提交原键返回原任务。不同账号即使传相同对话 ID，也会得到独立会话。自动流程每轮使用 `t-` 前缀的唯一 ID，后续请求不能复用。

2026-11-13 北京时间 09:30 在 `wpupyuurwmaeozyvkyuo` 定向部署 0088、0089 以及 `chat-worker` v4、`chat-proxy` v4。原 completion、v1 整轮与 v2 原生会话共存。旧 Worker 只能领取其支持的任务。关闭 `CHAT_DSH_VPS_V2_ENABLED` 可停止新建 v2，同时保留 get、cancel 和原任务结算。普通账号的 v2 可用性以经鉴权的 `quote.dsh_vps_v2_available` 为准，技能仍受原统一 Agent 门控。部署运行记录与候选文件哈希见 `.tmp/dsh-vps-native/edge/`。

09:31 下载两份生产 Edge 共 10 个源文件，逐字节匹配已测候选。生产 Worker 切换至 `sha256:b596d516af107046555d4638ccadb013c1028a72bc8b9454b41baec42b312be7` 并核验原生会话卷后，09:39 开放 DSH v1、v2，随后复核两项开关及 `CHAT_ENABLED` 的服务端摘要均对应 `true`。

## VPS DSH 整轮对话 v1 协议（2026-11-12）

桌面以 `engine: "dsh-vps-v1"` 创建一轮对话，在 `messages` 中发送公开的用户、助手历史和本轮用户输入。Cloud 以原聊天任务、幂等键和租约执行整轮。测试价仍为 0 Bcoin，每轮一次预授权，内部成本按最多 12 次模型调用预留。已有客户端省略 engine，继续使用原单次 completion 协议。

- `chat-proxy.quote` 返回 `dsh_vps_available` 及 `dsh_vps_skills_available`。前者需要聊天可用、零测试价和 `CHAT_DSH_VPS_ENABLED=true`。后者还要求统一 Agent 的服务器开关、测试账号标记和对应权益。创建时重新校验。本机仅提交文字编辑技能 ID，或 H3 技能 ID 和受限参数；技能由 VPS 加载。带技能的轮次关闭建卡工具。
- Worker 单独的 DSH 消费槽在 claim 声明同名 engine，只领取 DSH 整轮任务。原 completion 消费槽及旧版 Worker 继续领取单次 completion。Worker 的 `dsh_poll` 使用有效租约续租并取得轻量回执，`tool_request` 登记单个待办 `create_canvas_cards`。用户的 `get` 仅在租约及内容均有效时返回 `pending_tool: {id,name,arguments}`。桌面以原调用 ID 去重执行，将 `{success:true,created_count}` 或 `{success:false,error:"card_creation_failed"}` 通过 `tool_result` 回传。同 ID 的重复回执须相同。
- 用户按原任务 ID 或幂等键 `cancel`。排队或上传中的任务停止并退预授权，已领取的任务进入 `outcome_unknown` 并保留待核对的预授权。终态清除待办参数和回执。旧 completion 的取消和恢复规则沿用原接口。过期的租约不能发布工具请求、提交回执或续租。
- 部署依赖按顺序为 0088 定向迁移、两个聊天 Edge、能执行 VPS DSH 的 Worker、配套桌面端。先在功能开关关闭时验证旧任务兼容，再验证新 Worker 领取、工具回传、取消与原单取回，最后开放入口。回退先关闭 `CHAT_DSH_VPS_ENABLED`，保留新版 Worker 及 Edge 等待在途 DSH 任务结束。数据库迁移、已有任务和账本予以保留。

## 2026-11-11 聊天失败原因（候选已验证，待部署确认）

聊天 Worker 向 `chat-worker` 上报固定原因码，复用 `chat_completion_jobs.error_code` 保存。连接中断、超时、上游 HTTP 状态、无效 JSON、回复结构和工具参数分别记录。Worker 诊断只写任务编号、状态和原因码。4xx 仍走已拒绝结算，其他提交后无法确认的结果保留原预授权语义。

`chat-proxy` 对已结束且没有可取回回复的任务返回中文原因和 `error.recoverable=false`。新桌面端在会话详情展示原因、隐藏取回按钮，并让工作流结束该步骤。旧任务只按已知终态提示。中断时查询原任务仍可取回成功回复，查询得到终态后保存结论并保留已有文字。

两个 Edge 候选分别从现役 v3 下载后定向修改。VPS 隔离候选镜像为 `sha256:093e33788562ab84dbb02097ca9f52b0e9d23a6ba57d3ca9897fc44d09271a18`。部署范围为两个聊天 Edge 与 VPS 聊天 Worker，无数据库迁移。桌面改动需要新版客户端。候选哈希和验收证据在 `.tmp/chat-upstream-diagnostics/`。

## 2026-11-09 已部署：统一 Agent 卡片文本链路

新 Agent 卡片复用桌面对话服务；聊天 Edge／Worker／官网网关取消应用文字字节拦截，0084 删除 result_json 400000 字节约束并让 generation-temp 继承平台全局容量。128 条消息、工具闭集、模型参数、媒体校验、0 Bcoin 测试价和幂等／租约／TTL 保持现有契约。以下旧接口说明中的 300000 字节上限在线上已移除。

经用户明确确认，0084、chat-proxy／chat-worker v3、VPS 聊天 Worker 和官网网关已部署，2026-11-09 19:57:30（北京时间）核验通过。真实小对话、原请求取回、唯一零额结算通过；26,400,065 字节输入和 2,280,000 字节回复经公网完整往返，大文本采用隔离合成结果，未额外调用模型。RLS、计费、其他云函数与原用户任务状态保持；桌面源码已验证但未发布新安装包。具体范围、现役镜像和证据见[实施记录](../../project_logs/2026-11-09-agent-chat-unification.md)。

桌面保有 SQLite 对话历史、工具执行和画板事务。Cloud 仅完成一次受控 DeepSeek 文本请求；不启动 DSH、Agent Run、媒体生成或读取本地图片。固定提示词与 `create_canvas_cards` 定义位于 `supabase/functions/_shared/chat-instructions.txt`、`chat-card-tool.json`，Rust 与 Worker 共用；2026-11-12 起卡片项为单对象 + `kind` 枚举（不再用联合 `oneOf`），Rust 侧按 kind 丢弃跨类型字段。Worker 使用已有 `DeepSeekBackend.chat`，关闭 thinking、最多 8192 输出 tokens，不重试上游请求。

## 2026-11-07 上线记录

01:34:05（北京时间）完成官网真实对话验收。0077 已定向应用；chat-proxy／chat-worker v2 已部署，CHAT_ENABLED=true，向已登录用户开放。Worker 镜像 `8799ba09e5de45ed620b980f844f1ed8ee99c83cb5ee3bfb359206a1760b7b8e` 基于现役仅加入聊天增量；DeepSeek · Cloud 与 DSH · Cloud 共用此服务。现有 26.11.602 客户端无需重打包，平台 key 仍只在 VPS。

18 项线上检查通过，一次真实回复记录 521 输入／5 输出 tokens、唯一 confirm(0)，重放与原键查询未增加任务，余额保持；临时 Auth 已清理。0078 后补 0077 的兼容演练与线上定义回查确认既有计费／赠币不变；18 项 Worker 回归、Deno、候选断网导入及 7 份 Edge 文件读回通过。完整记录、全量 typecheck 的既有测试声明阻断和验证边界见 [行动记录](../../project_logs/2026-11-07-cloud-chat.md)，发布／回退详情见 [部署指引](DEPLOY.md#2026-11-07-cloud-对话已部署0-bcoin)。

## 旧 completion 接口

`chat-proxy` 使用用户 JWT；仅支持 POST：

- `action:quote` 返回 `provider,service,currency,unit_cost,pricing_version,available`。provider 为 `deepseek-cloud`，service 为 `chat_deepseek`。
- `action:create,idempotency_key,messages,tools_enabled?`：仅接受文本 `user/assistant/tool` 消息，128 条／300000 UTF-8 字节，工具回执必须匹配先前调用。禁止客户端指定 system、模型、工具定义及图片内容。
- `action:get` 携带 `job_id` 或 `idempotency_key`（二选一）；只查询当前用户原请求，不重新提交。

任务响应包含 `job_id,status,charge`；成功额外包含原生 `message`、`usage`、`model`。状态为 `uploading/queued/running/succeeded/failed/outcome_unknown`。消息含 `tool_calls` 时由桌面现有受控编译器执行，再把工具回执作为下一次 completion 输入。`tools_enabled=false` 用于纯聊；它不授予任何本机建卡权益。

## 旧 completion 计费、恢复和内容生命周期

- 0077 迁移创建测试价 **0 Bcoin** 服务。仍原子创建 `credit_holds`、预留用量、成功 `credit_confirm(0)`，零确认流水可审计。只放开 `chat_deepseek` 的零预授权，其他服务约束保留。
- 当前客户端契约只接受零测试价。服务端目录改为非零后，quote 不可用，新 create 拒绝。正式启价需要支持实际 token 用量结算，并补齐一轮内多次模型调用的预算确认。
- 每 completion 独立幂等身份；同身份同输入返回原任务，不同输入拒绝。未知上游／Worker 租约失效保留 `outcome_unknown` 和待结算 hold，不重排、不自动退款。用户可按原身份取回已有结果。
- 生产零价仍启用账号分钟频率与全局成本限制。目录 `provider_cost_reserve_micros=2000000` 为每次保守内部成本预留。真实 tokens 与模型身份作为独立元数据保留。独立对话桶见上方 0094 候选。
- 请求仅暂存私有 `generation-temp/chat/.../request.json`；Worker 使用 180 秒签名 URL 并核对 SHA-256。24 小时后删除请求对象与临时结果；持久保留任务身份、usage 和计费事实，本地已保存历史不受影响。未开始的过期任务退款，已提交但结果未知的任务保留待核对。

## 旧 completion 的初次上线顺序

1. 单独审核并应用 `0077_chat_completions.sql`；不要用无筛选 `db push` 顺带应用历史未批准迁移。
2. 部署 `chat-proxy`（JWT 校验）与 `chat-worker --no-verify-jwt`（函数内恒定时间校验专用 `CHAT_WORKER_TOKEN`）。`CHAT_ENABLED` 默认关闭。
3. VPS 现有组合 Worker 增加 `CHAT_CONTROL_URL=<Supabase functions/v1/chat-worker>` 与相同 `CHAT_WORKER_TOKEN`，复用已有 `DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL/DEEPSEEK_MODEL`。真实 key 继续只在 VPS；Edge 与桌面不持有。两份 Dockerfile 已复制共享协议及提示词，仍使用当前 Compose 的 `cloud-shared` build context。
4. 前后端配套、官网网关允许 `chat-proxy` 后，先完成候选离线和空队列检查，再将 Edge `CHAT_ENABLED=true`，立即验证真实文本 completion、原身份恢复与零额账本；失败先关闭开关并保留原任务。图片像素与付费价格仍不开放。
5. 回退时先 `CHAT_ENABLED=false` 拒绝新建，保留 get、Worker 与原队列完成能力；不得删除原 hold／usage 或让未知请求重新排队。

## 动作记录与验证

1. 先检查现有账本和 DeepSeek：发现零价被 hold 表约束挡住，现有模型代理仅在 VPS 本机，故复用单次模型 adapter 与组合 Worker，保留原凭据边界。
2. 先写行为测试并确认缺少协议／迁移失败，再实现输入边界、工具闭集、幂等队列、零价结算、对象 TTL。
3. 补未知传输、结算响应丢失、输入哈希不符与上传失败测试，确认不重复模型或卡片副作用。
4. 离线验证入口：`node apps/cloud/scripts/chat-db.test.mjs <PGlite dist/index.js>`；`node --test src/cloud-chat/runtime.test.ts src/providers/deepseek/backend.test.ts`（agent-worker）；`npm run typecheck`；`deno check .../chat-proxy/index.ts .../chat-worker/index.ts`。

以上为最初源码阶段记录；2026-11-07 已完成本文顶部记录的部署与一次真实模型验收。

</details>
