-- Coach-only triage signals for the Dual Performance dashboard.
--
-- This migration is additive. Existing athlete logs and portal permissions are
-- unchanged. The dashboard reads these columns with the service role through
-- /api/coach-data?mode=triage; the athlete browser never receives roster-wide
-- triage data.

alter table public.daily_body_logs
  add column if not exists pain smallint,
  add column if not exists coach_alert boolean not null default false;

comment on column public.daily_body_logs.pain is
  'Athlete-reported pain from 0 (none) to 10 (severe).';

comment on column public.daily_body_logs.coach_alert is
  'Explicit safety flag that always places the athlete at the top of coach triage.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'daily_body_logs_pain_range'
      and conrelid = 'public.daily_body_logs'::regclass
  ) then
    alter table public.daily_body_logs
      add constraint daily_body_logs_pain_range
      check (pain is null or pain between 0 and 10);
  end if;
end
$$;

-- The seven-day pain queue only needs rows that can become urgent. Keeping
-- this partial avoids growing a second full-history body-log index.
create index if not exists daily_body_logs_coach_triage_idx
  on public.daily_body_logs (log_date desc, athlete_code)
  where coach_alert is true or pain >= 5;

-- Gone-quiet checks need only determine whether either source has a row inside
-- the five-day activity window.
create index if not exists session_logs_athlete_logged_idx
  on public.session_logs (athlete_code, logged_at desc);

-- Be explicit for projects using Supabase's 2026 opt-in Data API exposure.
-- No anon/authenticated grants are added here.
grant select on table public.daily_body_logs to service_role;
grant select on table public.session_logs to service_role;
