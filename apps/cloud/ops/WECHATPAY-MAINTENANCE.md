微信支付维护任务只调用 Cloud 的 `payment-reconcile`，财务处理仍由云端事务完成。

样例按 Node 22、`bowerbird` 系统用户及 `/opt/bowerbird/apps/cloud` 路径编写，安装前按服务器实际位置调整。独立环境文件 `/etc/bowerbird/wechatpay-maintenance.env` 仅需两个变量：

```dotenv
SUPABASE_URL=https://wpupyuurwmaeozyvkyuo.supabase.co
WECHAT_PAY_RECONCILE_TOKEN=填写与Cloud一致的32至256位随机字母数字或下划线短横线令牌
```

环境文件应为 root 所有、0600。此运行器不需要商户私钥、APIv3 密钥或 Supabase service role。不要将完整商户配置文件复制到该路径。

将四个 `.service` / `.timer` 样例放入 `/etc/systemd/system/`，审核路径和运行用户后执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now bowerbird-wechatpay-reconcile.timer bowerbird-wechatpay-bill.timer
```

订单补偿每分钟执行，失败一分钟后重试。日账北京时间 10:30 执行，失败五分钟后重试。两项服务失败或日志出现 `ok:false` 时应告警。长期未确认订单保留待确认，当前没有自动放弃或长周期退避。

## 停机多日后的日账补核

1. 以北京时间列出缺失日和历史差异日。先看 `systemctl list-timers 'bowerbird-wechatpay-*'` 和 `journalctl -u bowerbird-wechatpay-bill.service`，再由有账务权限的值班人员在私有环境核对 `wechatpay_bill_audits` 中当前商户及应用各日的 `checked_at`、`status` 和差异数。`Persistent=true` 恢复后只补一次触发，默认处理运行时的北京昨日。历史日期不会自动排队。若需要补昨天，按微信建议在北京时间 10:00 后获取。[微信支付下载账单](https://pay.wechatpay.cn/doc/v3/merchant/4013071238)
2. 逐日用同一 CLI 指定 `bill YYYY-MM-DD`。先在目标机核对 `systemctl show bowerbird-wechatpay-bill.service -p ExecStart -p WorkingDirectory -p EnvironmentFiles`，把下例的运行路径与环境文件替换为现役配置。由 systemd 读取 root 专用环境，使用隔离的动态用户执行。

   ```sh
   sudo systemd-run --wait --pipe --collect \
     -p DynamicUser=yes -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes \
     -p EnvironmentFile=/etc/bowerbird/wechatpay-maintenance.env \
     -p WorkingDirectory=/opt/bowerbird/apps/cloud \
     -p TimeoutStartSec=70 -p Type=oneshot \
     /usr/bin/node scripts/wechatpay-maintenance.mjs bill 2026-11-01
   ```

   使用本次实际缺失的北京账单日期，按日期逐一执行。[systemd-run 手册](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)
3. 每日留存一条脱敏回执，包括 `bill_date`、执行时间、退出码、`status`、`payment_count`、`refund_count`、`difference_count` 或固定错误码。退出码 0、`ok:true`、`status:"matched"` 和零差异均满足才可签收该日。重复同一日期会按日期、商户、应用更新同一审计行。微信退款账单记录受理事实，原退款终态仍由回执或原单查询确认。
4. `PAYMENT_BILL_NEEDS_ATTENTION`、其他非零结果和账单取不到都保留为待处理。记录受影响的日期及错误码，值班人员在受控后台按原订单与退款编号核对漏单、金额、时间及到账记录，通过既有补偿流程处理原单后再核对同一日。日账只写审计回执，不调整订单余额或退款。工单、例行告警与 MCP 快照只收脱敏摘要，原始账单、逐单差异、下载链接和凭据留在私有环境。

HTTP 失败摘要保留 `PAYMENT_WORKER_HTTP_ERROR`，并附固定 `summary.task`、校验后的整数 `summary.http_status`，以及日账模式下的北京时间 `summary.bill_date`。这些字段来自本轮已验证参数与 HTTP 状态行。诊断摘要的读取范围止于该处，响应头与正文留在原链路。该错误表示接口未返回成功响应，财务验收仍按上面的日账回执判定。

生产于 2026-11-13 启用两个 timer，并核验分钟补偿自然执行。11 月 17 日用户确认对账通过后开启公开购买。逐日补核已通过模拟上游回归，停机多日后的生产演练和主动告警送达仍待独立验收。[支付上线回执](../WECHATPAY.md#验证记录)

## 2026-11-20 HTTP 失败诊断上线

北京时间 22:21:40，经用户确认，仅原子替换 `/opt/bowerbird/wechatpay/wechatpay-maintenance.mjs` 的 HTTP 失败摘要分支。两项动态用户服务仍以 `/usr/bin/node` 读取同一路径。替换前后 SHA-256、`root:root` 及 `0644` 已核验，现役文件 `node --check` 通过。两 timer 仍处于 `active/waiting`，分钟补偿 `Result=success`。本轮使用既有自然重试观察日账回执。

22:21:50，自然重试记录 `ok:false`、`PAYMENT_WORKER_HTTP_ERROR`、`task=bill`、`bill_date=2026-11-19`、`http_status=502`。随后通过已授权的 Supabase 托管日志，在北京时间 22:21:40–22:22:00 窗口确认 `payment-reconcile` v2 在 22:21:50.390 返回 502。同一次 Edge 执行在 22:21:50.346 记录微信上游 HTTP 400。结合 v2 源码读回，失败发生在申请交易账单阶段。该时间段现役日志只记录 HTTP 状态，11 月 19 日账务仍待核对。微信支付文档列出的 HTTP 400 原因包含参数错误、无账单及账单生成中。[微信 Native 申请交易账单](https://pay.wechatpay.cn/doc/v3/merchant/4012791887#错误码)

- 现役 SHA-256 `0fbb6236a41d5b51d4b42e68e76d7f0aae328b48157cf89b5b1300ed8a96c6d2`。
- 回退文件 `/opt/bowerbird/deploy-backups/wechatpay-maintenance-http-diagnostics-20261120T142140Z-8ym2o6s5/wechatpay-maintenance.mjs.before`，SHA-256 `14e3b64dca341120350f4937189139983e67b06e257b31e2c9aa093934f2968f`。
- 回退时核对现役哈希仍为本次版本，按原属主和权限复制回退文件到同目录临时 `.mjs`，两份哈希一致且 Node 语法检查通过后原子重命名覆盖原路径。用下次自然运行核验恢复结果。

### 2026-11-20 Edge 账单申请错误码上线

北京时间 23:17:02，经用户确认，定向发布 `payment-reconcile` v3。变更只在申请交易账单失败处增加 `wechatpay_bill_failed`、`request_manifest` 阶段、Bowerbird 错误分类和微信官方错误码白名单，未知码收为 `unclassified`。失败仍按原错误返回。34 项无网络 Deno 回归、Edge 入口类型检查通过。

部署前读回和备份现役 v2，逐文件核对八份源码。部署后 v3 为 `ACTIVE`，`verify_jwt=false` 保持，函数内独立维护令牌校验沿用原实现。现役下载与候选八个文件的哈希全部一致，只有 `_shared/wechatpay-bill.ts` 与 v2 有差异，其 SHA-256 从 `63a7e935071dd9d95c11e2b86dd17f7537530c1329ba5888b32d54fc6fb9e3f4` 变为 `8a784dfe30457ceef1672e6914f5e6caa94835cad1dda0eab78ab3724bf2b50b`。现役 `_shared/limits.ts` 和其他六个依赖逐字节保持。

23:17:27.685，自然重试的 v3 关联日志记录 `request_manifest`、`upstream_failed`、微信 `NO_STATEMENT_EXIST`，Edge 返回 HTTP 502。按微信 Native API v3，此码表示对应账单文件不存在，须在受控环境核对该商户在对应日期是否发生交易或退款。11 月 19 日日账仍待核对，错误码只用于判断下一步处置。[微信 Native 申请交易账单](https://pay.wechatpay.cn/doc/v3/merchant/4012791887#错误码)

回退包位于 `.tmp/wechatpay-reconcile-manifest-diagnostics-20261120/predeploy-live-v2`，v3 读回位于同目录的 `verified-live-v3`。如需回退，先核对现役仍为本次 v3 和上述哈希，经用户确认后从 `predeploy-live-v2` 定向部署 `payment-reconcile`，保留 `--no-verify-jwt`。回退部署会生成新的版本号，验收以 v2 包八个文件逐字节一致、目标 JWT 和自然任务回执为准。

### 2026-11-20 `NO_STATEMENT_EXIST` 空账修复

生产只读统计分别以当前 `WECHAT_PAY_MCH_ID` 和唯一配置的 Bowerbird 支付 `WECHAT_PAY_APP_ID` 作作用域，并核对两项与线上配置的 SHA-256 一致、RLS 未过滤账行。目标北京时间为 11 月 19 日 00:00（含）至 11 月 20 日 00:00（不含）。该范围内支付、退款和已有日账审计各 0 条。该商户/App 无成功但缺官方付款时间、已有退款编号但缺官方创建时间、仍可能落入目标日的未决付款或未决退款，各 0 条。微信的交易账单面向商户，统计仅证明 Bowerbird 当前支付 App 的本地证据。[微信 Native 申请交易账单](https://pay.wechatpay.cn/doc/v3/merchant/4012791887#错误码)

候选仅在账单申请返回 HTTP 400 且错误码精确为 `NO_STATEMENT_EXIST` 时检查空账，限制在微信支持的三个月及目标日次日上午 10:00 起。先查原待确定付款和退款，再查缺少官方时间的记录，最后查目标日期实际支付和退款，覆盖原状态在检查期间获得官方时间的情况。任一计数非零或不可核验，日账继续失败。`STATEMENT_CREATING` 等其他错误沿用原处理。

计数均为零时按日期、商户、App 唯一键尝试写入 `matched`。库内 `hash_value=NO_STATEMENT_EXIST` 是无文件标记，`report.source=upstream_no_statement_local_empty` 记录微信未签名的无文件应答与本地空账的组合证据。只插入缺失键，冲突时保留真实账单和差异，并读取实际保存的账行给出结果。有效签名账单可在后续正规下载流程替换无文件标记。VPS 沿用 `matched` 和零差异的成功判定，审计行及 Edge 回执携带来源供复核。

35 项无网络 Deno 回归和 Edge 入口类型检查通过，覆盖空账、付款或退款、查询故障、时间窗口、非目标错误码、阶段间出现日期记录及并发旧签名账单。现有 VPS 维护与巡检 12 项 Node 回归通过。

北京时间 23:39:12，经用户确认，定向发布 `payment-reconcile` v4。部署前保存现役 v3 八文件，部署后 v4 为 `ACTIVE`，`verify_jwt=false` 和函数内维护令牌校验保持。现役读回八文件与候选逐字节一致，唯一改动 `_shared/wechatpay-bill.ts` 的 SHA-256 为 `af174b9de0bc24d22c79ca3f40647aa83af6d447f4734a7e1f5a8992a43f21e2`，其余七个文件保留 v3 原样。此次沿用既有表和 VPS 维护脚本。

23:42:44，既有日账服务自然重试，返回 `ok:true`、`bill_date=2026-11-19`、`status=matched`，支付 0、退款 0、差异 0。随后用现役商户/App 的只读聚合确认该键恰有一条审计行，保存时间晚于 v4 发布。该行状态为 `matched`，无文件标记、`source=upstream_no_statement_local_empty`、固定上游码和三项零计数均通过，目标键在部署前没有审计记录。人工补账未触发。11 月 19 日按空账规则签收。

v3 回退包 `.tmp/wechatpay-reconcile-no-statement-20261120/predeploy-live-v3`，v4 读回位于同目录 `verified-live-v4`。需要回退时先核对现役版本及文件哈希，再经用户确认从 v3 包定向部署 `payment-reconcile --no-verify-jwt`。通过下载后八文件哈希、JWT 状态及自然维护回执核验回退。保留已经写入的日账审计和财务记录。
