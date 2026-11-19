# H3 文字结果完成结算修复

状态：源码与隔离数据库回归完成；用户明确回复“允许部署”后，0082 已于 2026-11-08 09:08:30（北京时间）定向部署，09:09:58 完成只读核验。

用户诊断的画板 runId 为 `76bc2d2a-400f-4edd-b1b0-dcbb2e22a48b`。按时间只读查询到云端 Run `21289b9b-036e-4dca-8ffa-fbb9c31eb092`，UTC 2026-11-07 18:26:49 创建、18:27:11 失败，错误 `agent_control_http_409`；前一条 18:19 的 Run 同样失败。该时间匹配尚未通过故障电脑本地记录直接关联。

云端已有 seq=10 `text.rewrite.started` 和 seq=90 `text.result`，后者包含 236 字结果。现役 `settle_agent_run` 仍为 0054 的产物判定，统一 Agent 必须有图片或 HTML，纯文字在最终结算被拒绝。Edge 将 SQL 55000 映射为 409，随后 Worker 把任务标失败。上次 Worker 隔离测试使用假的 control.finish，未覆盖数据库的真实产物门槛，因此不能作为完整成功链路证据。

0082 复用原原子结算函数，仅允许未审批图片计划、具有固定文字开始及结构正确且非空的已提交文字结果事件的统一 Agent 完成。图片／HTML 判定、租约、状态转换、实际 usage、预算、credit_confirm／credit_rollback 和权限保持。没有更改任务、账本或重新调用模型。

`apps/cloud/scripts/agent-text-settlement-db.test.mjs` 使用 PGlite 实际 SQL：先复现旧函数拒绝已保存文字，再验证文字成功、只调用一次计费入口、空值／错误 schema／多余字段／缺开始事件／已审批计划／错误及过期租约拒绝，原图片和 HTML、失败零用量及超预算保持。计费入口用记录调用的替身，未宣称真实账本或模型端到端验收。

已部署载荷：仅 `apps/cloud/supabase/migrations/0082_agent_text_settlement.sql`，并登记同名迁移；未执行 db push，未携带 0081 或其他工作区增量。事务先核对现役函数 MD5 与只读快照一致、0082 未占用，再替换函数。旧定义备份 `.tmp/h3-failure-20261108/settle-before.sql`；部署事务 `.tmp/h3-failure-20261108/deploy.sql`。回滚只恢复函数，不删除或重算历史账本。

自动审批明确拒绝本次生产数据库部署：缺少用户对此次结算／计费判定修改的明确授权。被拒命令未执行；旧任务仍保留失败状态。授权后只定向应用 0082，读回函数核验，旧失败任务不自动重提或重新结算。

随后用户明确授权，事务成功提交。读回完整函数正文与候选一致，0082 名称正确，authenticated 无执行权限、service_role 保持执行权限。两条原失败任务的 status／error／finished_at／actual_credits、hold 和 usage 快照部署前后完全一致；未提交模型请求。第一次读回比对因只规范化候选的 CRLF 而报告不匹配，规范化双方换行后复核一致，没有重复执行迁移。

证据：`.tmp/h3-failure-20261108/deploy.json`、`verified.json`、`verification-summary.json`、`tasks-before.json` 与 `tasks-after.json`。本轮只部署数据库函数，无 Worker／Edge／客户端发布；本次 409 的服务端修复无需客户端更新。真实付费完整优化未重跑，旧失败卡片不会自动变为成功。
