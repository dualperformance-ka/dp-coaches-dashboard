-- Coach-only programming system — audit and athlete change notification.
--
-- Two separate jobs, deliberately not merged:
--
--   coach_change_log      already exists, already drives the athlete's
--                         "your coach updated your training" push. Athlete-
--                         facing. Must keep firing for strength edits.
--
--   programme_change_log  new, coach and admin only. Who / what / before /
--                         after / at what scope. Written by the API, which is
--                         the only layer that knows the coach and the scope.
--
-- The problem this migration solves: trg_log_workout_splits notifies athletes
-- today when a split is edited. Once a session is structured, its prescription
-- lives in session_exercises instead, and that trigger no longer sees the
-- change. Without what follows, structured athletes would silently stop being
-- told their strength work changed.
--
-- Rollback: rollback/20260815000004_programming_audit_down.sql

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- Athlete-facing notification for structured prescriptions.
--
-- session_exercises has no athlete_code of its own, so this resolves it through
-- planned_sessions — the same approach log_override_change() already uses for
-- session_overrides.
--
-- Three guards, all of which matter:
--   1. draft sessions never notify (spec §46)
--   2. completed/locked sessions never notify — editing history is already
--      blocked at the API, and a stray write must not tell the athlete their
--      finished session changed (spec §19)
--   3. coach_notes and internal bookkeeping columns are ignored, so writing a
--      private note to yourself does not ping the athlete (spec §32)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.log_session_exercise_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  row_j jsonb;
  old_j jsonb;
  new_j jsonb;
  col text;
  excluded text[] := array[
    'id', 'created_at', 'updated_at', 'coach_notes', 'source_split_id', 'exercise_id'
  ];
  sess record;
  act text;
begin
  if tg_op = 'DELETE' then
    row_j := to_jsonb(old); act := 'removed';
  else
    row_j := to_jsonb(new);
    act := case tg_op when 'INSERT' then 'added' else 'updated' end;
  end if;

  select athlete_code, title, planned_date, publish_state, locked_at
    into sess
    from public.planned_sessions
   where id = (row_j->>'planned_session_id')::uuid
   limit 1;

  if sess.athlete_code is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Guards 1 and 2.
  if sess.publish_state <> 'published' or sess.locked_at is not null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Guard 3: ignore updates that only touched coach-private or bookkeeping
  -- columns. An athlete should never be pinged about a note they cannot read.
  if tg_op = 'UPDATE' then
    old_j := to_jsonb(old); new_j := to_jsonb(new);
    foreach col in array excluded loop
      old_j := old_j - col; new_j := new_j - col;
    end loop;
    if old_j = new_j then return new; end if;
  end if;

  insert into public.coach_change_log (athlete_code, source, detail)
  values (
    sess.athlete_code,
    'gym plan',
    jsonb_strip_nulls(jsonb_build_object(
      'action', act,
      'item',   coalesce(row_j->>'exercise_name', sess.title),
      'date',   sess.planned_date::text
    ))
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;

drop trigger if exists trg_log_session_exercises on public.session_exercises;
create trigger trg_log_session_exercises
  after insert or update or delete on public.session_exercises
  for each row execute function log_session_exercise_change();

-- ─────────────────────────────────────────────────────────────────────────────
-- The same treatment for structured running prescriptions.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.log_run_step_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  row_j jsonb;
  old_j jsonb;
  new_j jsonb;
  col text;
  excluded text[] := array['id', 'created_at', 'updated_at', 'coach_notes'];
  sess record;
begin
  if tg_op = 'DELETE' then row_j := to_jsonb(old); else row_j := to_jsonb(new); end if;

  select athlete_code, title, planned_date, publish_state, locked_at
    into sess
    from public.planned_sessions
   where id = (row_j->>'planned_session_id')::uuid
   limit 1;

  if sess.athlete_code is null
     or sess.publish_state <> 'published'
     or sess.locked_at is not null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    old_j := to_jsonb(old); new_j := to_jsonb(new);
    foreach col in array excluded loop
      old_j := old_j - col; new_j := new_j - col;
    end loop;
    if old_j = new_j then return new; end if;
  end if;

  insert into public.coach_change_log (athlete_code, source, detail)
  values (
    sess.athlete_code,
    'training',
    jsonb_strip_nulls(jsonb_build_object(
      'action', 'updated',
      'item',   sess.title,
      'date',   sess.planned_date::text
    ))
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;

drop trigger if exists trg_log_run_steps on public.run_steps;
create trigger trg_log_run_steps
  after insert or update or delete on public.run_steps
  for each row execute function log_run_step_change();

-- ─────────────────────────────────────────────────────────────────────────────
-- Guard: a structured session's exercises must not be edited once its session
-- is locked. The API enforces this, but the API is not the only thing that can
-- ever hold the service key. Defence in depth on the one rule that, if broken,
-- silently corrupts an athlete's training history.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.reject_locked_session_edit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  target uuid;
  locked timestamptz;
begin
  target := coalesce(
    (to_jsonb(new)->>'planned_session_id')::uuid,
    (to_jsonb(old)->>'planned_session_id')::uuid
  );
  select locked_at into locked from public.planned_sessions where id = target limit 1;
  if locked is not null then
    raise exception
      'Session % is locked (completed at %). Completed training records are immutable.',
      target, locked
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;

drop trigger if exists trg_guard_locked_session_exercises on public.session_exercises;
create trigger trg_guard_locked_session_exercises
  before insert or update or delete on public.session_exercises
  for each row execute function reject_locked_session_edit();

drop trigger if exists trg_guard_locked_run_steps on public.run_steps;
create trigger trg_guard_locked_run_steps
  before insert or update or delete on public.run_steps
  for each row execute function reject_locked_session_edit();

-- ─────────────────────────────────────────────────────────────────────────────
-- Keep updated_at honest on the new tables. The dashboard's unsaved-changes and
-- "recently modified programmes" surfaces both read it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end $function$;

do $$
declare t text;
begin
  foreach t in array array[
    'coaches', 'exercise_library', 'programme_templates', 'athlete_programmes',
    'programme_blocks', 'athlete_programme_weeks', 'session_exercises', 'run_steps'
  ] loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_touch_%1$s before update on public.%1$I
         for each row execute function touch_updated_at()', t);
  end loop;
end $$;

commit;
