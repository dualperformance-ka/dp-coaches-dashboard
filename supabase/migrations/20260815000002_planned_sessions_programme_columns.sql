-- Coach-only programming system — extend planned_sessions.
--
-- This is the migration that touches live data: 1,167 rows across 12 athletes.
-- Every column is nullable or has a default chosen so that EXISTING ROWS KEEP
-- BEHAVING EXACTLY AS THEY DO NOW. Read the defaults carefully before changing
-- any of them — two of them are load-bearing.
--
-- Rollback: rollback/20260815000002_planned_sessions_programme_columns_down.sql

begin;

-- Links a session into the new programme hierarchy. Null for all 1,167 existing
-- rows; they keep resolving by week_label exactly as they do today. Backfilled
-- only when a coach adopts an athlete into a structured programme.
alter table public.planned_sessions
  add column if not exists programme_week_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'planned_sessions_programme_week_fk'
  ) then
    alter table public.planned_sessions
      add constraint planned_sessions_programme_week_fk
      foreign key (programme_week_id)
      references public.athlete_programme_weeks(id) on delete set null;
  end if;
end $$;

-- LOAD-BEARING DEFAULT. 'published' means every existing session stays visible
-- to its athlete the moment this migration lands. Defaulting to 'draft' would
-- silently empty 12 athletes' training plans on their next portal load.
-- New sessions a coach builds in draft mode are written as 'draft' explicitly.
alter table public.planned_sessions
  add column if not exists publish_state text not null default 'published';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'planned_sessions_publish_state_check'
  ) then
    alter table public.planned_sessions
      add constraint planned_sessions_publish_state_check
      check (publish_state in ('draft', 'published'));
  end if;
end $$;

-- LOAD-BEARING DEFAULT. 'legacy' means "resolve this session's strength work by
-- matching title against workout_splits.name", which is what the deployed
-- portal already does for all 1,167 rows.
--
-- A session only becomes 'structured' when a coach opens it in the new builder
-- and its prescription is materialised into session_exercises / run_steps.
-- Forward-only, one session at a time, never a bulk backfill — see §3.2 of the
-- implementation plan for why.
alter table public.planned_sessions
  add column if not exists prescription_mode text not null default 'legacy';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'planned_sessions_prescription_mode_check'
  ) then
    alter table public.planned_sessions
      add constraint planned_sessions_prescription_mode_check
      check (prescription_mode in ('legacy', 'structured'));
  end if;
end $$;

-- Multiple sessions per day (spec §27): AM easy run, PM strength.
alter table public.planned_sessions
  add column if not exists part_of_day text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'planned_sessions_part_of_day_check'
  ) then
    alter table public.planned_sessions
      add constraint planned_sessions_part_of_day_check
      check (part_of_day is null or part_of_day in ('AM', 'PM'));
  end if;
end $$;

alter table public.planned_sessions
  add column if not exists day_order int not null default 0;

-- Completed workout protection (spec §19). Set when an athlete completes the
-- session. Every server-side edit-scope resolution excludes rows where this is
-- non-null, so a later programme change can never rewrite training history.
alter table public.planned_sessions
  add column if not exists locked_at timestamptz;

alter table public.planned_sessions
  add column if not exists estimated_minutes int;

-- Coach-only note at session level. The athlete-facing "notes" column is
-- unchanged and still goes to the athlete.
alter table public.planned_sessions
  add column if not exists coach_notes text;

comment on column public.planned_sessions.coach_notes is
  'Coach and admin only. planned_sessions.notes remains the athlete-facing note.';
comment on column public.planned_sessions.prescription_mode is
  'legacy = portal resolves strength by title against workout_splits. structured = read session_exercises / run_steps.';
comment on column public.planned_sessions.locked_at is
  'Set on athlete completion. Rows with locked_at set are excluded from every edit-scope resolution.';

create index if not exists planned_sessions_athlete_date_idx
  on public.planned_sessions (athlete_code, planned_date);
create index if not exists planned_sessions_programme_week_idx
  on public.planned_sessions (programme_week_id) where programme_week_id is not null;
create index if not exists planned_sessions_draft_idx
  on public.planned_sessions (athlete_code) where publish_state = 'draft';

-- ─────────────────────────────────────────────────────────────────────────────
-- Re-arm the existing change-log trigger for the new columns.
--
-- THIS IS NOT OPTIONAL AND MUST SHIP WITH THE COLUMNS ABOVE.
--
-- trg_log_planned_sessions currently ignores only status, updated_at and
-- created_at when deciding whether a row "changed". Without this, purely
-- internal bookkeeping — a coach opening a session in the builder and flipping
-- prescription_mode, or the system stamping locked_at on completion — would
-- write a coach_change_log row, which is what drives the athlete's "your coach
-- updated your training" push notification.
--
-- Athletes would get notified about edits that changed nothing they can see.
--
-- The second problem is drafts. The trigger's excluded-column list only applies
-- to UPDATE — an INSERT always logs. So a coach building next week in draft mode
-- would push a notification per session created, which is precisely what §46
-- exists to prevent.
--
-- Both are fixed here without touching log_coach_change() itself, which is
-- shared with nutrition_plans and workout_splits. The single trigger is split
-- into three so each can carry a WHEN clause referencing the right row:
-- draft rows never log, and the draft → published transition does.
--
-- Athlete-visible fields (title, date, distance, pace, the run text fields,
-- notes) all still notify exactly as before.
-- ─────────────────────────────────────────────────────────────────────────────

drop trigger if exists trg_log_planned_sessions     on public.planned_sessions;
drop trigger if exists trg_log_planned_sessions_ins on public.planned_sessions;
drop trigger if exists trg_log_planned_sessions_upd on public.planned_sessions;
drop trigger if exists trg_log_planned_sessions_del on public.planned_sessions;

create trigger trg_log_planned_sessions_ins
  after insert on public.planned_sessions
  for each row
  when (new.publish_state = 'published')
  execute function log_coach_change(
    'training',
    'status,updated_at,created_at,prescription_mode,locked_at,day_order,programme_week_id,coach_notes,estimated_minutes',
    'title',
    'planned_date'
  );

-- Fires when the row is published either side of the edit. A draft being
-- edited stays silent; a draft being published announces itself.
create trigger trg_log_planned_sessions_upd
  after update on public.planned_sessions
  for each row
  when (new.publish_state = 'published' or old.publish_state = 'published')
  execute function log_coach_change(
    'training',
    'status,updated_at,created_at,prescription_mode,locked_at,day_order,programme_week_id,coach_notes,estimated_minutes',
    'title',
    'planned_date'
  );

create trigger trg_log_planned_sessions_del
  after delete on public.planned_sessions
  for each row
  when (old.publish_state = 'published')
  execute function log_coach_change(
    'training',
    'status,updated_at,created_at,prescription_mode,locked_at,day_order,programme_week_id,coach_notes,estimated_minutes',
    'title',
    'planned_date'
  );

commit;
