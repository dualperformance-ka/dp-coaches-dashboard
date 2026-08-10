-- Strength swap tracking.
--
-- Athletes can now substitute any exercise for a same-muscle alternative from
-- the portal's swap bank. Sets are stored under the exercise actually performed
-- so progressive overload follows the real movement, but that alone loses the
-- link back to what was prescribed: a swapped session reads on the coach
-- dashboard as though it was programmed that way, hiding both equipment gaps
-- and the niggles behind them.
--
-- These columns keep the prescription alongside the performance, and add the
-- muscle-group dimension that survives any substitution — so "is this athlete
-- progressing on vertical pulls?" stays answerable even when the exercise
-- changes week to week.
--
-- All columns are nullable and optional. api/ingest.js drops any it cannot
-- write and retries, so the portal keeps logging whether this migration lands
-- before or after the deploy. raw_payload carries the full submission either
-- way, so historic rows can be backfilled from it if ever needed.

alter table public.training_session_logs
  add column if not exists exercise_name text,
  add column if not exists programmed_exercise text,
  add column if not exists muscle_group text,
  add column if not exists is_swap boolean not null default false;

comment on column public.training_session_logs.exercise_name is
  'Exercise actually performed. Progression, PBs and history all key on this.';
comment on column public.training_session_logs.programmed_exercise is
  'Exercise the coach prescribed for this slot. Equals exercise_name when not swapped.';
comment on column public.training_session_logs.muscle_group is
  'Movement pattern label (e.g. "Lats — vertical pull"), stable across substitutions.';
comment on column public.training_session_logs.is_swap is
  'True when the athlete trained something other than the programmed exercise.';

-- Coach-side questions this serves: which movements get substituted most, and
-- what an athlete has actually trained a muscle group with over a block.
create index if not exists training_session_logs_swaps_idx
  on public.training_session_logs (athlete_code, is_swap, session_date desc)
  where is_swap;

create index if not exists training_session_logs_muscle_group_idx
  on public.training_session_logs (athlete_code, muscle_group, session_date desc);
