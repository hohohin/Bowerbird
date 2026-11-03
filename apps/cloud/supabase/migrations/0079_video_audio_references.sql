-- Seedance 2.5: 30 images + 10 videos + 10 audio references. No pricing changes.
alter table public.generation_jobs drop constraint generation_jobs_input_count_check;
alter table public.generation_jobs add constraint generation_jobs_input_count_check
  check (input_count between 0 and 50);

update storage.buckets set allowed_mime_types = case
  when allowed_mime_types is null then null
  else array(select distinct mime from unnest(allowed_mime_types || array['audio/mpeg', 'audio/wav']) as mime)
end where id = 'generation-temp';
