-- Atomic structured-run save for the coach builder.
--
-- Why: server/programming.js used to save a structured run by DELETEing every
-- run_steps row for the session and then POSTing the new rows one request at
-- a time. For a published session the athlete portal (and its Garmin
-- converter) could read the session between those requests and see no steps
-- or half a workout, and a failure part-way left it like that.
--
-- replace_run_steps() does the delete, the inserts, the prescription_mode
-- flip and an optional publish in ONE transaction. Readers see the old
-- workout or the new one, never a mix.
--
-- Additive only: no table, column, trigger or existing row is changed. The
-- existing triggers on run_steps keep working unchanged inside the call:
--   trg_guard_locked_run_steps  still refuses edits to completed sessions
--   trg_log_run_steps           still logs athlete-visible changes for
--                               published sessions (drafts stay silent)
--   trg_log_planned_sessions_*  still logs exactly one change on
--                               draft -> published
--
-- Rollback: supabase/rollback/20261105000001_replace_run_steps_atomic_down.sql

begin;

create or replace function public.replace_run_steps(
  p_session_id     uuid,
  p_steps          jsonb,
  p_publish_state  text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  sess        record;
  step_count  int;
begin
  if p_publish_state is not null and p_publish_state not in ('draft', 'published') then
    raise exception 'publish state must be draft or published' using errcode = 'check_violation';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'run steps must be a JSON array' using errcode = 'check_violation';
  end if;

  step_count := jsonb_array_length(p_steps);
  -- The athlete portal reads at most 101 rows and refuses more than 100.
  if step_count > 100 then
    raise exception 'A run workout can hold at most 100 steps' using errcode = 'check_violation';
  end if;

  -- Lock the session row so two saves of the same session serialise rather
  -- than interleaving their deletes and inserts.
  select id, locked_at, publish_state, prescription_mode
    into sess
    from public.planned_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'Session not found' using errcode = 'no_data_found';
  end if;
  if sess.locked_at is not null then
    raise exception 'That session is completed and cannot be edited' using errcode = 'check_violation';
  end if;

  delete from public.run_steps where planned_session_id = p_session_id;

  -- One statement: foreign keys are checked when it ends, so a child row may
  -- precede its repeat parent in the array.
  insert into public.run_steps (
    id, planned_session_id, parent_step_id, step_order, step_type, repeat_count,
    distance_km, duration_sec, intensity_type, pace_min, pace_max, hr_zone,
    rpe, effort, instructions, coach_notes
  )
  select
    r.id, p_session_id, r.parent_step_id, coalesce(r.step_order, 0), r.step_type, r.repeat_count,
    r.distance_km, r.duration_sec, r.intensity_type, r.pace_min, r.pace_max, r.hr_zone,
    r.rpe, r.effort, r.instructions, r.coach_notes
  from jsonb_to_recordset(p_steps) as r(
    id uuid, parent_step_id uuid, step_order int, step_type text, repeat_count int,
    distance_km numeric, duration_sec int, intensity_type text, pace_min text,
    pace_max text, hr_zone text, rpe numeric, effort text, instructions text,
    coach_notes text
  );

  -- The parent foreign key only proves the parent exists somewhere. It must
  -- be a repeat block in THIS session's new workout.
  if exists (
    select 1
      from public.run_steps child
     where child.planned_session_id = p_session_id
       and child.parent_step_id is not null
       and not exists (
         select 1 from public.run_steps parent
          where parent.id = child.parent_step_id
            and parent.planned_session_id = p_session_id
            and parent.step_type = 'repeat'
       )
  ) then
    raise exception 'Every nested step must sit inside a repeat block of the same session'
      using errcode = 'check_violation';
  end if;

  update public.planned_sessions
     set prescription_mode = case when step_count > 0 then 'structured' else prescription_mode end,
         publish_state     = coalesce(p_publish_state, publish_state),
         updated_at        = now()
   where id = p_session_id;

  return jsonb_build_object(
    'steps', step_count,
    'publish_state', coalesce(p_publish_state, sess.publish_state),
    'prescription_mode', case when step_count > 0 then 'structured' else sess.prescription_mode end
  );
end
$$;

comment on function public.replace_run_steps(uuid, jsonb, text) is
  'Coach builder only. Replaces a session''s run_steps and optionally publishes it in one transaction. Service role only.';

-- Same boundary as the tables: no browser role may call it.
revoke all on function public.replace_run_steps(uuid, jsonb, text) from public;
revoke all on function public.replace_run_steps(uuid, jsonb, text) from anon, authenticated;
grant execute on function public.replace_run_steps(uuid, jsonb, text) to service_role;

commit;

notify pgrst, 'reload schema';
