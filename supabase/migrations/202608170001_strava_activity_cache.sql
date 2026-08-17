-- Server-only Strava cache for coaching analytics.
-- Raw Strava payloads remain behind protected server endpoints; athlete and
-- coach browsers do not receive direct table access.

create table if not exists public.strava_activities (
  athlete_code text not null,
  activity_id bigint not null,
  activity_date date,
  summary jsonb not null default '{}'::jsonb,
  detail jsonb,
  hr_zones jsonb,
  streams jsonb,
  detail_cached_at timestamptz,
  streams_cached_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (athlete_code, activity_id),
  constraint strava_activities_athlete_code_uppercase
    check (athlete_code = upper(athlete_code)),
  constraint strava_activities_summary_object
    check (jsonb_typeof(summary) = 'object'),
  constraint strava_activities_detail_object
    check (detail is null or jsonb_typeof(detail) = 'object'),
  constraint strava_activities_hr_zones_array
    check (hr_zones is null or jsonb_typeof(hr_zones) = 'array'),
  constraint strava_activities_streams_object
    check (streams is null or jsonb_typeof(streams) = 'object')
);

comment on table public.strava_activities is
  'Server-only cache of Strava activity summaries and lazily fetched immutable coaching detail.';
comment on column public.strava_activities.streams is
  'Selected time, distance, heartrate, velocity_smooth and grade_smooth streams used for aerobic decoupling.';

create index if not exists strava_activities_athlete_date_idx
  on public.strava_activities (athlete_code, activity_date desc);

alter table public.strava_activities enable row level security;

revoke all on table public.strava_activities from anon, authenticated;
grant select, insert, update, delete on table public.strava_activities to service_role;

