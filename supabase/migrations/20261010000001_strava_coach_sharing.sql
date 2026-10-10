-- Athlete-consented Strava activity sharing, and the coach's match decisions.
--
-- ADDITIVE ONLY. Two new tables. Nothing that exists is altered, and the
-- Strava cache itself (strava_activities, owned and synced by the athlete
-- portal) is not touched: activities are never copied. Programmed versus
-- unprogrammed is derived at read time from planned_sessions, the athlete's
-- logs and the rows below, so there is no second activity store to drift.
--
-- Apply BEFORE either release. Both releases fail closed without it: the
-- portal's sharing toggle reports "unavailable" and the dashboard treats every
-- athlete as not sharing, which is exactly today's behaviour.
--
-- Security model follows 20260906000001_coach_review_and_signal_state: RLS on,
-- no grants to anon or authenticated, service_role only. The athlete reaches
-- strava_coach_sharing only through the portal's athlete-authenticated route,
-- and coaches reach both tables only through the dashboard's coach-gated
-- routes. Neither browser can read or write either table directly.
--
-- Existing indexes already serve the read path:
--   strava_activities_athlete_start_idx (athlete_code, start_date_local desc)
--   planned_sessions_athlete_date_idx   (athlete_code, planned_date)
--   strava_webhook_events_owner_idx     (owner_id, processed_at)
--
-- Rollback: rollback/20261010000001_strava_coach_sharing_down.sql

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Consent
--
-- One row per athlete, written only by the athlete (portal route). A coach can
-- never create, extend or restore it. Revocation keeps the row with
-- revoked_at set, so "who could see what, when" stays answerable, and the
-- coach read checks status on every request: revoking takes effect on the
-- next load, not the next deploy.
--
-- consent_version is the version of the wording the athlete agreed to. If the
-- wording changes materially, bump the version in both repos and the old
-- consent stops counting until the athlete agrees again.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.strava_coach_sharing (
  athlete_code     text primary key references public.athletes(code) on update cascade on delete cascade,
  status           text not null check (status in ('granted', 'revoked')),
  consent_version  text not null check (char_length(consent_version) between 1 and 32),
  granted_at       timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text check (revoked_reason is null or revoked_reason in ('athlete', 'strava_disconnected', 'strava_deauthorized')),
  updated_at       timestamptz not null default now(),

  constraint strava_coach_sharing_granted_has_time
    check (status <> 'granted' or granted_at is not null),
  constraint strava_coach_sharing_revoked_has_time
    check (status <> 'revoked' or revoked_at is not null)
);

comment on table public.strava_coach_sharing is
  'Athlete consent for their assigned coaches to see Strava activity SUMMARIES in the coaches dashboard. Written only by the athlete via the portal. No row, or status revoked, means coaches see nothing from strava_activities.';
comment on column public.strava_coach_sharing.revoked_reason is
  'athlete = turned off in Preferences; strava_disconnected = athlete disconnected Strava in the portal; strava_deauthorized = athlete revoked the app on strava.com.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Coach match decisions
--
-- A coach confirming or rejecting the pairing of one Strava activity with one
-- programmed session. Only the decision is stored: no activity payload, so
-- this table never becomes a second copy of Strava data.
--
-- session_key is what the portal keys every session by: planned_sessions
-- notion_page_id when present, else id (sessionKeyFor in
-- server/performance-summary-core.js). There is deliberately no foreign key to
-- strava_activities: an activity deleted on Strava disappears from the cache,
-- and its decision simply stops applying.
--
-- The two partial unique indexes are the database-level guarantee behind the
-- matching rules: one activity confirms at most one session, and one session
-- is confirmed by at most one activity. Rejections are unlimited.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.strava_activity_reviews (
  id                  uuid primary key default gen_random_uuid(),
  athlete_code        text not null references public.athletes(code) on update cascade on delete cascade,
  strava_activity_id  bigint not null check (strava_activity_id > 0),
  session_key         text not null check (char_length(session_key) between 1 and 80),
  decision            text not null check (decision in ('confirmed', 'rejected')),
  decided_by          text not null,
  decided_at          timestamptz not null default now(),

  constraint strava_activity_reviews_pair unique (athlete_code, strava_activity_id, session_key)
);

comment on table public.strava_activity_reviews is
  'Coach confirmations and rejections of Strava activity to programmed session matches. A rejected pair is never re-matched automatically.';
comment on column public.strava_activity_reviews.decided_by is
  'Coach handle resolved server-side from the coaches table. Never browser-supplied on its own.';

create unique index if not exists strava_activity_reviews_one_session_per_activity
  on public.strava_activity_reviews (athlete_code, strava_activity_id)
  where decision = 'confirmed';

create unique index if not exists strava_activity_reviews_one_activity_per_session
  on public.strava_activity_reviews (athlete_code, session_key)
  where decision = 'confirmed';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Privileges
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.strava_coach_sharing enable row level security;
revoke all on table public.strava_coach_sharing from public, anon, authenticated;
revoke all on table public.strava_coach_sharing from service_role;
grant select, insert, update, delete on table public.strava_coach_sharing to service_role;

alter table public.strava_activity_reviews enable row level security;
revoke all on table public.strava_activity_reviews from public, anon, authenticated;
revoke all on table public.strava_activity_reviews from service_role;
grant select, insert, update, delete on table public.strava_activity_reviews to service_role;

commit;
