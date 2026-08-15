-- Bowerbird Agent Runtime A1-T2: private, short-TTL agent-temp object storage.
-- Desktop uploads run inputs via Edge-signed URLs; Worker reads/writes via signed URLs.
-- No public access; authenticated role gets no storage policies — all access is
-- brokered by Edge Functions with the service client.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-temp',
  'agent-temp',
  false,
  20971520, -- 20 MiB per object
  null
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
