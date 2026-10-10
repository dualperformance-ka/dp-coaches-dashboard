# All activities: shared Strava activity in the coaches dashboard

Every Strava activity the portal has synced for an athlete, classified against
their programme, in the athlete's **Training** tab. Connecting Strava in the
portal is the only step. Covers running, cycling,
swimming, strength, walking and every other Strava sport type.

## Who owns what

| Concern | Owner | Notes |
| --- | --- | --- |
| OAuth, token refresh, webhook, cron drain, 180-day backfill, dedupe, deletes | Athlete portal (`api/strava.js`, `api/_lib/strava-*.js`) | Unchanged. Already stores every sport type in `strava_activities`, upserted on `(athlete_code, strava_activity_id)`. |
| Connect and disconnect | Athlete portal | Connected = activities visible to the athlete's coaches. Disconnect and deauthorisation purge the cache. |
| Reading, classifying, coach decisions | This dashboard | `server/coach-strava-activities.js`, `server/strava-activity-classifier.js`. Reads the cache only; never calls Strava. |
| Matching rules | Shared | `public/js/strava-match.js` is byte-identical to the portal's copy. |

`server/strava-cache.js` and the athlete modes of this repo's `api/strava.js`
target an older cache schema (`activity_id`, `activity_date`, `streams`) that
was never applied to production. They are not used here and were left alone.

## Access (checked on every request)

1. `requireCoach` (dashboard key), then `resolveCoachIdentity` (registered,
   enabled coach) and `assertAthleteAllowed` (coach_athletes scope).
2. The athlete has Strava connected (`athlete_data` key `strava_tokens`,
   projected to `strava_athlete_id` so tokens never leave the database). Not
   connected means `strava_activities` is not read.
3. `STRAVA_COACH_SHARING=off` hides the view. Unset means on.

Coaches receive a field allowlist per activity (`coachActivitySummary`): name,
type, local date and start time, distance, moving and elapsed time, pace or
speed, average and max HR, elevation gain, average power, Relative Effort,
source device, indoor flag and the strava.com link. Never tokens (the token row
is projected to `strava_athlete_id` inside PostgREST), streams, laps, route
polyline, coordinates or location strings.

## Classification

Statuses: **programmed** (completed a prescribed session), **unprogrammed**
(not prescribed; additional work, never a compliance failure), **needs review**,
**missed**, **awaiting sync**, **upcoming**.

Order of authority for a session's activity:

1. Coach confirmation (`strava_activity_reviews`).
2. The athlete's recorded match (`athlete_data.logs[key].__stravaMatch`).
3. Automatic matching with the portal's matcher, tolerances and greedy order.
   Strength sessions, which the portal does not match, pair with a same-day
   WeightTraining/Crossfit activity; a generic Workout or HIIT goes to review.

Rejections by the coach or the athlete ("Not this run") remove that pair from
every step until cleared. Different sport types never auto-match; a coach can
link any activity to a session manually.

Coach-side rules only ever reduce certainty: a quality prescription met by an
activity the athlete named easy/recovery goes to review, and a quality session
completed without effort data is flagged "structure not verified".

A session is **missed** only when its day has ended, no activity or portal log
completes it, and sync is current: no queued webhook events, and something has
synced since that day (two-day grace). Otherwise it is **awaiting sync**.

## Totals

- **Actual** = every shared activity (programmed, unprogrammed, pending review)
  plus programmed sessions completed in the portal with no Strava activity,
  taken from the athlete's log. An activity that completed a session is counted
  once, from the activity.
- **Compliance** = completed ÷ (completed + missed), programmed sessions only.
  Unprogrammed work, upcoming sessions and pending reviews are excluded.
- Running variance is actual minus prescribed for the whole week, shown with the
  planned distance still to come.

## Rollout

1. Apply `supabase/migrations/20261010000001_strava_activity_reviews.sql`, then
   run `supabase/tests/strava-activity-reviews.verify.sql`. Only coach
   confirm/reject needs it; the view itself works without it.
2. Deploy this dashboard. No portal change is required.

Rollback: set `STRAVA_COACH_SHARING=off` (instant, no data change), or run
`supabase/rollback/20261010000001_strava_activity_reviews_down.sql`.

## Strava terms

Strava's written API agreement says a user's data may only be shown to that
user. Strava has told at least one coaching platform that coaching
relationships are not the target of that rule. Worth describing this
coach-display use case in the Developer Program submission.
