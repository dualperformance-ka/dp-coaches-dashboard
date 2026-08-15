-- Coach-only programming system — core tables.
--
-- ADDITIVE ONLY. This migration creates new tables and touches nothing that
-- already exists. Applying it changes no behaviour in either application: the
-- athlete portal and the coaches dashboard keep reading exactly what they read
-- today until their own releases opt in.
--
-- Security model follows the precedent set by 20260727085203_lock_down_portal_rls:
-- RLS on, no grants to anon/authenticated, service_role only. Browsers reach
-- this data through scoped server routes, never directly.
--
-- Rollback: rollback/20260815000001_programming_core_down.sql

begin;

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Coach identity and athlete scope (spec §2, §49.3)
--
-- Coach login is still the shared DASHBOARD_ACCESS_KEY plus a self-declared
-- X-Coach-Name. That is deliberately unchanged here. What this table adds is a
-- server-side answer to "is this a real coach, what is their role, and are they
-- allowed to touch this athlete" — so authorisation stops being a dropdown.
--
-- When real coach accounts arrive later, only auth_user_id gets populated and
-- the API's identity step changes. Every downstream authorisation check keeps
-- working untouched.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.coaches (
  id            uuid primary key default gen_random_uuid(),
  -- Uppercase handle. This is what the dashboard sends in X-Coach-Name and what
  -- coach_actions.owner / created_by already store.
  handle        text not null unique,
  name          text not null,
  email         text,
  role          text not null default 'coach' check (role in ('coach', 'admin')),
  enabled       boolean not null default true,
  -- Reserved for the future Supabase Auth swap. Null today, by design.
  auth_user_id  uuid unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.coaches is
  'Coach identity and role. Authorisation source for programming endpoints. auth_user_id is reserved for a later real-login migration.';

-- Explicit coach → athlete assignment. Optional: a coach with no rows here
-- falls back to athletes.coach matching. Admins bypass both.
create table if not exists public.coach_athletes (
  coach_id      uuid not null references public.coaches(id) on delete cascade,
  athlete_code  text not null references public.athletes(code) on update cascade on delete cascade,
  assigned_at   timestamptz not null default now(),
  primary key (coach_id, athlete_code)
);

-- Seed the two coaches the dashboard gate already offers. Idempotent.
insert into public.coaches (handle, name, role)
values ('KARL', 'Karl Sexon', 'admin'),
       ('ALEX', 'Alex',       'coach')
on conflict (handle) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Exercise library (spec §15)
--
-- Promotes exercise identity out of the workout_splits jsonb blobs so search,
-- video, cues and muscle grouping have somewhere to live. workout_splits keeps
-- working exactly as-is; this is a reference table, not a replacement.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.exercise_library (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  -- Lowercased, punctuation-stripped match key. Mirrors the portal's
  -- priorityMatchKey() so seeding and lookup agree on identity.
  match_key        text not null unique,
  category         text,
  movement_pattern text,
  muscle_group     text,
  equipment        text,
  video_url        text,
  thumbnail_url    text,
  instructions     text,
  cues             text,
  regression       text,
  progression      text,
  tags             text[] not null default '{}',
  archived         boolean not null default false,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists exercise_library_search_idx
  on public.exercise_library (archived, name);
create index if not exists exercise_library_group_idx
  on public.exercise_library (muscle_group) where archived = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Programme hierarchy (spec §6, §9, §48)
--
-- programme_templates is reusable and never linked to a live athlete.
-- athlete_programmes is an independent instance created by copying a template.
-- Editing one must never affect the other — that separation is structural here,
-- not a convention: there is no shared row between them.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.programme_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  type          text not null default 'combined'
                check (type in ('strength', 'running', 'combined', 'rehabilitation', 'custom')),
  description   text,
  goal          text,
  coach_notes   text,
  duration_weeks int,
  status        text not null default 'active'
                check (status in ('draft', 'active', 'archived')),
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.athlete_programmes (
  id            uuid primary key default gen_random_uuid(),
  athlete_code  text not null references public.athletes(code) on update cascade on delete cascade,
  coach_handle  text,
  -- Provenance only. Deliberately NOT a live link: editing the template must
  -- never reach an assigned programme (spec §7, §69).
  template_id   uuid references public.programme_templates(id) on delete set null,
  name          text not null,
  type          text not null default 'combined'
                check (type in ('strength', 'running', 'combined', 'rehabilitation', 'custom')),
  goal          text,
  coach_notes   text,
  athlete_description text,
  start_date    date,
  end_date      date,
  duration_weeks int,
  status        text not null default 'draft'
                check (status in ('draft', 'scheduled', 'active', 'completed', 'archived')),
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists athlete_programmes_athlete_idx
  on public.athlete_programmes (athlete_code, status);

-- Only one active programme per athlete at a time. Drafts and archives are
-- unlimited, so a coach can build next block while the current one runs.
create unique index if not exists athlete_programmes_one_active_idx
  on public.athlete_programmes (athlete_code) where status = 'active';

create table if not exists public.programme_blocks (
  id             uuid primary key default gen_random_uuid(),
  programme_id   uuid not null references public.athlete_programmes(id) on delete cascade,
  name           text not null,
  week_start     int not null,
  week_end       int not null,
  block_order    int not null default 0,
  goal           text,
  strength_focus text,
  running_focus  text,
  volume_target  text,
  intensity_target text,
  coach_notes    text,
  athlete_notes  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint programme_blocks_week_range check (week_end >= week_start)
);

create index if not exists programme_blocks_programme_idx
  on public.programme_blocks (programme_id, block_order);

-- Named athlete_programme_weeks, not programme_weeks: the dashboard already
-- uses "programme weeks" client-side to mean the LENGTH of a programme
-- (getProgWeeks / DEFAULT_PROG_WEEKS in athlete_data). Reusing that name for a
-- table would be a permanent trap for whoever reads this next.
create table if not exists public.athlete_programme_weeks (
  id            uuid primary key default gen_random_uuid(),
  programme_id  uuid not null references public.athlete_programmes(id) on delete cascade,
  block_id      uuid references public.programme_blocks(id) on delete set null,
  week_number   int not null,
  start_date    date,
  -- Free text so it can carry the existing "Week 4" / "Discovery Week" labels
  -- that planned_sessions.week_label already uses across 1,167 live rows.
  week_label    text,
  coach_notes   text,
  athlete_notes text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (programme_id, week_number)
);

create index if not exists athlete_programme_weeks_programme_idx
  on public.athlete_programme_weeks (programme_id, week_number);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The missing layer: per-session exercise prescription (spec §12, §13, §14)
--
-- Today the portal resolves a gym session by matching planned_sessions.title
-- against workout_splits.name. That makes every prescription GLOBAL: changing
-- "Upper A" for one athlete changes it for everyone who trains an "Upper A".
--
-- This table is the per-session, per-athlete prescription that makes template
-- independence (§7), exercise replacement (§17) and edit scope (§18) possible.
--
-- IMPORTANT: rows are created lazily and forward-only. Existing sessions are
-- never backfilled — see the note on planned_sessions.prescription_mode in
-- 20260815000002.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.session_exercises (
  id                  uuid primary key default gen_random_uuid(),
  planned_session_id  uuid not null references public.planned_sessions(id) on delete cascade,
  exercise_id         uuid references public.exercise_library(id) on delete set null,
  -- Denormalised on purpose. The name is what the athlete sees, what the log is
  -- keyed by, and what history matches on. It must survive a library edit.
  exercise_name       text not null,

  position            int not null default 0,
  -- 'A', 'B', … Exercises sharing a group render as A1/A2 (spec §14).
  superset_group      text,
  circuit_group       text,

  sets                int,
  warmup_sets         int not null default 0,
  working_sets        int,
  rep_min             int,
  rep_max             int,
  -- Matches the portal's existing repMode values so the serialiser round-trips.
  rep_mode            text not null default 'reps'
                      check (rep_mode in ('reps', 'left_right', 'time')),

  target_load         numeric,
  load_type           text,
  percent_1rm         numeric,
  rpe                 numeric,
  rir                 numeric,
  tempo               text,
  rest_seconds        int,

  progression_rule    text,
  regression          text,
  -- Athlete-selectable alternatives. Mirrors workout_splits' "alts" array so the
  -- portal's existing swap flow keeps working unchanged.
  alternatives        jsonb not null default '[]'::jsonb,
  left_right_exercises jsonb not null default '[]'::jsonb,

  -- THE ONE FIELD THAT MUST NEVER REACH AN ATHLETE.
  -- The athlete-facing serialiser selects an explicit column list that omits
  -- this. Never add a wildcard select on this table to a portal route.
  coach_notes         text,
  athlete_notes       text,
  technique_cues      text,

  -- Which workout_splits row this was materialised from, if any. Makes the lazy
  -- expansion auditable and reversible.
  source_split_id     uuid references public.workout_splits(id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint session_exercises_rep_range check (rep_max is null or rep_min is null or rep_max >= rep_min)
);

create index if not exists session_exercises_session_idx
  on public.session_exercises (planned_session_id, position);

comment on column public.session_exercises.coach_notes is
  'Coach and admin only. Must be excluded from every athlete-facing response by explicit column list.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Structured running prescription (spec §24, §25)
--
-- planned_sessions.warm_up / intervals / working_pace / rest / cool_down stay
-- exactly as they are and keep serving every existing session. This table is
-- the ordered, typed alternative used only by structured sessions.
--
-- Repeat blocks use parent_step_id rather than a second table: "Repeat ×5
-- { 1 km @ 3:55-4:00, 90 s jog }" is one parent row plus two children.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.run_steps (
  id                  uuid primary key default gen_random_uuid(),
  planned_session_id  uuid not null references public.planned_sessions(id) on delete cascade,
  parent_step_id      uuid references public.run_steps(id) on delete cascade,
  step_order          int not null default 0,
  step_type           text not null
                      check (step_type in ('warmup', 'run', 'recovery', 'interval', 'rest', 'cooldown', 'repeat')),
  repeat_count        int,

  distance_km         numeric,
  duration_sec        int,

  intensity_type      text check (intensity_type in
                        ('pace', 'pace_range', 'hr', 'hr_zone', 'rpe', 'effort', 'text')),
  pace_min            text,
  pace_max            text,
  hr_zone             text,
  rpe                 numeric,
  effort              text,

  instructions        text,
  -- Coach only, same rule as session_exercises.coach_notes.
  coach_notes         text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- A repeat block is the only step that may carry a repeat_count, and it is
  -- the only step allowed to have children.
  constraint run_steps_repeat_shape check (
    (step_type = 'repeat' and repeat_count is not null and repeat_count > 0)
    or (step_type <> 'repeat' and repeat_count is null)
  )
);

create index if not exists run_steps_session_idx
  on public.run_steps (planned_session_id, step_order);
create index if not exists run_steps_parent_idx
  on public.run_steps (parent_step_id) where parent_step_id is not null;

comment on column public.run_steps.coach_notes is
  'Coach and admin only. Must be excluded from every athlete-facing response by explicit column list.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Template mirror (spec §7, §29, §30)
--
-- Deliberately separate tables rather than a nullable athlete_code on the live
-- ones. A template physically cannot be a live session, so no query, no bug and
-- no future refactor can accidentally show a template to an athlete or let a
-- template edit reach an assigned programme.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.template_weeks (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references public.programme_templates(id) on delete cascade,
  week_number  int not null,
  name         text,
  coach_notes  text,
  created_at   timestamptz not null default now(),
  unique (template_id, week_number)
);

create table if not exists public.template_sessions (
  id                uuid primary key default gen_random_uuid(),
  template_week_id  uuid not null references public.template_weeks(id) on delete cascade,
  -- 0 = Monday … 6 = Sunday. Matches the dashboard's PLAN_DAYS ordering.
  day_of_week       int not null check (day_of_week between 0 and 6),
  part_of_day       text check (part_of_day in ('AM', 'PM')),
  day_order         int not null default 0,
  title             text not null,
  session_type      text,
  description       text,
  estimated_minutes int,
  library_id        uuid references public.session_library(id) on delete set null,
  split_id          uuid references public.workout_splits(id) on delete set null,
  coach_notes       text,
  athlete_notes     text,
  created_at        timestamptz not null default now()
);

create index if not exists template_sessions_week_idx
  on public.template_sessions (template_week_id, day_of_week, day_order);

create table if not exists public.template_session_exercises (
  id                   uuid primary key default gen_random_uuid(),
  template_session_id  uuid not null references public.template_sessions(id) on delete cascade,
  exercise_id          uuid references public.exercise_library(id) on delete set null,
  exercise_name        text not null,
  position             int not null default 0,
  superset_group       text,
  circuit_group        text,
  sets                 int,
  warmup_sets          int not null default 0,
  working_sets         int,
  rep_min              int,
  rep_max              int,
  rep_mode             text not null default 'reps'
                       check (rep_mode in ('reps', 'left_right', 'time')),
  target_load          numeric,
  load_type            text,
  percent_1rm          numeric,
  rpe                  numeric,
  rir                  numeric,
  tempo                text,
  rest_seconds         int,
  progression_rule     text,
  regression           text,
  alternatives         jsonb not null default '[]'::jsonb,
  left_right_exercises jsonb not null default '[]'::jsonb,
  coach_notes          text,
  athlete_notes        text,
  technique_cues       text,
  created_at           timestamptz not null default now()
);

create index if not exists template_session_exercises_session_idx
  on public.template_session_exercises (template_session_id, position);

create table if not exists public.template_run_steps (
  id                   uuid primary key default gen_random_uuid(),
  template_session_id  uuid not null references public.template_sessions(id) on delete cascade,
  parent_step_id       uuid references public.template_run_steps(id) on delete cascade,
  step_order           int not null default 0,
  step_type            text not null
                       check (step_type in ('warmup', 'run', 'recovery', 'interval', 'rest', 'cooldown', 'repeat')),
  repeat_count         int,
  distance_km          numeric,
  duration_sec         int,
  intensity_type       text,
  pace_min             text,
  pace_max             text,
  hr_zone              text,
  rpe                  numeric,
  effort               text,
  instructions         text,
  coach_notes          text,
  created_at           timestamptz not null default now()
);

create index if not exists template_run_steps_session_idx
  on public.template_run_steps (template_session_id, step_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Programme change log (spec §20, §21)
--
-- coach_change_log already exists and already feeds athlete push notifications.
-- It is left completely alone. This is the coach-and-admin-only detailed log:
-- who, what, before, after, and at what scope.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.programme_change_log (
  id            uuid primary key default gen_random_uuid(),
  programme_id  uuid references public.athlete_programmes(id) on delete set null,
  athlete_code  text,
  changed_by    text,
  entity_type   text not null,
  entity_id     uuid,
  action        text not null,
  -- Scope the coach chose when the edit was applied: session | future | block.
  scope         text,
  old_value     jsonb,
  new_value     jsonb,
  summary       text,
  changed_at    timestamptz not null default now()
);

create index if not exists programme_change_log_athlete_idx
  on public.programme_change_log (athlete_code, changed_at desc);
create index if not exists programme_change_log_programme_idx
  on public.programme_change_log (programme_id, changed_at desc);

comment on table public.programme_change_log is
  'Coach and admin only. Never exposed to athlete routes.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Lock everything down (matches 20260727085203_lock_down_portal_rls)
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'coaches', 'coach_athletes', 'exercise_library',
    'programme_templates', 'athlete_programmes', 'programme_blocks',
    'athlete_programme_weeks', 'session_exercises', 'run_steps',
    'template_weeks', 'template_sessions', 'template_session_exercises',
    'template_run_steps', 'programme_change_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

commit;
