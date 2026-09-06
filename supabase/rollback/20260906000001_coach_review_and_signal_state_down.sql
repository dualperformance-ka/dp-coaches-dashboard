begin;

-- Both tables are coach-owned and hold no athlete-submitted data: dropping them
-- loses which days a coach had marked reviewed and which signals were resolved.
-- Every signal recomputes from live data on the next load, and unreviewed days
-- simply return to the review queue, so nothing athlete-facing is affected.

drop table if exists public.coach_signal_state;
drop table if exists public.coach_session_reviews;

commit;
