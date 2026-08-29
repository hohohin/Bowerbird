-- Supabase Edge Functions use service_role for trusted control-plane table I/O.
-- Hosted projects normally provide these grants implicitly, but a fresh local
-- database created by Supabase CLI 2.113.0 does not inherit the CRUD defaults
-- for tables created by migrations. Make the existing trust boundary explicit
-- without changing anon/authenticated grants or RLS policies.

begin;

grant select, insert, update, delete
  on all tables in schema public
  to service_role;

grant usage, select
  on all sequences in schema public
  to service_role;

commit;
