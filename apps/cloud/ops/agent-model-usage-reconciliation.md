## 受控 DeepSeek 用量待核与结算恢复（0091）

`agent-worker` 和 `agent-run` 使用原 `settle_agent_run`、`cancel_unleased_agent_run`、`fail_unleased_agent_run`。Worker 对原 `runId/callId` 的临时用量写入失败最多重试一次。连续失败时，工具完成记录保存已观测的输入、输出单位。已结束但用量缺失的直连调用保留冻结额，`agent_runs.actual_credits` 为 NULL。现有未标记历史记录保持原合同。供应商明确拒绝或确认派发前停止的调用照常退款。

**发布顺序。** 先在单一事务应用 `0091_agent_model_usage_settlement.sql`，再发布两个 Edge，最后发布含直连提交标识的 Worker，并与派发前取消/HTTP 拒绝分类的 Worker 修复一起验证。每次切换前保存正在运行的 Edge、Worker 版本及 0082/0043/0028/0033/0012 对应的六个 SQL 函数定义。切换后检查新准备的两种受控 Skill 是否按模型绑定，并核对一次已知入账与终态结果。禁止把 `model_turn` 的历史行批量追记。旧 `prepared` 仅在同一模型适配器恢复、且派发前全部身份匹配时原子绑定。

**待核工作。** 使用现有服务角色的数据库管理入口筛选未决项。核对来源可为原 `source_call_id` 的诊断结果、供应商回执或对账单；凭据引用仅使用不含用户内容的工单编号。保留现有人工核对政策。到达内容过期时间不会自动决定收费或退款。

```sql
select r.id as run_id, c.call_id, c.status, c.safe_error_code, c.pending_model_usage,
       c.direct_deepseek_v1_model, c.provider_request_id, r.pricing_version, r.hold_id
from public.agent_runs r
join public.credit_holds h on h.id = r.hold_id
join public.agent_tool_calls c on c.run_id = r.id
where r.status in ('succeeded','failed','cancelled') and r.actual_credits is null
  and h.status = 'pending_settlement' and c.direct_deepseek_v1_model is not null
  and c.status <> 'prepared' and c.model_review_ref is null
  and not (c.status = 'failed' and coalesce(c.safe_error_code,'') in ('deepseek_http_error','deepseek_not_dispatched'))
  and not exists (select from public.agent_usage_items u where u.run_id=c.run_id and u.call_id=c.call_id);
```

每次补记在服务角色下执行 `public.reconcile_agent_model_usage(run_id, call_id, evidence_ref, action, input_units, output_units)`。按原始调用一个一个核对：

| action | 使用条件 | 单位 |
|---|---|---|
| `recorded` | 恢复已保存的确切用量，或有实际派发证据并与现有最低量政策一致的暂估 | 两列均传 NULL |
| `receipt` | 已取得确切供应商回执，优先按真实 token 数补记 | 两列分别传确认的非负整数 |
| `no_charge` | 已有明确未派发或拒绝的凭据，与已知确切用量无冲突 | 两列均传 NULL |

相同工单、同一调用和相同证据可重试。返回 NULL 表示该 Run 仍有其他待核调用。所有调用确定后，返回最终积分，使用 Run 锁定的 `agent_usage_vN`；对应历史版本即使停用也能对账。超预算或历史费率缺失时事务回滚，进入人工核对，无自动额外扣款。

**回退。** 暂停接新直连 Run，留当前 Worker、Edge 和 SQL 让已标记调用完成；继续用上述查询清理待核账。确定没有活跃已标记 Run 和待核额后，切回原 Worker。兼容性回退可保留 0091 及两个 Edge 的只读兼容字段以维护历史账；需要回滚 Edge 时再切回保留的原版本。紧急情况下可先停新 Worker 并保留 SQL 与受权对账入口。只有在集成确认没有活跃或待核项之后才可恢复此前六个函数；保留历史流水、核对引用及已标记行，避免删除已发生成本的证据。

隔离验收通过 `node apps/cloud/scripts/agent-model-usage-settlement-db.test.mjs [本机 embedded-postgres 入口路径]`。脚本使用随机端口、临时 PostgreSQL、真实冻结额与流水，以及两个独立连接。
