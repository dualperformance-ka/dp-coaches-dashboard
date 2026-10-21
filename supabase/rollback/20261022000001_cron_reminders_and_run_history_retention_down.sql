-- Rollback for 20261022000001_cron_reminders_and_run_history_retention.sql.
--
-- Removes the run-history retention job. Rows it already deleted are not
-- restored (they were run logs older than 30 days).
--
-- send-athlete-reminders is deliberately NOT reverted to every minute: the
-- per-minute schedule is what produced 1,440 runs a day during the incident.
-- The forward migration only recorded the live */5 schedule, so there is
-- nothing to undo for that job. To pause reminders instead, use:
--   select cron.alter_job(
--     job_id := (select jobid from cron.job where jobname = 'send-athlete-reminders'),
--     active := false
--   );

do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-cron-run-history') then
    perform cron.unschedule('purge-cron-run-history');
  end if;
end;
$$;
