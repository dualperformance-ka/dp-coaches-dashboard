begin;

-- Coach match decisions only. Dropping them returns every activity to
-- automatic matching and the athlete's own record. No Strava activity data
-- lives in this table.

drop table if exists public.strava_activity_reviews;

commit;
