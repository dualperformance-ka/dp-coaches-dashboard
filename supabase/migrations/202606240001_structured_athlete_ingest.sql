-- Structured athlete ingest tables.
-- Supabase source of truth: every athlete submission lands here first, then
-- coach-readable Notion writes are mirrored through coach_write_outbox.

create extension if not exists pgcrypto;

-- Legacy/client sync tables used directly by the browser with the publishable
-- Supabase key. Structured coach/reporting tables below remain server-only.
create table if not exists public.athlete_data (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_code, key)
);

create table if not exists public.session_logs (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  session_key text not null,
  logged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_code, session_key)
);

create table if not exists public.athlete_goals (
  athlete_code text primary key,
  athlete_name text,
  athlete_notion_id text,
  submitted_at timestamptz not null default now(),
  goal_race text,
  race_date date,
  peak_week text,
  start_weight numeric,
  target_weight numeric,
  body_fat text,
  time_5k text,
  time_10k text,
  time_half text,
  time_marathon text,
  long_run_pace text,
  why text,
  milestone_w4 text,
  milestone_w8 text,
  milestone_w12 text,
  raw_payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.weekly_checkins (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  athlete_name text,
  athlete_notion_id text,
  week_key text,
  week_ending date,
  submitted_at timestamptz not null default now(),
  run_completed numeric,
  run_planned numeric,
  run_km numeric,
  run_feel numeric,
  run_wins text,
  run_niggles text,
  lift_completed numeric,
  lift_planned numeric,
  lift_feel numeric,
  lift_wins text,
  lift_niggles text,
  sleep text,
  energy numeric,
  soreness numeric,
  nutrition numeric,
  fuelling text,
  social_eating text,
  stress numeric,
  motivation numeric,
  upcoming_impact text,
  testimonial text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_code, week_key)
);

create table if not exists public.daily_body_logs (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  athlete_name text,
  athlete_notion_id text,
  log_date date not null,
  submitted_at timestamptz not null default now(),
  weight numeric,
  sleep numeric,
  energy numeric,
  soreness numeric,
  stress numeric,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_code, log_date)
);

create table if not exists public.daily_nutrition_logs (
  id uuid primary key default gen_random_uuid(),
  athlete_code text not null,
  athlete_name text,
  athlete_notion_id text,
  log_date date not null,
  submitted_at timestamptz not null default now(),
  calories numeric,
  protein numeric,
  carbs numeric,
  fat numeric,
  fibre numeric,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_code, log_date)
);

create table if not exists public.training_session_logs (
  id uuid primary key default gen_random_uuid(),
  client_write_id text unique,
  athlete_code text not null,
  athlete_name text,
  athlete_notion_id text,
  session_name text,
  session_category text,
  session_date date,
  exercise_log text,
  notes text,
  raw_payload jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.coach_write_outbox (
  id uuid primary key default gen_random_uuid(),
  client_write_id text unique,
  athlete_code text,
  target_url text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'synced', 'failed')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists weekly_checkins_athlete_week_idx on public.weekly_checkins (athlete_code, week_ending desc);
create index if not exists daily_body_logs_athlete_date_idx on public.daily_body_logs (athlete_code, log_date desc);
create index if not exists daily_nutrition_logs_athlete_date_idx on public.daily_nutrition_logs (athlete_code, log_date desc);
create index if not exists training_session_logs_athlete_date_idx on public.training_session_logs (athlete_code, session_date desc);
create index if not exists coach_write_outbox_pending_idx on public.coach_write_outbox (status, next_attempt_at);
create index if not exists athlete_data_athlete_key_idx on public.athlete_data (athlete_code, key);
create index if not exists session_logs_athlete_key_idx on public.session_logs (athlete_code, session_key);

alter table public.athlete_data enable row level security;
alter table public.session_logs enable row level security;
alter table public.athlete_goals enable row level security;
alter table public.weekly_checkins enable row level security;
alter table public.daily_body_logs enable row level security;
alter table public.daily_nutrition_logs enable row level security;
alter table public.training_session_logs enable row level security;
alter table public.coach_write_outbox enable row level security;

grant select, insert, update on table public.athlete_data to anon, authenticated;
grant select, insert, update on table public.session_logs to anon, authenticated;

drop policy if exists "client can sync athlete data" on public.athlete_data;
create policy "client can sync athlete data"
on public.athlete_data
for all
to anon, authenticated
using (true)
with check (athlete_code is not null and key is not null);

drop policy if exists "client can sync session logs" on public.session_logs;
create policy "client can sync session logs"
on public.session_logs
for all
to anon, authenticated
using (true)
with check (athlete_code is not null and session_key is not null);

revoke all on table public.athlete_goals from anon, authenticated;
revoke all on table public.weekly_checkins from anon, authenticated;
revoke all on table public.daily_body_logs from anon, authenticated;
revoke all on table public.daily_nutrition_logs from anon, authenticated;
revoke all on table public.training_session_logs from anon, authenticated;
revoke all on table public.coach_write_outbox from anon, authenticated;

grant all on table public.athlete_goals to service_role;
grant all on table public.weekly_checkins to service_role;
grant all on table public.daily_body_logs to service_role;
grant all on table public.daily_nutrition_logs to service_role;
grant all on table public.training_session_logs to service_role;
grant all on table public.coach_write_outbox to service_role;
grant all on table public.athlete_data to service_role;
grant all on table public.session_logs to service_role;
