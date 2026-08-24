-- Athlete-owned original workout files. Athletes explicitly grant their coach
-- access at upload time; the browser never receives database or Storage keys.
-- The original FIT/TCX/GPX is retained in a private bucket so future parsers can
-- recover fields that today's normaliser does not yet understand.

create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'athlete-activity-files',
  'athlete-activity-files',
  false,
  3145728,
  array[
    'application/octet-stream',
    'application/vnd.ant.fit',
    'application/gpx+xml',
    'application/vnd.garmin.tcx+xml',
    'application/xml',
    'text/xml'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.athlete_activity_uploads (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  athlete_name text,
  client_write_id text,
  content_hash text not null,
  source_format text not null check (source_format in ('fit', 'tcx', 'gpx')),
  original_filename text not null,
  content_type text,
  file_size_bytes integer not null check (file_size_bytes > 0 and file_size_bytes <= 3145728),
  raw_file_path text not null,
  activity_name text,
  sport_type text,
  activity_date date,
  start_time timestamptz,
  device_name text,
  summary jsonb not null default '{}'::jsonb,
  laps jsonb not null default '[]'::jsonb,
  splits jsonb not null default '[]'::jsonb,
  streams jsonb not null default '[]'::jsonb,
  parse_warnings jsonb not null default '[]'::jsonb,
  athlete_notes text,
  coach_access_granted_at timestamptz not null,
  consent_version text not null default 'activity-file-coach-access-v1',
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_code, content_hash),
  constraint athlete_activity_uploads_code_uppercase check (athlete_code = upper(athlete_code)),
  constraint athlete_activity_uploads_hash_format check (content_hash ~ '^[a-f0-9]{64}$'),
  constraint athlete_activity_uploads_summary_object check (jsonb_typeof(summary) = 'object'),
  constraint athlete_activity_uploads_laps_array check (jsonb_typeof(laps) = 'array'),
  constraint athlete_activity_uploads_splits_array check (jsonb_typeof(splits) = 'array'),
  constraint athlete_activity_uploads_streams_array check (jsonb_typeof(streams) = 'array'),
  constraint athlete_activity_uploads_warnings_array check (jsonb_typeof(parse_warnings) = 'array')
);

comment on table public.athlete_activity_uploads is
  'Private athlete-consented FIT/TCX/GPX imports, parsed for coach review and retained for future reprocessing.';
comment on column public.athlete_activity_uploads.streams is
  'Downsampled time, distance, GPS, elevation, heart-rate, cadence, power, temperature and speed points.';
comment on column public.athlete_activity_uploads.raw_file_path is
  'Path in the private athlete-activity-files Storage bucket; never returned to a browser.';

create index if not exists athlete_activity_uploads_athlete_date_idx
  on public.athlete_activity_uploads (athlete_code, activity_date desc);
create index if not exists athlete_activity_uploads_submitted_idx
  on public.athlete_activity_uploads (submitted_at desc);

alter table public.athlete_activity_uploads enable row level security;

-- Both athlete and coach access flows go through authenticated server routes.
-- The service-role key remains server-side and bypasses RLS by design.
revoke all on table public.athlete_activity_uploads from anon, authenticated;
grant select, insert, update, delete on table public.athlete_activity_uploads to service_role;

-- Storage remains private with no policies for this bucket. Existing policies
-- for unrelated buckets are intentionally untouched; the service-role server
-- route is the only path that can write or read these originals.
