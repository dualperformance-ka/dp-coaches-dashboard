-- LOCAL TEST FIXTURE ONLY. Never run against Supabase.
--
-- A plain Postgres has no pg_cron, pg_net or Vault. This creates minimal
-- stand-ins with the same names and the pg_cron 1.6 semantics the migration
-- relies on (cron.schedule upserts by job name and keeps the jobid), so the
-- migration, its rollback and the verify script can be run twice in a row on a
-- throwaway database to prove they are idempotent:
--
--   psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/cron-configuration.fixture.sql
--   psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/20261022000001_cron_reminders_and_run_history_retention.sql
--   psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/migrations/20261022000001_cron_reminders_and_run_history_retention.sql
--   psql "$LOCAL_DB" -v ON_ERROR_STOP=1 -f supabase/tests/cron-configuration.verify.sql

create schema if not exists cron;
create schema if not exists net;
create schema if not exists vault;

create table if not exists cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text not null default 'localhost',
  nodeport int not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text,
  unique (jobname, username)
);

create table if not exists cron.job_run_details (
  jobid bigint,
  runid bigserial primary key,
  job_pid int,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname, username)
  do update set schedule = excluded.schedule, command = excluded.command
  returning jobid;
$$;

create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = job_name and username = current_user;
  return found;
end;
$$;

create or replace function cron.alter_job(
  job_id bigint, schedule text default null, command text default null,
  database text default null, username text default null, active boolean default null
) returns void language sql as $$
  update cron.job set
    schedule = coalesce(alter_job.schedule, job.schedule),
    command = coalesce(alter_job.command, job.command),
    active = coalesce(alter_job.active, job.active)
  where jobid = job_id;
$$;

create or replace function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 2000)
returns bigint language sql as $$ select 1::bigint $$;

create table if not exists vault.secrets (name text primary key, secret text);
create or replace view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
insert into vault.secrets (name, secret) values ('reminders_cron_secret', 'local-fixture-not-a-secret')
on conflict (name) do nothing;

-- The live job as it was found on 22 Oct 2026, so the migration is exercised
-- as an upsert of an existing job rather than a fresh insert.
select cron.schedule('send-athlete-reminders', '* * * * *', 'select 1');

-- Run history spanning the retention boundary: 25,000 rows older than 30 days
-- (more than two retention batches) and 500 recent ones.
insert into cron.job_run_details (jobid, status, start_time, end_time)
select 1, 'succeeded', now() - interval '45 days' + (g || ' seconds')::interval, null
from generate_series(1, 25000) g;
insert into cron.job_run_details (jobid, status, start_time, end_time)
select 1, 'succeeded', now() - (g || ' minutes')::interval, null
from generate_series(1, 500) g;
