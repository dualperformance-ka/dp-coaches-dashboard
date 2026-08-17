# Dual Performance coaches dashboard

Private coaching workspace for squad monitoring, programming, nutrition, applications, notifications, and coach follow-through.

## What the dashboard now enforces

- A coach access key is required before any dashboard API returns athlete data.
- The active coach name is attached to API requests and coaching actions.
- Coaching commitments live in `public.coach_actions` with owner, due date, priority, status, notes, and outcome.
- Action data is server-only: RLS is enabled and `anon`/`authenticated` have no table grants.
- Athlete and AI APIs return no data without the coach key.
- Mobile navigation, PWA registration, keyboard focus states, and accessible action dialogs are enabled.
- Duplicate weekly check-ins are surfaced as a data warning instead of being silently suppressed.
- Coaches can restart any athlete's programme at Week 0 or Week 1 on a chosen
  Monday without deleting check-ins, activities, photos, or earlier programming.

## Restarting an athlete's programme

Open **Nutrition**, select the athlete (coaches training as athletes are included),
then choose **Restart programme**. Select the effective Monday and enter `1` for
Week 1 or `0` for a new Discovery Week.

The protected athletes API stores the new anchor and restart metadata in
`athlete_data`. Sessions already planned from that Monday onward keep their dates
and content but are renumbered to the new programme sequence. A future-dated
restart keeps the previous programme anchor active until the selected Monday.

## Required Vercel environment

Copy `.env.example` into the Vercel project settings and provide the real values. `DASHBOARD_ACCESS_KEY` is the key coaches enter. During rollout it falls back to `ADMIN_KEY`, but a separate long random value is recommended.

Deploy only after the `coach_actions` migration has been applied. The live Supabase project received migration `coach_actions` on 17 July 2026; the matching source is in `supabase/migrations/202607170001_coach_actions.sql`.

## Safe rollout order

1. Add `DASHBOARD_ACCESS_KEY` and `COACH_NAMES` to Vercel.
2. Deploy this dashboard.
3. Confirm a request without `X-Dashboard-Key` returns `401` for `/api/actions?mode=session`, `/api/athletes`, and `/api/coach-data`.
4. Unlock the UI, create one test action, assign it, add an outcome, complete it, then reopen it.
5. Test Overview, Programming, Nutrition, Notify, and a full athlete view on desktop and mobile.

## Important security follow-up

The dashboard surface is now gated, but the shared Supabase project still contains legacy browser-direct policies used by the athlete portal. Do not remove those policies from this repository alone: move the remaining dashboard browser writes behind server APIs, verify the athlete portal’s authenticated policies, then tighten legacy `anon` policies in a coordinated portal release.

## Vercel function budget

This repository currently has 16 top-level endpoint files in `api/`; the old
claim that it had 11 and one Hobby slot free was stale. Check the active Vercel
plan's current function allowance before adding another endpoint. Shared helpers
belong in `server/`. The Strava webhook is therefore a rewrite to
`/api/strava?mode=webhook`, and the repaired OAuth callback replaces the broken
`strava-callback-fixed.js` file rather than increasing the endpoint count.

## Strava cache and webhook rollout

1. Apply `supabase/migrations/202608170001_strava_activity_cache.sql` before the
   code deploy. The table is RLS-enabled and available only to `service_role`.
2. Add `STRAVA_WEBHOOK_VERIFY_TOKEN` (a long random value) to Vercel. After
   Strava creates the subscription, also add its numeric id as
   `STRAVA_WEBHOOK_SUBSCRIPTION_ID`.
3. Deploy, then create the one app-wide subscription with Strava's
   `POST /api/v3/push_subscriptions`, using
   `https://YOUR-DOMAIN/api/strava-webhook` as `callback_url` and the same
   verification token. Never commit the client secret or token.
4. Reconnect athletes once with the updated
   `activity:read_all,profile:read_all` scope so configured HR/pace zones can be
   cached monthly. Existing athletes keep activity sync but will not have
   personal zones until they re-consent.

Week views now read activity summaries from Supabase. Activity detail, HR zones,
and long-run streams are fetched only when a coach opens that activity and are
then cached permanently. Webhooks invalidate the 15-minute list cache and record
deauthorizations; the next protected read refreshes changed summaries.

## Today triage rollout

The default coach screen is a server-ranked queue from
`GET /api/coach-data?mode=triage`. It currently ships the three non-Strava
signals: pain/coach alert, gone quiet, and compliance drift. Opening Today does
not load the full roster dashboard or prefetch Strava data.

Manual deployment order:

1. Deploy the dashboard without adding another Vercel function. Gone-quiet uses
   the existing five-day body/session windows and does not depend on a new view.
2. Apply `supabase/migrations/20260805011628_coach_triage_signals.sql` in
   Supabase to enable pain and explicit coach-alert signals.
3. Confirm an unauthenticated triage request returns `401`, then unlock the
   dashboard and confirm Today shows the active roster clear count.
4. Populate `daily_body_logs.pain` (0–10) or `coach_alert` through the approved
   athlete ingest source before expecting pain rows. Soreness is not treated as
   pain.

The Strava divergence and over-pacing rows are intentionally not included. They
must wait for the approved `strava_activities` summary cache and lazy permanent
lap-detail cache.

### Compliance drift (row 4)

Needs no migration and no new function. It reads `planned_sessions` and
`training_session_logs`, both of which the triage snapshot already fetched; the
planned-session window simply reaches back to Monday instead of starting at
today. Design and rationale: `docs/triage-row-4-compliance-drift.md`.

Behaviour worth knowing before you read the queue:

- Monday-anchored week in `Australia/Adelaide`. The row is only eligible from
  **Thursday** onward, so expect no drift rows Monday to Wednesday.
- Fires below 60% of sessions planned **up to today** — not of the whole week.
- A session counts as completed if `planned_sessions.status` is
  `done`/`complete`/`completed`, **or** a distinct `training_session_logs` entry
  exists on that date. Both halves fail toward "completed", so the queue
  under-reports drift rather than producing rows you'd disagree with.
- Suppressed for anyone already flagged with pain or gone quiet — they would
  otherwise appear twice and inflate `counts.flagged`.
- Athletes with nothing prescribed never appear. That is a programming gap, not
  athlete drift.

If drift rows fire on athletes you would not have called, the 0.60 threshold is
`COMPLIANCE_MIN_RATIO` in `api/coach-data.js`.

## Local checks

```bash
for f in api/*.js public/*.js; do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('vercel.json')); console.log('vercel.json OK')"
python3 -m http.server 4173 -d public
```
