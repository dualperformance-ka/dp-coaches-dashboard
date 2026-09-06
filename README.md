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
- Weekly running, cycling, and swimming targets are coach-owned, keyed to the
  canonical programme week, draftable, publishable, and soft-removable. See
  `docs/weekly-sport-targets.md` for the API and rollout contract.

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
`/api/strava?mode=webhook`. OAuth uses the canonical `strava-callback.js`; the
broken duplicate callback has been removed rather than consuming another slot.

## Strava cache and webhook rollout

**Compliance boundary:** the coaches dashboard does not display Strava API data.
Strava's current API terms limit display to the athlete who authorised the
connection. Coaches work from the athlete's submitted Dual Performance training
logs, check-ins, session feedback, and programme compliance. The athlete portal
owns OAuth, activity display, matching, webhook sync, and disconnect.

1. Apply `supabase/migrations/202608170001_strava_activity_cache.sql` and
   `supabase/migrations/202608210001_strava_webhook_events.sql` before the code
   deploy. Both tables are RLS-enabled and available only to `service_role`.
2. Add `STRAVA_STATE_SECRET`, `STRAVA_REDIRECT_URI`, and
   `STRAVA_WEBHOOK_VERIFY_TOKEN` (long random values where applicable) to Vercel. After
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

The athlete portal obtains a short-lived signed OAuth URL server-side, can read
only its own Strava data, and can revoke the connection without exposing either
token. Webhooks are acknowledged through a durable inbox. Do not add coach-
scoped reads of `strava_activities` to this dashboard.

## Performance intelligence

No migration and no new endpoint. Two ES modules carry the derived logic and are
importable by tests as well as the browser:

- `public/run-analysis.js` — pace parsing, run-log parsing, `run_steps`
  flattening, lap-to-step matching, weekly load against a four-week baseline,
  session-type classification and adherence, progression series.
- `public/strength-analysis.js` — exercise history from the portal's `logs`
  blob (with a free-text fallback), per-exercise summaries, weekly tonnage. It
  imports `progressive-overload.js` and `overload-adapter.js`, which had been in
  the repository unused since before this phase; neither was changed.

Three things are worth knowing before reading the new tabs.

**Prescribed vs actual is fetched per session, not bulk-loaded.** Opening an
athlete's Training tab requests `?action=prescription` only for days that have
both a structured run prescription and an uploaded activity file. Where the
match cannot be made confidently the panel says so and falls back to session
totals rather than inventing a pairing:

- *auto-lap* — every lap is a ~1km device auto-lap, so the laps carry distance
  but not the session's structure.
- *lap-count-mismatch* — the athlete ran a different number of work reps than
  were prescribed.

**The progression engine only runs where the coach prescribed a rep range.**
`progressive-overload.js` decides by asking whether the athlete owned the range
before adding load, so without a range it cannot judge. Where a split has no
sets and reps, the row reports the observed load trend instead (Rising / Flat /
Steady, dotted underline) and says plainly that no recommendation is available.
Adding sets and reps to the split turns those rows into real coaching output.

**No analysis path reads `strava_activities`.** Everything derives from
athlete-uploaded FIT/TCX/GPX files, submitted portal logs, weekly check-ins and
`planned_sessions`, which keeps the compliance boundary documented above intact.
There is a test asserting this.

Signals added to the decision queue in this phase (load spike, wellness decline,
strength stall, easy-run RPE) are computed client-side after the full roster
load, because they need history the light triage endpoint deliberately does not
fetch. They merge into the same queue and resolve through the same
`coach_signal_state` row as everything else.

## Session review and signal resolution rollout

Apply `supabase/migrations/20260906000001_coach_review_and_signal_state.sql`
**before** the code deploy. It adds two coach-owned tables and touches nothing
the athlete portal reads or writes, so no portal release is needed.

- `coach_session_reviews` — one row per athlete per day a coach has reviewed.
  Absence of a row for a date with submitted training is what puts that day in
  the review queue. The reviewable unit is the athlete's **day**, not a single
  log row: strength writes one row per exercise, an athlete can log a run and a
  lift on one date, and unplanned work has no planned session to flag.
- `coach_signal_state` — durable, coach-shared resolution of triage rows,
  replacing the single `ack_alert` blob in `athlete_data`. Each row stores the
  fingerprint the signal was raised on, so a resolved row reappears by itself
  when the underlying values move. The legacy blob is still read on load so
  acknowledgements made before this release survive the deploy; nothing writes
  it any more.

Both reads are wrapped in `.catch()`. Deploying the code without the migration
degrades cleanly — nothing is reviewed and nothing is suppressed, which is the
pre-existing behaviour — but the write actions will fail until it is applied.

Deliberately **not** added: `completed_at` / `submitted_at` columns on
`planned_sessions`. Those would have to be written by the athlete portal. The
dashboard derives completion and submission from `athlete_data` (keys `ticked`
and `logs`) and `training_session_logs`, as it already does elsewhere. Promote
them later if the portal is ready to populate them.

After deploying:

1. Confirm Today shows one decision queue rather than three lists, and that
   `✓ Resolve` on a row removes it for both coaches.
2. Resolve a row, then change the underlying value (for example raise a pain
   score) and confirm the row returns.
3. Mark a day reviewed from the review rail and confirm it leaves the queue and
   shows `✓ Reviewed` on that day in the athlete's Training tab.

## Today triage rollout

The default coach screen is a server-ranked queue from
`GET /api/coach-data?mode=triage`. It ships four non-Strava signals: pain/coach
alert, gone quiet, compliance drift, and awaiting review. Opening Today does not
load the full roster dashboard or prefetch Strava data.

Once the full roster load finishes, the dashboard's own `buildActionList`
signals (niggle text, stress, motivation, sleep trend, nutrition against target,
weight drift) are handed to the same queue as `client_alert` rows and deduped
there by athlete — the server's ranking wins, and anything the client knows
about that athlete becomes a sub-line. There is one list, one severity scale and
one resolve verb; there is no second priority panel.

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
