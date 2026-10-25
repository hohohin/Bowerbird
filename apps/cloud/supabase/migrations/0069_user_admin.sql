-- Admin-only account directory and narrowly scoped test-access changes.
create table public.user_admin_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null,
  user_id uuid not null,
  previous_test_account boolean not null,
  is_test_account boolean not null,
  created_at timestamptz not null default now()
);
alter table public.user_admin_events enable row level security;
alter table public.user_admin_events force row level security;
revoke all on public.user_admin_events from public, anon, authenticated;
grant select, insert on public.user_admin_events to service_role;

create function public.admin_list_users(p_actor uuid, p_search text, p_filter text, p_page integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.assert_pro_code_admin(p_actor);
  if p_search is null or char_length(p_search) > 100 or p_filter is null
    or p_filter not in ('', 'test', 'regular') or p_page is null or p_page not between 0 and 100000 then
    raise exception 'invalid user filter' using errcode = '22023';
  end if;
  with filtered as (
    select id, email, created_at, last_sign_in_at, email_confirmed_at,
      coalesce(raw_app_meta_data->'bowerbird_test' = 'true'::jsonb, false) as is_test_account,
      coalesce(raw_app_meta_data->'bowerbird_admin' = 'true'::jsonb, false) as is_admin
    from auth.users
    where (p_search = '' or strpos(lower(coalesce(email, '')), lower(p_search)) > 0
      or strpos(id::text, lower(p_search)) > 0)
      and (p_filter = '' or coalesce(raw_app_meta_data->'bowerbird_test' = 'true'::jsonb, false) = (p_filter = 'test'))
  ), paged as (
    select * from filtered order by created_at desc nulls last, id limit 50 offset p_page * 50
  )
  select jsonb_build_object('rows', coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc nulls last, id) from paged p), '[]'::jsonb),
    'total', (select count(*) from filtered), 'page', p_page) into v_result;
  return v_result;
end $$;

create function public.admin_set_test_account(p_actor uuid, p_user_id uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_metadata jsonb; v_previous boolean;
begin
  perform public.assert_pro_code_admin(p_actor);
  if p_user_id is null or p_enabled is null then
    raise exception 'invalid test account request' using errcode = '22023';
  end if;
  select coalesce(raw_app_meta_data, '{}'::jsonb) into v_metadata from auth.users where id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  v_previous := coalesce(v_metadata->'bowerbird_test' = 'true'::jsonb, false);
  if v_previous <> p_enabled then
    update auth.users set raw_app_meta_data = case when p_enabled then
      v_metadata || '{"bowerbird_test":true}'::jsonb else v_metadata - 'bowerbird_test' end,
      updated_at = now() where id = p_user_id;
    insert into public.user_admin_events(actor_id, user_id, previous_test_account, is_test_account)
      values(p_actor, p_user_id, v_previous, p_enabled);
  end if;
  return jsonb_build_object('status', 'updated', 'user_id', p_user_id, 'is_test_account', p_enabled);
end $$;

revoke all on function public.admin_list_users(uuid,text,text,integer), public.admin_set_test_account(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.admin_list_users(uuid,text,text,integer), public.admin_set_test_account(uuid,uuid,boolean) to service_role;
