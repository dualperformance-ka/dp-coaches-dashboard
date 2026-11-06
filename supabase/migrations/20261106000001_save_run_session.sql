-- One-save structured runs from the Plan Session window.
--
-- Why: the Plan Session window now holds the Garmin step builder, and the
-- session's text columns (warm_up, intervals, working_pace, rest, cool_down,
-- target_pace) are WRITTEN FROM the steps so the portal card and the watch
-- always match. That is two writes, the session row and its run_steps, and
-- they must land together: a failure between them would leave the athlete
-- card describing one workout and Garmin receiving another.
--
-- save_run_session() inserts or updates the planned_sessions row and calls
-- replace_run_steps() (20261105000001) in ONE transaction. Either both change
-- or neither does. It never changes publish_state: a new row takes the
-- column default exactly as plan_insert does today, and an edit keeps its
-- state, so existing draft/publish behaviour is untouched.
--
-- Field list is fixed here, not taken from the request: the server sends an
-- allowlisted object, and this function only reads the columns below. It
-- cannot move a session to another athlete (athlete_code is only read on
-- insert) and cannot touch notion_page_id, locked_at, publish_state or
-- prescription_mode directly.
--
-- Depends on: 20261105000001_replace_run_steps_atomic.sql (already applied).
-- Additive only: no table, column, trigger or existing row is changed.
-- Rollback: supabase/rollback/20261106000001_save_run_session_down.sql

begin;

create or replace function public.save_run_session(
  p_session_id    uuid,
  p_athlete_code  text,
  p_fields        jsonb,
  p_steps         jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  f    jsonb := coalesce(p_fields, '{}'::jsonb);
  sid  uuid;
  out  jsonb;
begin
  if jsonb_typeof(f) <> 'object' then
    raise exception 'session fields must be a JSON object' using errcode = 'check_violation';
  end if;

  if p_session_id is null then
    if coalesce(trim(p_athlete_code), '') = '' then
      raise exception 'An athlete is required for a new session' using errcode = 'check_violation';
    end if;
    if coalesce(f->>'planned_date', '') = '' then
      raise exception 'A new session needs a date' using errcode = 'check_violation';
    end if;
    insert into public.planned_sessions (
      athlete_code, title, session_type, status, planned_date, week_label,
      run_details, library_id, distance_km, target_pace, warm_up, intervals,
      working_pace, rest, cool_down, notes
    )
    select upper(trim(p_athlete_code)), coalesce(r.title, 'Session'), r.session_type,
           'Planned', r.planned_date, r.week_label, r.run_details,
           r.library_id, r.distance_km, r.target_pace, r.warm_up, r.intervals,
           r.working_pace, r.rest, r.cool_down, r.notes
      from jsonb_to_record(f) as r(
        title text, session_type text, status text, planned_date date, week_label text,
        run_details text, library_id uuid, distance_km numeric, target_pace text,
        warm_up text, intervals text, working_pace text, rest text, cool_down text, notes text)
    returning id into sid;
  else
    -- A key that is absent keeps the column; a key that is present (even
    -- null) sets it. Same semantics as a PostgREST PATCH.
    update public.planned_sessions s set
      title        = case when f ? 'title'        then coalesce(r.title, 'Session') else s.title end,
      session_type = case when f ? 'session_type' then r.session_type else s.session_type end,
      planned_date = case when f ? 'planned_date' then coalesce(r.planned_date, s.planned_date) else s.planned_date end,
      week_label   = case when f ? 'week_label'   then r.week_label else s.week_label end,
      run_details  = case when f ? 'run_details'  then r.run_details else s.run_details end,
      library_id   = case when f ? 'library_id'   then r.library_id else s.library_id end,
      distance_km  = case when f ? 'distance_km'  then r.distance_km else s.distance_km end,
      target_pace  = case when f ? 'target_pace'  then r.target_pace else s.target_pace end,
      warm_up      = case when f ? 'warm_up'      then r.warm_up else s.warm_up end,
      intervals    = case when f ? 'intervals'    then r.intervals else s.intervals end,
      working_pace = case when f ? 'working_pace' then r.working_pace else s.working_pace end,
      rest         = case when f ? 'rest'         then r.rest else s.rest end,
      cool_down    = case when f ? 'cool_down'    then r.cool_down else s.cool_down end,
      notes        = case when f ? 'notes'        then r.notes else s.notes end,
      updated_at   = now()
      from jsonb_to_record(f) as r(
        title text, session_type text, status text, planned_date date, week_label text,
        run_details text, library_id uuid, distance_km numeric, target_pace text,
        warm_up text, intervals text, working_pace text, rest text, cool_down text, notes text)
     where s.id = p_session_id
    returning s.id into sid;
    if sid is null then
      raise exception 'Session not found' using errcode = 'no_data_found';
    end if;
  end if;

  -- Locks the row, refuses sessions that were already completed, and swaps the tree. Any error
  -- here rolls back the row change above as well.
  perform public.replace_run_steps(sid, coalesce(p_steps, '[]'::jsonb), null);

  -- Status last: Completed/Skipped lock the session (sync_session_lock), so
  -- setting it before the steps would make the step write refuse its own save.
  if f ? 'status' then
    update public.planned_sessions set status = coalesce(f->>'status', 'Planned') where id = sid;
  end if;

  select to_jsonb(s) into out from public.planned_sessions s where s.id = sid;
  return out;
end
$$;

comment on function public.save_run_session(uuid, text, jsonb, jsonb) is
  'Coach Plan Session save for structured runs: session row + run_steps in one transaction. Service role only.';

revoke all on function public.save_run_session(uuid, text, jsonb, jsonb) from public;
revoke all on function public.save_run_session(uuid, text, jsonb, jsonb) from anon, authenticated;
grant execute on function public.save_run_session(uuid, text, jsonb, jsonb) to service_role;

commit;

notify pgrst, 'reload schema';
