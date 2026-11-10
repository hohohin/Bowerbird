-- Text capacity belongs to the provider/platform, not an application byte budget.
-- Keep event shape, ownership, TTL and non-text event constraints unchanged.
alter table public.agent_events drop constraint if exists agent_events_display_payload_bytes_check;
alter table public.agent_events add constraint agent_events_display_payload_bytes_check
  check (type = 'text.result' or octet_length(display_payload::text) <= 16384);

-- NULL inherits the Storage service's actual global upload ceiling. Media
-- endpoints continue enforcing their own existing image/video byte limits.
update storage.buckets set file_size_limit = null where id = 'agent-temp';
