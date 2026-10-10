begin;

-- Dropping strava_coach_sharing withdraws every athlete's coach access to
-- Strava summaries at once (no row = not shared), which is the safe direction.
-- Dropping strava_activity_reviews loses coach match decisions only; the
-- dashboard falls back to automatic matching and the athlete's own record.
-- No Strava activity data lives in either table.

drop table if exists public.strava_activity_reviews;
drop table if exists public.strava_coach_sharing;

commit;
