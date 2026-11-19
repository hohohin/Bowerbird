-- Agent card text results use the existing 20 MiB Agent object ceiling.
-- Other events retain their 16 KiB display-payload bound and object validation.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.agent_events'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%octet_length%'
      and pg_get_constraintdef(oid) like '%display_payload%'
  loop
    execute format('alter table public.agent_events drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.agent_events add constraint agent_events_display_payload_bytes_check
  check (octet_length(display_payload::text) <=
    case when type = 'text.result' then 20 * 1024 * 1024 else 16384 end);
