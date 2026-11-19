-- Legacy desktop OCR reads understand_jobs through PostgREST using its user's JWT.
-- Keep the existing own-account policy; additionally hide uncleared result bodies
-- past the deadline. Rows without a body remain available for status lookups.
create policy understand_jobs_result_deadline on public.understand_jobs
  as restrictive for select to authenticated
  using (result_text is null or (deleted_at is null and content_expires_at > statement_timestamp()));

create policy visual_profile_jobs_result_deadline on public.visual_profile_jobs
  as restrictive for select to authenticated
  using (result_text is null or (deleted_at is null and content_expires_at > statement_timestamp()));
