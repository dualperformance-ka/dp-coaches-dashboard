-- Rollback for 20261105000001_replace_run_steps_atomic.sql.
-- Drops only the function. No data was changed by the forward migration.
-- Roll back the dashboard code first: saveRunSteps calls this function.
drop function if exists public.replace_run_steps(uuid, jsonb, text);
notify pgrst, 'reload schema';
