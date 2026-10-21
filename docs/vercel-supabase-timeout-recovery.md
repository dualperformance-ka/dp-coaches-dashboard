# Vercel / Supabase timeout incident: recovery and maintenance runbook

Project: Vercel `dp-coaches-dashboard` (`prj_u1er4KzhuNW7NWwUbFtOkWkxLedk`),
Supabase `rugdupplsswxmpoudhpv` (ap-southeast-1, Postgres 17).

Nothing in this document runs by itself. Every write below needs explicit
approval, and the blocking steps need a maintenance window.

## What happened (17–20 October 2026)

1. `send-athlete-reminders` ran **every minute** (1,440 runs a day). Each run
   queued a `pg_net` request whose response lands in `net._http_response`.
2. pg_net's own expired-response cleanup ran 270,751 times, about 18.5 hours
   of database time in total, with one run lasting about 40 minutes.
   `net._http_response` grew to 198 MB of dead space for 72 live rows.
   `cron.job_run_details` (never pruned) reached about 159k rows / 55 MB.
3. Postgres ran out of headroom. PostgREST could not load its schema cache
   (5,835 `PGRST002`), there were 306 statement timeouts, and 440 reminder and
   33 reconcile cron starts failed.
4. The dashboard made it worse. Two browser loops polled every 12 s from
   every open tab, visible or not. The server-side Supabase fetches had no
   deadline, so each request waited until Vercel killed it: 962 runtime
   timeouts (`/api/actions` 510 at 15 s, `/api/athletes` 418 at 30 s,
   `/api/coach-data` 34 at 30 s). Each one held a PostgREST connection the
   database needed in order to recover.
5. It recovered when autovacuum finished on the bloated tables (00:14 UTC on
   20 Oct), immediately after the last Vercel timeout (00:13 UTC).

The application changes in this release (bounded Supabase requests, 503 +
Retry-After, visible-only 60 s polling with backoff) remove step 4. The
schedule and retention below remove steps 1 and 2. The one-off maintenance
reclaims the space that step 2 left behind.

## State on 22 October 2026 (before any of the steps below)

| Check | Value |
| --- | --- |
| `send-athlete-reminders` | `*/5 * * * *`, active, byte-identical to the migration |
| `net.http_request_queue` | 0 rows |
| `net._http_response` | 198 MB on disk, 72 live rows, 0 timed out, 0 errors |
| `cron.job_run_details` | 159,589 rows, 55 MB, oldest 27 Jun 2026 |
| Long-running transactions | 0 (of 29 connections) |
| Performance advisor | `table_bloat` on `net._http_response` |
| Vercel timeouts since 20 Oct 00:13 UTC | 0 |
| PostgREST `PGRST002` / statement timeouts, last 24 h | 0 / 0 |
| `postgres` role privileges | `MAINTAIN` + `DELETE` on both tables (owner `supabase_admin`) |
| `pg_repack` | available (1.5.2), not installed |

---

## Part A: preflight checks (read-only, any time)

Run these in the SQL editor before any maintenance and after deploys.

```sql
-- A1. Cron jobs and recent outcomes
select jobid, jobname, schedule, active from cron.job order by jobid;

select j.jobname, d.status, count(*) runs, max(d.start_time) last_run,
       round(avg(extract(epoch from d.end_time - d.start_time))::numeric, 2) avg_s
from cron.job_run_details d join cron.job j using (jobid)
where d.start_time > now() - interval '24 hours'
group by 1, 2 order by 1, 2;

-- A2. pg_net queue and responses
select count(*) as queued from net.http_request_queue;
select count(*) live_rows, min(created) oldest, max(created) newest,
       count(*) filter (where timed_out) timed_out,
       count(*) filter (where error_msg is not null) errors
from net._http_response;

-- A3. Table/index size and live/dead tuples
select s.schemaname || '.' || s.relname as rel,
       pg_size_pretty(pg_total_relation_size(s.relid)) total,
       pg_size_pretty(pg_relation_size(s.relid)) heap,
       pg_size_pretty(pg_indexes_size(s.relid)) indexes,
       s.n_live_tup, s.n_dead_tup, s.last_autovacuum
from pg_stat_all_tables s
where (s.schemaname, s.relname) in (('net','_http_response'), ('net','http_request_queue'), ('cron','job_run_details'));

-- A4. Locks and long-running transactions
select pid, usename, application_name, state, now() - xact_start as xact_age,
       wait_event_type, left(query, 80) as query
from pg_stat_activity
where xact_start is not null and now() - xact_start > interval '30 seconds'
order by xact_age desc;

select l.locktype, l.mode, l.granted, a.pid, a.application_name, now() - a.query_start as age
from pg_locks l join pg_stat_activity a using (pid)
where l.relation in ('net._http_response'::regclass, 'cron.job_run_details'::regclass);

-- A5. Run history
select count(*) rows, min(start_time) oldest,
       pg_size_pretty(pg_total_relation_size('cron.job_run_details')) size
from cron.job_run_details;

-- A6. Most expensive statements
select left(regexp_replace(query, '\s+', ' ', 'g'), 120) q, calls,
       round(total_exec_time::numeric / 1000, 1) total_s,
       round(mean_exec_time::numeric, 1) mean_ms,
       round(max_exec_time::numeric / 1000, 1) max_s
from extensions.pg_stat_statements
order by total_exec_time desc limit 15;
```

A7. Supabase performance advisors: Dashboard → Advisors → Performance (or
the `get_advisors` MCP tool). Expect `table_bloat` on `net._http_response`
until Part C is done.

A8. Project health: Dashboard → Project overview (all services healthy) and
Observability → Database (CPU, memory, connections).

A9. Recent Vercel timeouts by route: Vercel → `dp-coaches-dashboard` →
Observability → Errors, filter "Runtime Timeout". After this release, also
search the logs for `"event":"route_complete"` with `"status":503` and for
`"event":"supabase_request"` lines, which carry the failure `category`.

`supabase/tests/cron-configuration.verify.sql` checks A1 against the
migration and raises if the configuration has drifted.

---

## Part B: routine retention (non-blocking, needs approval to enable)

`supabase/migrations/20261022000001_cron_reminders_and_run_history_retention.sql`
is the source of truth for:

| Job | Schedule | What |
| --- | --- | --- |
| `send-athlete-reminders` | `*/5 * * * *` | `net.http_get` to `https://portal.dualperformance.au/api/reminders`, bearer from Vault secret `reminders_cron_secret`, `timeout_milliseconds := 60000` |
| `purge-cron-run-history` | `17 * * * *` | delete `cron.job_run_details` rows older than 30 days, at most 10,000 per run |

- It is idempotent. `cron.schedule()` upserts by name and keeps the jobid.
  The reminders command is byte-identical to the live one (md5
  `bca53e218a29630d0127eed329fd73ce`), so applying it changes nothing for
  that job.
- It never writes to `cron.job` and contains no secret.
- The first ~11 hourly runs clear the backlog (about 110k rows). After that,
  each run deletes about an hour's worth of aged-out rows, around 20 rows at
  current schedules. Steady state is roughly 12k rows.
- Rollback: `supabase/rollback/20261022000001_cron_reminders_and_run_history_retention_down.sql`
  unschedules the retention job only. It deliberately does not restore
  per-minute reminders.
- Verify afterwards with `supabase/tests/cron-configuration.verify.sql`.

The migration was exercised twice against a local Postgres using stand-ins
for pg_cron, pg_net and Vault (`supabase/tests/cron-configuration.fixture.sql`).
To repeat that, set `CRON_TEST_DATABASE_URL` to an empty local database and
run `node --test tests/cron-configuration.test.js`.

Deleting rows does not return disk space. It only makes the space reusable.
That is fine for `cron.job_run_details`: the table stops growing, and new
rows reuse the freed pages.

Do **not** change `pg_net.ttl` or extension-owned autovacuum settings. They
are system-level, need Supabase Support to grant `alter system`, and the
default 6 h TTL is not the problem once the producer runs every five minutes.

---

## Part C: one-off space reclaim for `net._http_response` (blocking)

**Needs an approved maintenance window.** `VACUUM FULL` takes an
`ACCESS EXCLUSIVE` lock: nothing can read or write the table until it
finishes, including pg_net's background worker. With 72 live rows the rewrite
itself takes seconds; the risk is waiting for the lock, which `lock_timeout`
bounds. It cannot run inside a transaction block, so it is never put in a
migration.

Only `send-athlete-reminders` produces pg_net traffic. `reconcile-active-athletes`
uses the synchronous `http` extension and does not touch `net.*`.

### C1. Before the window

- Approval recorded, and a quiet time chosen. Reminders pause for about five
  minutes. A morning reminder is sent on any run during the athlete's 5am
  local hour, so a pause in the middle of that hour loses nothing, but one
  spanning its end would skip that day's reminder. Avoid 18:30–19:30 UTC
  (5–6am in Adelaide during daylight saving).
- Run Part A. Stop if A4 shows a long-running transaction or a lock on
  `net._http_response` that is not pg_net's own short cleanup.

### C2. Pause the producer

```sql
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'send-athlete-reminders'),
  active := false
);
select jobname, active from cron.job where jobname = 'send-athlete-reminders';  -- expect false
```

### C3. Let in-flight requests finish

Wait at least 70 seconds: the request timeout is 60 s. Then:

```sql
select count(*) from net.http_request_queue;            -- expect 0
select max(created) from net._http_response;             -- not advancing
```

If the queue is not empty and is not draining, stop and go to C7.

### C4. Reclaim

```sql
set lock_timeout = '5s';
set statement_timeout = '120s';
vacuum (full, analyze, verbose) net._http_response;
```

- `lock_timeout` errors out rather than queueing behind (and in front of)
  everything else. If it fails on the lock, wait 30 s and try again; do not
  raise the timeout.
- `permission denied` / `must be owner`: stop. The table is owned by
  `supabase_admin`; on 22 Oct `postgres` had `MAINTAIN`, but if that has
  changed, open a Supabase Support ticket asking them to run it rather than
  trying to work around ownership.
- `pg_repack` is not a better option here. It needs installing as an
  extension plus the client binary, and it exists for large tables that
  cannot take a lock. This table holds 72 rows.

### C5. Resume the producer (always, even if C4 failed)

```sql
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'send-athlete-reminders'),
  active := true
);
```

### C6. Verify

```sql
select pg_size_pretty(pg_total_relation_size('net._http_response'));  -- expect well under 1 MB
select status, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'send-athlete-reminders')
order by start_time desc limit 3;                                     -- a new succeeded run within 5 min
select count(*), max(created) from net._http_response;                -- new response rows arriving
```

Then: A7 advisors (the `table_bloat` lint clears on the next refresh), the
dashboard loads, and `/api/actions`, `/api/athletes?action=acknowledgements`
and `/api/coach-data` answer 200.

### C7. Recovery if the job cannot be resumed

- `cron.alter_job` fails, or the job has disappeared: re-apply
  `20261022000001_cron_reminders_and_run_history_retention.sql`. It
  recreates the job by name with the same command, and the Vault secret
  check at the top tells you if the secret is missing.
- `VACUUM FULL` is still waiting or running past its window: find its pid in
  `pg_stat_activity` and run `select pg_cancel_backend(<pid>);`, then
  `pg_terminate_backend` only if the cancel does not take. A cancelled
  `VACUUM FULL` leaves the old table in place; nothing is lost. Then do C5.
- The pg_net worker looks stuck (queue grows while the job is active):
  `select net.worker_restart();`.
- Reminders still fail after resuming: check the portal's `/api/reminders`
  Vercel logs and the Vault secret by name
  (`select name from vault.secrets where name = 'reminders_cron_secret'`).
  Never select `decrypted_secret` in a shared session.

---

## Part D: optional space reclaim for `cron.job_run_details` (blocking)

Only worth doing once Part B has cleared the backlog. It is not urgent: the
table stops growing either way.

`VACUUM FULL cron.job_run_details` locks the table that **every** job writes
to at start and end, so all jobs must be paused for the window:

```sql
-- 1. Note which jobs are active now, then pause them all.
select jobid, jobname, active from cron.job order by jobid;
select cron.alter_job(job_id := jobid, active := false) from cron.job where active;
-- 2. Wait until nothing is running.
select count(*) from cron.job_run_details where status in ('starting', 'running');  -- expect 0
-- 3. Reclaim.
set lock_timeout = '5s';
set statement_timeout = '120s';
vacuum (full, analyze) cron.job_run_details;
-- 4. Re-activate exactly the jobs that were active in step 1.
select cron.alter_job(job_id := <jobid>, active := true);  -- once per job from step 1
```

Choose a window that avoids 16:00–16:15 UTC (the daily purge jobs).

---

## Recommended monitoring thresholds

| Signal | Threshold | Where |
| --- | --- | --- |
| Vercel "Runtime Timeout" on `/api/actions`, `/api/athletes`, `/api/coach-data` | any | Vercel Errors. After this release a timeout here means a new un-bounded call path. |
| `route_complete` with `status:503` | > 5 in 10 min | Vercel logs, search `"status":503` |
| `supabase_request` with `"slow":true` | > 20 per hour | Vercel logs |
| `PGRST002` | any | Supabase API logs |
| `send-athlete-reminders` failed runs | 3 in a row | `cron.job_run_details` |
| `net._http_response` size | > 50 MB, or live rows > 500 | A2/A3 |
| `cron.job_run_details` rows | > 20,000 after the backlog clears | A5 |
| pg_net cleanup mean time | > 50 ms | A6 (the `delete from net._http_response` statement) |
| Supabase CPU | > 80% sustained 10 min | Observability → Database |

## Related finding, not changed here

`public.reconcile_active_athletes()` (cron every 15 minutes) calls out
through the synchronous `http` extension with no timeout set. During the
incident its failed runs averaged 23 s each, holding a database backend for
the whole wait. Give it an explicit HTTP timeout, or move it to pg_net, in
the repository that owns that function.
