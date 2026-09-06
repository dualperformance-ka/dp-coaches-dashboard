-- Coach-owned session review state and durable triage signal resolution.
--
-- ADDITIVE ONLY. Two new tables, no changes to anything that already exists,
-- and nothing the athlete portal reads or writes. Applying this changes no
-- behaviour until the matching dashboard release ships.
--
-- Deliberately NOT included: completed_at / submitted_at columns on
-- planned_sessions. Those would have to be written by the athlete portal, which
-- lives in another repository and another release train. The dashboard derives
-- completion and submission from athlete_data (keys 'ticked' and 'logs') and
-- training_session_logs, exactly as it already does everywhere else, so this
-- phase needs no coordinated portal release. Promote them later if and when the
-- portal is ready to populate them.
--
-- Security model follows 20260727085203_lock_down_portal_rls and
-- 20260817052406_coach_owned_weekly_sport_targets: RLS on, no grants to anon or
-- authenticated, service_role only. Browsers reach both tables through the
-- coach-gated server routes, never directly.
--
-- Rollback: rollback/20260906000001_coach_review_and_signal_state_down.sql

begin;

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Session review state
--
-- The reviewable unit is an athlete's DAY, not a single log row. Strength
-- sessions write one training_session_logs row per exercise, an athlete can log
-- a run and a lift on the same date, and unplanned work has no planned_sessions
-- row to hang a flag on. "I have looked at Sarah's Tuesday" is both the coach's
-- actual unit of work and the only key that stays stable across all three.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.coach_session_reviews (
  id            uuid primary key default gen_random_uuid(),
  athlete_code  text not null references public.athletes(code) on update cascade on delete cascade,
  session_date  date not null,
  reviewed_by   text not null,
  reviewed_at   timestamptz not null default now(),
  note          text,

  constraint coach_session_reviews_identity unique (athlete_code, session_date)
);

comment on table public.coach_session_reviews is
  'One row per athlete per day a coach has reviewed. Absence of a row for a date with submitted training is what puts that day in the review queue.';
comment on column public.coach_session_reviews.reviewed_by is
  'Coach handle, from X-Coach-Name via the server route. Never browser-supplied on its own.';

create index if not exists coach_session_reviews_recent_idx
  on public.coach_session_reviews (reviewed_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Triage signal resolution
--
-- Replaces the ad-hoc `ack_alert` blob in athlete_data. That blob could hold a
-- single acknowledgement per athlete, was invisible to SQL, and only covered
-- the client-computed alerts — the server triage queue had no way to be
-- cleared at all.
--
-- The fingerprint is a hash of the values the signal was raised on. A resolved
-- signal stays quiet while its fingerprint is unchanged and returns on its own
-- when the underlying situation moves, so "resolve" never means "hide forever".
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.coach_signal_state (
  id            uuid primary key default gen_random_uuid(),
  athlete_code  text not null references public.athletes(code) on update cascade on delete cascade,
  signal_type   text not null check (char_length(signal_type) between 1 and 64),
  fingerprint   text not null check (char_length(fingerprint) between 1 and 200),
  resolved_by   text not null,
  resolved_at   timestamptz not null default now(),
  note          text,

  constraint coach_signal_state_identity unique (athlete_code, signal_type)
);

comment on table public.coach_signal_state is
  'Durable, coach-shared resolution of triage signals. One row per athlete per signal type; re-resolving updates the fingerprint in place.';
comment on column public.coach_signal_state.fingerprint is
  'Hash of the values the signal was raised on. The signal reappears when this changes, which is what stops resolve becoming permanent suppression.';

create index if not exists coach_signal_state_athlete_idx
  on public.coach_signal_state (athlete_code);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Privileges
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.coach_session_reviews enable row level security;
revoke all on table public.coach_session_reviews from public, anon, authenticated;
revoke all on table public.coach_session_reviews from service_role;
grant select, insert, update, delete on table public.coach_session_reviews to service_role;

alter table public.coach_signal_state enable row level security;
revoke all on table public.coach_signal_state from public, anon, authenticated;
revoke all on table public.coach_signal_state from service_role;
grant select, insert, update, delete on table public.coach_signal_state to service_role;

commit;
