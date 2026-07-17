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

## Required Vercel environment

Copy `.env.example` into the Vercel project settings and provide the real values. `DASHBOARD_ACCESS_KEY` is the key coaches enter. During rollout it falls back to `ADMIN_KEY`, but a separate long random value is recommended.

Deploy only after the `coach_actions` migration has been applied. The live Supabase project received migration `coach_actions` on 17 July 2026; the matching source is in `supabase/migrations/202607170001_coach_actions.sql`.

## Safe rollout order

1. Add `DASHBOARD_ACCESS_KEY` and `COACH_NAMES` to Vercel.
2. Deploy this dashboard.
3. Confirm a request without `X-Dashboard-Key` returns `401` for `/api/session`, `/api/athletes`, and `/api/coach-data`.
4. Unlock the UI, create one test action, assign it, add an outcome, complete it, then reopen it.
5. Test Overview, Programming, Nutrition, Notify, and a full athlete view on desktop and mobile.

## Important security follow-up

The dashboard surface is now gated, but the shared Supabase project still contains legacy browser-direct policies used by the athlete portal. Do not remove those policies from this repository alone: move the remaining dashboard browser writes behind server APIs, verify the athlete portal’s authenticated policies, then tighten legacy `anon` policies in a coordinated portal release.

## Local checks

```bash
for f in api/*.js public/*.js; do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('vercel.json')); console.log('vercel.json OK')"
python3 -m http.server 4173 -d public
```
