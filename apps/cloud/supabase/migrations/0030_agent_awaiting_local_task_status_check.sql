-- 修复 0028 的遗漏：agent_runs.status 列级 CHECK 约束没有随 transition_allowed
-- 函数一起加入 'awaiting_local_task'。症状：即梦 Run 执行到 40%（首个生图步骤停车）
-- 时 local_task_await 的 transition_agent_run UPDATE 违反 CHECK（23514，非 55000），
-- Edge 映射为 500，Worker 以 agent_control_http_500 结算失败。
-- 函数与约束是两套枚举：以后加状态必须两处同步。

alter table public.agent_runs
  drop constraint agent_runs_status_check;

alter table public.agent_runs
  add constraint agent_runs_status_check
  check (status in (
    'uploading', 'queued', 'leased', 'running',
    'awaiting_clarification', 'awaiting_approval', 'awaiting_result_feedback',
    'awaiting_local_task',
    'exporting', 'cancel_requested', 'cancelled', 'succeeded', 'failed'
  ));
