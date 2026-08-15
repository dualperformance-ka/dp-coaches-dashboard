-- Rollback for 20260815000001_programming_core.sql
--
-- WARNING: this destroys every programme, block, template and structured
-- prescription. Run rollback 20260815000002 first — it drops the
-- planned_sessions.programme_week_id foreign key that points here.
--
-- Nothing that existed before the programming system is touched:
-- planned_sessions, workout_splits, session_library, training_session_logs and
-- coach_change_log are all left exactly as they were.

begin;

do $$
declare n int;
begin
  select count(*) into n from public.session_exercises;
  if n > 0 then
    raise warning 'Dropping % structured exercise prescriptions. This cannot be undone.', n;
  end if;
end $$;

drop table if exists public.programme_change_log         cascade;
drop table if exists public.template_run_steps           cascade;
drop table if exists public.template_session_exercises   cascade;
drop table if exists public.template_sessions            cascade;
drop table if exists public.template_weeks               cascade;
drop table if exists public.run_steps                    cascade;
drop table if exists public.session_exercises            cascade;
drop table if exists public.athlete_programme_weeks      cascade;
drop table if exists public.programme_blocks             cascade;
drop table if exists public.athlete_programmes           cascade;
drop table if exists public.programme_templates          cascade;
drop table if exists public.exercise_library             cascade;
drop table if exists public.coach_athletes               cascade;
drop table if exists public.coaches                      cascade;

commit;
