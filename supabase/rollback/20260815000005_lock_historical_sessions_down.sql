-- Rollback for 20260815000005_lock_historical_sessions.sql
--
-- Removes the status/lock sync trigger and clears locked_at on sessions that
-- were locked by the backfill rather than by an athlete completing them.
--
-- Clearing locked_at makes those historical sessions editable again, which is
-- exactly the exposure the migration closed. Only run this if you are also
-- rolling back the programming feature.

begin;

drop trigger if exists trg_sync_session_lock on public.planned_sessions;
drop function if exists public.sync_session_lock();

-- Only the backfilled rows: a session an athlete genuinely completed through
-- the app keeps its lock.
update public.planned_sessions
   set locked_at = null
 where status <> 'Planned'
   and locked_at is not null;

commit;
