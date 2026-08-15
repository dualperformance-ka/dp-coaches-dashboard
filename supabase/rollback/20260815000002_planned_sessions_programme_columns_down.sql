-- Rollback for 20260815000002_planned_sessions_programme_columns.sql
--
-- WARNING — READ BEFORE RUNNING.
--
-- Dropping prescription_mode makes every structured session unreadable: the
-- portal falls back to title matching, and any session whose prescription lives
-- in session_exercises will render with whatever workout_splits row happens to
-- share its title, or with nothing at all.
--
-- Dropping locked_at removes the completed-workout protection that
-- reject_locked_session_edit() depends on.
--
-- Only run this if no session has been made structured yet. The guard below
-- refuses otherwise. If you genuinely need to roll back after structuring
-- sessions, revert those sessions to legacy first.

begin;

do $$
declare n int;
begin
  select count(*) into n from public.planned_sessions where prescription_mode = 'structured';
  if n > 0 then
    raise exception
      'Refusing to roll back: % sessions are structured. Revert them to legacy prescription first, or their prescriptions become unreachable.', n;
  end if;
end $$;

-- Restore the original single trigger exactly as 202607090003 defined it.
drop trigger if exists trg_log_planned_sessions_ins on public.planned_sessions;
drop trigger if exists trg_log_planned_sessions_upd on public.planned_sessions;
drop trigger if exists trg_log_planned_sessions_del on public.planned_sessions;
drop trigger if exists trg_log_planned_sessions     on public.planned_sessions;

create trigger trg_log_planned_sessions
  after insert or update or delete on public.planned_sessions
  for each row execute function log_coach_change(
    'training', 'status,updated_at,created_at', 'title', 'planned_date');

drop index if exists public.planned_sessions_draft_idx;
drop index if exists public.planned_sessions_programme_week_idx;
-- planned_sessions_athlete_date_idx is left in place: it is a pure performance
-- win on a column pair the portal queries on every week load, and dropping it
-- would make the rollback slower than the thing it is rolling back.

alter table public.planned_sessions drop constraint if exists planned_sessions_programme_week_fk;
alter table public.planned_sessions drop constraint if exists planned_sessions_publish_state_check;
alter table public.planned_sessions drop constraint if exists planned_sessions_prescription_mode_check;
alter table public.planned_sessions drop constraint if exists planned_sessions_part_of_day_check;

alter table public.planned_sessions
  drop column if exists programme_week_id,
  drop column if exists publish_state,
  drop column if exists prescription_mode,
  drop column if exists part_of_day,
  drop column if exists day_order,
  drop column if exists locked_at,
  drop column if exists estimated_minutes,
  drop column if exists coach_notes;

commit;
