-- Private admin inventory and encrypted recovery for browser-issued vouchers.
create table public.pro_code_batches (
  id uuid primary key,
  label text not null check (char_length(label) between 1 and 80),
  code_count integer not null check (code_count between 1 and 1000),
  expires_at timestamptz not null,
  created_by uuid not null references public.billing_accounts(id),
  created_at timestamptz not null default now()
);
alter table public.pro_redemption_codes
  add column batch_id uuid references public.pro_code_batches(id),
  add column code_suffix text check (code_suffix ~ '^[0-9A-F]{8}$'),
  add column code_ciphertext text;
create index pro_codes_batch_idx on public.pro_redemption_codes(batch_id);
create index pro_codes_created_idx on public.pro_redemption_codes(created_at desc, id);

create table public.pro_code_admin_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.billing_accounts(id),
  action text not null check (action in ('issue', 'disable', 'reveal', 'export')),
  batch_id uuid references public.pro_code_batches(id),
  code_id uuid references public.pro_redemption_codes(id),
  created_at timestamptz not null default now()
);
alter table public.pro_code_batches enable row level security;
alter table public.pro_code_batches force row level security;
alter table public.pro_code_admin_events enable row level security;
alter table public.pro_code_admin_events force row level security;
revoke all on public.pro_code_batches, public.pro_code_admin_events from public, anon, authenticated;
grant all on public.pro_code_batches, public.pro_code_admin_events to service_role;

create function public.assert_pro_code_admin(p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from auth.users where id = p_actor
    and raw_app_meta_data->'bowerbird_admin' = 'true'::jsonb) then
    raise exception 'admin required' using errcode = '42501';
  end if;
end $$;

create function public.admin_issue_pro_codes(
  p_actor uuid, p_batch_id uuid, p_label text, p_expires_at timestamptz, p_codes jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_batch public.pro_code_batches; v_created boolean;
begin
  perform public.assert_pro_code_admin(p_actor);
  if jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) not between 1 and 1000
    or p_expires_at <= now() or p_expires_at > now() + interval '2 years'
    or p_label is null or char_length(btrim(p_label)) not between 1 and 80 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;
  insert into public.pro_code_batches(id,label,code_count,expires_at,created_by)
    values(p_batch_id,btrim(p_label),jsonb_array_length(p_codes),p_expires_at,p_actor)
    on conflict(id) do nothing returning * into v_batch;
  v_created := found;
  if not v_created then
    select * into strict v_batch from public.pro_code_batches where id=p_batch_id;
    if v_batch.created_by <> p_actor or v_batch.label <> btrim(p_label)
      or v_batch.code_count <> jsonb_array_length(p_codes) or v_batch.expires_at <> p_expires_at then
      raise exception 'batch request conflict' using errcode = '22023';
    end if;
  else
    if exists (select 1 from jsonb_array_elements(p_codes) c where
      c->>'id' is null or c->>'hash' is null or c->>'suffix' is null
      or c->>'ciphertext' is null or char_length(c->>'ciphertext') not between 50 and 500) then
      raise exception 'invalid code payload' using errcode = '22023';
    end if;
    insert into public.pro_redemption_codes(id,code_hash,expires_at,batch_id,code_suffix,code_ciphertext)
      select (c->>'id')::uuid,c->>'hash',p_expires_at,p_batch_id,c->>'suffix',c->>'ciphertext'
      from jsonb_array_elements(p_codes) c;
    insert into public.pro_code_admin_events(actor_id,action,batch_id) values(p_actor,'issue',p_batch_id);
  end if;
  return jsonb_build_object('batch_id',v_batch.id,'count',v_batch.code_count,'created',v_created);
end $$;

create view public.pro_code_admin_inventory as
select c.id,c.batch_id,coalesce(b.label,'脚本生成（旧批次）') as batch_label,c.code_suffix,
  c.created_at,c.expires_at,c.disabled_at,c.code_ciphertext is not null as can_reveal,
  r.user_id as redeemed_by,u.email as redeemed_email,r.redeemed_at,r.period_end,
  case when r.code_id is not null then 'redeemed' when c.disabled_at is not null then 'disabled'
    when c.expires_at <= now() then 'expired' else 'unused' end as status
from public.pro_redemption_codes c left join public.pro_code_batches b on b.id=c.batch_id
left join public.pro_code_redemptions r on r.code_id=c.id
left join public.billing_accounts a on a.id=r.user_id
left join auth.users u on u.id=a.auth_user_id;
revoke all on public.pro_code_admin_inventory from public,anon,authenticated;
grant select on public.pro_code_admin_inventory to service_role;

create function public.admin_list_pro_codes(
  p_actor uuid, p_status text default '', p_search text default '', p_batch_id uuid default null, p_page integer default 0
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb; v_total integer; v_stats jsonb; v_batches jsonb;
begin
  perform public.assert_pro_code_admin(p_actor);
  if p_status not in ('','unused','redeemed','disabled','expired') or p_page not between 0 and 100000
    or char_length(p_search) > 100 then raise exception 'invalid filter' using errcode='22023'; end if;
  select jsonb_build_object('total',count(*),'unused',count(*) filter(where status='unused'),
    'redeemed',count(*) filter(where status='redeemed'),'disabled',count(*) filter(where status='disabled'),
    'expired',count(*) filter(where status='expired')) into v_stats from public.pro_code_admin_inventory;
  select count(*) into v_total from public.pro_code_admin_inventory i where
    (p_status='' or i.status=p_status) and (p_batch_id is null or i.batch_id=p_batch_id)
    and (p_search='' or strpos(lower(i.batch_label),lower(p_search))>0
      or strpos(lower(coalesce(i.code_suffix,'')),lower(p_search))>0
      or strpos(lower(coalesce(i.redeemed_email,'')),lower(p_search))>0
      or strpos(coalesce(i.redeemed_by::text,''),p_search)>0);
  select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into v_rows from (
    select * from public.pro_code_admin_inventory i where
      (p_status='' or i.status=p_status) and (p_batch_id is null or i.batch_id=p_batch_id)
      and (p_search='' or strpos(lower(i.batch_label),lower(p_search))>0
        or strpos(lower(coalesce(i.code_suffix,'')),lower(p_search))>0
        or strpos(lower(coalesce(i.redeemed_email,'')),lower(p_search))>0
        or strpos(coalesce(i.redeemed_by::text,''),p_search)>0)
    order by i.created_at desc,i.id limit 50 offset p_page*50
  ) t;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into v_batches from (
    select id,label,code_count,created_at from public.pro_code_batches order by created_at desc,id limit 100
  ) t;
  return jsonb_build_object('stats',v_stats,'rows',v_rows,'total',v_total,'batches',v_batches,'page',p_page);
end $$;

create function public.admin_disable_pro_code(p_actor uuid,p_code_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code public.pro_redemption_codes;
begin
  perform public.assert_pro_code_admin(p_actor);
  select * into v_code from public.pro_redemption_codes where id=p_code_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if exists(select 1 from public.pro_code_redemptions where code_id=p_code_id) then
    return jsonb_build_object('status','already_redeemed');
  end if;
  if v_code.disabled_at is null then
    update public.pro_redemption_codes set disabled_at=now() where id=p_code_id;
    insert into public.pro_code_admin_events(actor_id,action,code_id,batch_id)
      values(p_actor,'disable',p_code_id,v_code.batch_id);
  end if;
  return jsonb_build_object('status','disabled');
end $$;

create function public.admin_read_pro_codes(p_actor uuid,p_batch_id uuid default null,p_code_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_codes jsonb;
begin
  perform public.assert_pro_code_admin(p_actor);
  if (p_batch_id is null) = (p_code_id is null) then raise exception 'one target required' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'ciphertext',c.code_ciphertext,
    'expires_at',c.expires_at,'batch_label',i.batch_label)),'[]'::jsonb) into v_codes
    from public.pro_redemption_codes c join public.pro_code_admin_inventory i on i.id=c.id
    where ((p_batch_id is not null and c.batch_id=p_batch_id) or c.id=p_code_id)
      and i.status='unused' and c.code_ciphertext is not null;
  if jsonb_array_length(v_codes)>0 then
    insert into public.pro_code_admin_events(actor_id,action,batch_id,code_id)
      values(p_actor,case when p_code_id is null then 'export' else 'reveal' end,p_batch_id,p_code_id);
  end if;
  return v_codes;
end $$;

revoke all on function public.assert_pro_code_admin(uuid) from public,anon,authenticated;
revoke all on function public.admin_issue_pro_codes(uuid,uuid,text,timestamptz,jsonb) from public,anon,authenticated;
revoke all on function public.admin_list_pro_codes(uuid,text,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.admin_disable_pro_code(uuid,uuid) from public,anon,authenticated;
revoke all on function public.admin_read_pro_codes(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.assert_pro_code_admin(uuid) to service_role;
grant execute on function public.admin_issue_pro_codes(uuid,uuid,text,timestamptz,jsonb) to service_role;
grant execute on function public.admin_list_pro_codes(uuid,text,text,uuid,integer) to service_role;
grant execute on function public.admin_disable_pro_code(uuid,uuid) to service_role;
grant execute on function public.admin_read_pro_codes(uuid,uuid,uuid) to service_role;
