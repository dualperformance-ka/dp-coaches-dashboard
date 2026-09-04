-- Namespaces existing training_session_logs.client_write_id values by athlete.
--
-- Run this in the SAME deploy as the api/ingest.js change that starts writing
-- "<ATHLETE_CODE>:<id>" instead of a bare "<id>".
--
-- Why the code changed: client_write_id carries a GLOBAL unique constraint, not
-- one scoped to the athlete, and the portal's id scheme ("strava_<activity id>")
-- is guessable. One athlete could POST a log whose id matched another athlete's
-- and the ON CONFLICT UPDATE would rewrite every column of that row, athlete_code
-- included — silently moving a session from one athlete's history to another's.
--
-- Why this backfill is needed: the upsert matches on the whole column. Without
-- it, the first re-sync after deploy would not match the existing unprefixed row
-- and would INSERT a duplicate instead of updating — the same session appearing
-- twice in a coach's compliance figures.
--
-- Idempotent: rows already carrying their athlete prefix are skipped, so running
-- it twice is harmless.

update public.training_session_logs
   set client_write_id = upper(athlete_code) || ':' || client_write_id
 where client_write_id is not null
   and athlete_code is not null
   and client_write_id not like (upper(athlete_code) || ':%');

-- Sanity check — expect 0 rows.
-- select count(*) from public.training_session_logs
--  where client_write_id is not null and athlete_code is not null
--    and client_write_id not like (upper(athlete_code) || ':%');
