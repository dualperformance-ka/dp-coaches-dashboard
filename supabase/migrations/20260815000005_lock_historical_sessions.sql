-- Close the gap between "completed" and "locked".
--
-- WHY THIS EXISTS
--
-- 20260815000002 added planned_sessions.locked_at, and the guard trigger in
-- 20260815000004 refuses prescription edits on any session where it is set.
-- But locked_at is only stamped when an athlete completes a session from now
-- on. Every session completed BEFORE that migration has locked_at null.
--
-- planned_sessions.status is constrained to 'Planned' | 'Completed' | 'Missed'
-- | 'Sick'. Anything that is not 'Planned' is a record of what happened, not a
-- plan that can still change — but with locked_at null, the database guard
-- would have let a later "this and future" edit rewrite it.
--
-- This backfill closes that gap for the sessions that already exist.
--
-- Rollback: rollback/20260815000005_lock_historical_sessions_down.sql

begin;

-- updated_at is deliberately left alone: this is bookkeeping, not a coach edit,
-- and "recently modified programmes" should not light up with 500 rows.
--
-- No athlete is notified. locked_at is in the excluded-column list of
-- trg_log_planned_sessions_upd, so the trigger fires and writes nothing.
update public.planned_sessions
   set locked_at = coalesce(locked_at, now())
 where status <> 'Planned'
   and locked_at is null;

-- Keep the two in step from here on. A session moving to Completed, Missed or
-- Sick locks itself; a session moved back to Planned by a coach unlocks, which
-- is the one legitimate way to reopen something for editing.
create or replace function public.sync_session_lock()
returns trigger
language plpgsql
as $function$
begin
  if new.status <> 'Planned' and new.locked_at is null then
    new.locked_at := now();
  elsif new.status = 'Planned' and old.status is distinct from 'Planned' then
    new.locked_at := null;
  end if;
  return new;
end $function$;

drop trigger if exists trg_sync_session_lock on public.planned_sessions;
create trigger trg_sync_session_lock
  before insert or update of status on public.planned_sessions
  for each row execute function sync_session_lock();

commit;
