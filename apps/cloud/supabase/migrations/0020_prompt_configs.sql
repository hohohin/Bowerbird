-- Remote prompt configs: hardcoded desktop agent instructions (starting with the
-- generated-image autoname instruction) become cloud-editable rows. The desktop
-- pulls them with the entitlement snapshot (prompt_configs array, same pattern as
-- generation_services) and falls back to built-in defaults when a key is missing,
-- disabled, or the desktop is offline.
-- Editing = UPDATE a row in Supabase Studio; no edge function redeploy, no desktop
-- release. RLS denies all direct client access: only the service-role entitlement
-- function reads this table.

create table public.prompt_configs (
  key text primary key,
  value text not null,
  version integer not null default 1,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.prompt_configs enable row level security;
alter table public.prompt_configs force row level security;

-- Seed with the current built-in autoname instruction so the row is immediately
-- editable in Supabase Studio (same text as desktop NAME_ONLY_INSTRUCTION; once
-- seeded, the remote value is authoritative when enabled).
insert into public.prompt_configs (key, value) values (
  'understand_autoname',
  '请给这张图片取一个不超过 8 个字的中文名字。只回复名字本身，不要标点符号、不要描述、不要解释。'
);
