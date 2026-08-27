-- 0044 — HTML 离线排版（HTML-RENDER-PLAN H2-T5）：agent_artifacts 新角色 + 单 call 多输出
--
-- 1) role CHECK 扩展：html_document / render_manifest / viewport_screenshot /
--    full_page_screenshot / slice_screenshot（§4.4）。
-- 2) 仅对 render_html 的多输出角色放宽 (run_id, source_call_id) 唯一性；其余角色继续
--    保持一个 call 最多一个 artifact。表级 (run_id, object_key) UNIQUE 已负责多输出幂等。
-- 3) usage CHECK 扩展：kind=html_render、provider=renderer。

alter table public.agent_artifacts
  drop constraint if exists agent_artifacts_role_check;

alter table public.agent_artifacts
  add constraint agent_artifacts_role_check check (role in (
    'input', 'control_reference', 'stage_result', 'final_result', 'plan', 'diagnostic',
    'html_document', 'render_manifest', 'viewport_screenshot', 'full_page_screenshot', 'slice_screenshot'
  ));

drop index if exists agent_artifacts_run_source_call_idx;

create unique index agent_artifacts_run_source_call_idx
  on public.agent_artifacts (run_id, source_call_id)
  where source_call_id is not null
    and role not in ('render_manifest', 'viewport_screenshot', 'full_page_screenshot', 'slice_screenshot');

alter table public.agent_usage_items
  drop constraint if exists agent_usage_items_kind_check;

alter table public.agent_usage_items
  add constraint agent_usage_items_kind_check
  check (kind in ('model_tokens', 'vision_call', 'image_generation', 'html_render'));

alter table public.agent_usage_items
  drop constraint if exists agent_usage_items_provider_check;

alter table public.agent_usage_items
  add constraint agent_usage_items_provider_check
  check (provider in ('deepseek', 'ark', 'jimeng', 'codex', 'renderer'));

comment on constraint agent_usage_items_provider_check on public.agent_usage_items is
  'Trusted Agent usage supports managed providers, desktop Jimeng/Codex calls, and zero-credit offline renderer calls.';
