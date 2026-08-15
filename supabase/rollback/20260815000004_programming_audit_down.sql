-- Rollback for 20260815000004_programming_audit.sql
-- Removes the new triggers and functions. Leaves all data intact.

begin;

drop trigger if exists trg_log_session_exercises        on public.session_exercises;
drop trigger if exists trg_log_run_steps                on public.run_steps;
drop trigger if exists trg_guard_locked_session_exercises on public.session_exercises;
drop trigger if exists trg_guard_locked_run_steps       on public.run_steps;

do $$
declare t text;
begin
  foreach t in array array[
    'coaches', 'exercise_library', 'programme_templates', 'athlete_programmes',
    'programme_blocks', 'athlete_programme_weeks', 'session_exercises', 'run_steps'
  ] loop
    execute format('drop trigger if exists trg_touch_%1$s on public.%1$I', t);
  end loop;
end $$;

drop function if exists public.log_session_exercise_change();
drop function if exists public.log_run_step_change();
drop function if exists public.reject_locked_session_edit();
drop function if exists public.touch_updated_at();

commit;
