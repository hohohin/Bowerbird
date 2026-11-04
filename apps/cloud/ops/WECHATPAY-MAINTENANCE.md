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

订单补偿每分钟执行，失败一分钟后重试；日账北京时间 10:30 执行，失败五分钟后重试。`Persistent=true` 会在机器恢复后补一次错过的触发。日账默认核对执行时的北京昨日，没有历史日期队列；停机多日或失败跨日，需要逐日手动补账：

```sh
node --env-file=/etc/bowerbird/wechatpay-maintenance.env /opt/bowerbird/apps/cloud/scripts/wechatpay-maintenance.mjs bill 2026-11-01
```

日志仅包含任务种类、日期、计数和固定错误码。`failed>0` 或账单差异会返回非零状态；上线时须把两项服务的失败及日志中的 `ok:false` 接入现有运维告警，持续重试不等于问题已解决。长期未确认订单仍保留待确认，当前没有自动放弃或长周期退避。

检查：`systemctl list-timers 'bowerbird-wechatpay-*'`；`journalctl -u bowerbird-wechatpay-reconcile -u bowerbird-wechatpay-bill`。样例尚未部署或在目标 Linux systemd 上验证。
