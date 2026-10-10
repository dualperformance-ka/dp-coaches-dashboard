# All activities: shared Strava activity in the coaches dashboard

Every Strava activity an athlete has chosen to share, classified against their
programme, in the athlete's **Training** tab. Covers running, cycling,
swimming, strength, walking and every other Strava sport type.

## Who owns what

| Concern | Owner | Notes |
| --- | --- | --- |
| OAuth, token refresh, webhook, cron drain, 180-day backfill, dedupe, deletes | Athlete portal (`api/strava.js`, `api/_lib/strava-*.js`) | Unchanged. Already stores every sport type in `strava_activities`, upserted on `(athlete_code, strava_activity_id)`. |
| Consent grant and revoke | Athlete portal, Preferences | Writes `strava_coach_sharing`. Disconnect and deauthorisation revoke it. |
| Reading, classifying, coach decisions | This dashboard | `server/coach-strava-activities.js`, `server/strava-activity-classifier.js`. Reads the cache only; never calls Strava. |
| Matching rules | Shared | `public/js/strava-match.js` is byte-identical to the portal's copy. |

`server/strava-cache.js` and the athlete modes of this repo's `api/strava.js`
target an older cache schema (`activity_id`, `activity_date`, `streams`) that
was never applied to production. They are not used here and were left alone.

## Access boundary (checked on every request)

1. `requireCoach` (dashboard key), then `resolveCoachIdentity` (registered,
   enabled coach) and `assertAthleteAllowed` (coach_athletes scope).
2. `STRAVA_COACH_SHARING=on` in the deployment. Off by default.
3. A `granted` row in `strava_coach_sharing` at the current consent version
   (`2026-10`). No row, revoked, an older version, or the table missing all
   mean "not shared", and `strava_activities` is not read at all.

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

1. Apply `supabase/migrations/20261010000001_strava_coach_sharing.sql`, then run
   `supabase/tests/strava-coach-sharing.verify.sql`.
2. Deploy the portal release (Preferences toggle, revoke on disconnect).
3. Deploy this dashboard. All activities shows "switched off" until step 4.
4. When you are satisfied the use fits your Strava API agreement, set
   `STRAVA_COACH_SHARING=on` in the dashboard's Vercel project and redeploy.
   Set the same variable in the portal project to show athletes the toggle.

Rollback: unset `STRAVA_COACH_SHARING` (instant, no data change), or run
`supabase/rollback/20261010000001_strava_coach_sharing_down.sql`.

## Strava terms

Strava's written API agreement says a user's data may only be shown to that
user. Strava has told at least one coaching platform that coaching
relationships are not the target of that rule, but that is not in the written
terms. Describe this coach-display use case in the Developer Program
submission and get Strava's answer in writing before switching it on.
