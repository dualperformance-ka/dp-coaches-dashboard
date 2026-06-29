-- 202606300001_discovery_session_columns.sql
--
-- Discovery / Notes session support — schema safety net.
--
-- The athlete portal's ingest.js writes structured fields onto training_session_logs
-- (distance_km, duration_min, pace, rpe, feel, raw_sets) for run/strength logs, and
-- leaves them NULL for note-only "Discovery" logs. The base migration
-- 202606240001_structured_athlete_ingest.sql may predate some of those columns.
--
-- Verified 2026-06-30 against the live project (rugdupplsswxmpoudhpv): all six
-- columns are already present, so this migration is a NO-OP there. It exists so a
-- fresh database, branch, or replica provisioned from older migrations still ends
-- up with the columns ingest.js expects. Every statement is idempotent
-- (ADD COLUMN IF NOT EXISTS) and all columns are nullable — safe to run repeatedly.
--
-- Discovery logs themselves need no new columns: the dashboard reads them via the
-- existing session_category / exercise_log / notes / session_date fields.

ALTER TABLE public.training_session_logs ADD COLUMN IF NOT EXISTS distance_km  numeric;
ALTER TABLE public.training_session_logs ADD COLUMN IF NOT EXISTS duration_min numeric;
ALTER TABLE public.training_session_logs ADD COLUMN IF NOT EXISTS pace         text;
ALTER TABLE public.training_session_logs ADD COLUMN IF NOT EXISTS rpe          numeric;
ALTER TABLE public.training_session_logs ADD COLUMN IF NOT EXISTS feel         numeric;
ALTER TABLE public.training_session_logs ADD COLUMN IF NOT EXISTS raw_sets     jsonb;
