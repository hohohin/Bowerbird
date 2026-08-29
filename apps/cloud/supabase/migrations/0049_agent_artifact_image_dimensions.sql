-- U2 list_run_assets only exposes dimensions derived by Edge from verified bytes.
-- Existing artifacts remain readable; new image commits populate both columns.

alter table public.agent_artifacts
  add column width integer,
  add column height integer,
  add constraint agent_artifacts_image_dimensions_check check (
    (width is null and height is null)
    or (
      width is not null
      and height is not null
      and width between 1 and 16384
      and height between 1 and 16384
      and mime in ('image/png', 'image/jpeg', 'image/webp')
    )
  );

comment on column public.agent_artifacts.width is
  'Pixel width derived by trusted Edge code from verified image bytes; null for legacy/non-image artifacts.';
comment on column public.agent_artifacts.height is
  'Pixel height derived by trusted Edge code from verified image bytes; null for legacy/non-image artifacts.';
