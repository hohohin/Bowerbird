-- Agent cards and the composer use the same chat service. Do not restore an
-- application text-size gate through that shared request/result path.
do $$
declare item record;
begin
  for item in select conname from pg_constraint
    where conrelid='public.chat_completion_jobs'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%octet_length((result_json)%'
  loop
    execute format('alter table public.chat_completion_jobs drop constraint %I',item.conname);
  end loop;
end $$;

-- All media upload endpoints retain their own media byte checks.
update storage.buckets set file_size_limit = null where id='generation-temp';
