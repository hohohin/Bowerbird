-- Nickname is display/search metadata only. Auth UUID remains the account identity.
create or replace function public.admin_list_users(p_actor uuid, p_search text, p_filter text, p_page integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.assert_pro_code_admin(p_actor);
  if p_search is null or char_length(p_search) > 100 or p_filter is null
    or p_filter not in ('', 'test', 'regular') or p_page is null or p_page not between 0 and 100000 then
    raise exception 'invalid user filter' using errcode = '22023';
  end if;
  with accounts as (
    select id, email, created_at, last_sign_in_at, email_confirmed_at,
      case when jsonb_typeof(raw_user_meta_data->'nickname') = 'string'
        then nullif(btrim(raw_user_meta_data->>'nickname'), '') end as nickname,
      coalesce(raw_app_meta_data->'bowerbird_test' = 'true'::jsonb, false) as is_test_account,
      coalesce(raw_app_meta_data->'bowerbird_admin' = 'true'::jsonb, false) as is_admin
    from auth.users
  ), filtered as (
    select * from accounts
    where (p_search = '' or strpos(lower(coalesce(nickname, '')), lower(p_search)) > 0
      or strpos(lower(coalesce(email, '')), lower(p_search)) > 0
      or strpos(id::text, lower(p_search)) > 0)
      and (p_filter = '' or is_test_account = (p_filter = 'test'))
  ), paged as (
    select * from filtered order by created_at desc nulls last, id limit 50 offset p_page * 50
  )
  select jsonb_build_object('rows', coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc nulls last, id) from paged p), '[]'::jsonb),
    'total', (select count(*) from filtered), 'page', p_page) into v_result;
  return v_result;
end $$;

revoke all on function public.admin_list_users(uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.admin_list_users(uuid,text,text,integer) to service_role;
