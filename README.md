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

## Vercel Hobby function budget

The Hobby plan allows 12 Serverless Functions per deployment. This repository currently has 11 files in `api/`, leaving one slot free. Keep shared helpers in `server/`, not `api/`, and extend an existing endpoint with an explicit mode before adding another function. `/api/actions?mode=session` intentionally shares the actions function, and `/api/data` is the only Notion/Supabase data proxy.

## Today triage rollout

The default coach screen is a server-ranked queue from
`GET /api/coach-data?mode=triage`. It currently ships the first two non-Strava
signals: pain/coach alert and gone quiet. Opening Today does not load the full
roster dashboard or prefetch Strava data.

Manual deployment order:

1. Apply `supabase/migrations/20260805011628_coach_triage_signals.sql` in Supabase.
2. Deploy the dashboard without adding another Vercel function.
3. Confirm an unauthenticated triage request returns `401`, then unlock the
   dashboard and confirm Today shows the active roster clear count.
4. Populate `daily_body_logs.pain` (0–10) or `coach_alert` through the approved
   athlete ingest source before expecting pain rows. Soreness is not treated as
   pain.

The Strava divergence and over-pacing rows are intentionally not included. They
must wait for the approved `strava_activities` summary cache and lazy permanent
lap-detail cache.

## Local checks

```bash
for f in api/*.js public/*.js; do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('vercel.json')); console.log('vercel.json OK')"
python3 -m http.server 4173 -d public
```
