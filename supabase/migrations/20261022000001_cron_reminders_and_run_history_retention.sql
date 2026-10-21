-- pg_cron source of truth: athlete reminders and run-history retention.
--
-- APPLY ONLY WITH EXPLICIT APPROVAL. It changes production scheduling and adds
-- a job that deletes old cron.job_run_details rows. See
-- docs/vercel-supabase-timeout-recovery.md for the preflight checks.
--
-- Idempotent: cron.schedule() upserts by job name (pg_cron 1.6; Supabase docs,
-- "Cron > Quickstart > Edit a job"), keeping the existing jobid and its run
-- history. Running this file twice leaves exactly the same two jobs. It never
-- writes to cron.job directly and contains no secret: the bearer token is read
-- from Vault by name at run time.
--
-- 1. send-athlete-reminders
--    Schedule: every five minutes. It ran every minute until 19 Oct 2026
--    (1,440 runs that day, 440 failed during the incident) and was moved to
--    */5 by hand; this file records that. Do not go faster than every five
--    minutes. The endpoint is idempotent per window: morning reminders are
--    sent once per local day during the 5am hour (12 runs, one send), and coach
--    updates are debounced two minutes, so */5 delays a coach ping by at most
--    five minutes.
--    Endpoint: the athlete portal's /api/reminders (not this repository's
--    copy, which no scheduler calls).
--    Secret:   Vault secret named reminders_cron_secret. Never commit its value.
--    Timeout:  pg_net timeout_milliseconds 60000 (unchanged from live). pg_net
--              is asynchronous, so this bounds the background worker's wait,
--              not the cron transaction.
--
-- 2. purge-cron-run-history
--    pg_cron never deletes cron.job_run_details on its own (Supabase docs,
--    "Cron > Inspecting job runs"); it had grown to ~159k rows / 55 MB by
--    21 Oct 2026. Keep 30 days for incident investigation, delete older rows
--    in bounded batches of at most 10,000 per hourly run so no single
--    transaction holds many row locks or generates a large burst of WAL.
--    The backlog clears in roughly a dozen runs; afterwards each run deletes
--    the ~hour of rows that just aged out. Deleting rows does not shrink the
--    table on disk; see the runbook for the one-off space reclaim.

do $$
begin
  if to_regnamespace('cron') is null then
    raise exception 'pg_cron is not installed in this database';
  end if;
  if to_regnamespace('net') is null then
    raise exception 'pg_net is not installed in this database';
  end if;
  -- Presence only: the decrypted value is never selected here.
  if not exists (select 1 from vault.secrets where name = 'reminders_cron_secret') then
    raise exception 'Vault secret reminders_cron_secret is missing; create it before scheduling reminders';
  end if;
end;
$$;

select cron.schedule(
  'send-athlete-reminders',
  '*/5 * * * *',
  $cmd$
  select net.http_get(
    url := 'https://portal.dualperformance.au/api/reminders',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret' limit 1)
    ),
    timeout_milliseconds := 60000
  );
  $cmd$
);

select cron.schedule(
  'purge-cron-run-history',
  '17 * * * *',
  $cmd$
  delete from cron.job_run_details
  where runid in (
    select runid
    from cron.job_run_details
    where start_time < now() - interval '30 days'
    order by runid
    limit 10000
  );
  $cmd$
);
