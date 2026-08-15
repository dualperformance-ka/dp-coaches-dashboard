-- Rollback for 20260815000007_commercial_exercise_library.sql
--
-- Removes only the exercises this migration added (created_by = 'library-v2'),
-- and only those no coach has since attached to a prescription or template.
-- Anything in use stays, because deleting it would break the session that
-- references it.

begin;

delete from public.exercise_library el
where el.created_by = 'library-v2'
  and not exists (select 1 from public.session_exercises se where se.exercise_id = el.id)
  and not exists (select 1 from public.template_session_exercises te where te.exercise_id = el.id);

commit;
