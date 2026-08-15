-- Rollback for 20260815000003_exercise_library_seed.sql
--
-- Removes ONLY the seeded rows (created_by = 'seed') and only those a coach has
-- not since edited or attached to a prescription. Anything a human touched
-- stays. This is deliberately conservative: an over-eager rollback here would
-- delete a coach's library work.

begin;

delete from public.exercise_library el
where el.created_by = 'seed'
  and el.updated_at = el.created_at            -- never edited since seeding
  and not exists (select 1 from public.session_exercises se where se.exercise_id = el.id)
  and not exists (select 1 from public.template_session_exercises te where te.exercise_id = el.id);

commit;
