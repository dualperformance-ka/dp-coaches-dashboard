-- Read-only check that the live pg_cron configuration matches
-- 20261022000001_cron_reminders_and_run_history_retention.sql.
-- Safe to run at any time; it raises on drift and selects nothing secret.

do $$
declare
  reminder cron.job%rowtype;
  retention cron.job%rowtype;
begin
  select * into reminder from cron.job where jobname = 'send-athlete-reminders';
  if not found then
    raise exception 'FAIL: send-athlete-reminders is not scheduled';
  end if;
  if reminder.schedule <> '*/5 * * * *' then
    raise exception 'FAIL: send-athlete-reminders schedule is %, expected */5 * * * *', reminder.schedule;
  end if;
  if position('https://portal.dualperformance.au/api/reminders' in reminder.command) = 0 then
    raise exception 'FAIL: send-athlete-reminders no longer calls the portal reminders endpoint';
  end if;
  if position('vault.decrypted_secrets' in reminder.command) = 0
     or position('reminders_cron_secret' in reminder.command) = 0 then
    raise exception 'FAIL: send-athlete-reminders must read its bearer token from Vault';
  end if;
  if position('timeout_milliseconds := 60000' in reminder.command) = 0 then
    raise exception 'FAIL: send-athlete-reminders HTTP timeout drifted from 60000ms';
  end if;
  if not reminder.active then
    raise warning 'send-athlete-reminders is scheduled but inactive (paused for maintenance?)';
  end if;

  select * into retention from cron.job where jobname = 'purge-cron-run-history';
  if not found then
    raise exception 'FAIL: purge-cron-run-history is not scheduled';
  end if;
  if position('limit 10000' in retention.command) = 0
     or position('interval ''30 days''' in retention.command) = 0 then
    raise exception 'FAIL: purge-cron-run-history no longer deletes in bounded batches with 30-day retention';
  end if;

  if not exists (select 1 from vault.secrets where name = 'reminders_cron_secret') then
    raise exception 'FAIL: Vault secret reminders_cron_secret is missing';
  end if;
end;
$$;

-- Informational: how much history is retained, and recent outcomes.
select
  (select count(*) from cron.job_run_details) as run_history_rows,
  (select min(start_time) from cron.job_run_details) as oldest_run,
  pg_size_pretty(pg_total_relation_size('cron.job_run_details')) as run_history_size;

select j.jobname, d.status, count(*) as runs, max(d.start_time) as last_run
from cron.job_run_details d
join cron.job j using (jobid)
where d.start_time > now() - interval '24 hours'
group by j.jobname, d.status
order by j.jobname, d.status;
