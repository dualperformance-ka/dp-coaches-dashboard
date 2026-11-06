-- Rollback for 20261106000001_save_run_session.sql.
-- Drops only the function. No data was changed by the forward migration.
-- Roll back the dashboard code first: the Plan Session save calls this
-- function for running sessions with steps (plan_save_run).
drop function if exists public.save_run_session(uuid, text, jsonb, jsonb);
notify pgrst, 'reload schema';
