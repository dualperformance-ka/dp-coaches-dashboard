# Build prompts — Strava auto-complete + coach dashboard

Three prompts. Run them in separate sessions.

- **Prompt 1** ships on its own.
- **Prompt 1b** is additive — run it only after Prompt 1 has landed and passes.
- **Prompt 2** is independent of both.

---

## PROMPT 1 — Strava auto-complete for planned sessions

Copy everything between the rules.

---

You are working in the `dp-athlete-portal` repo. Read `README.md`,
`docs/backend-data-safety.md`, `api/strava.js`, `public/js/09-logging.js`,
`public/js/08-training.js` and `public/js/05-handbook.js` before writing any code.

### Goal

When an athlete completes a planned run and it appears on Strava, the portal
should recognise it and mark the session complete automatically. The athlete
should only ever have to supply what Strava cannot know: RPE, pain, and notes.

Today the athlete runs, Strava records it, and then they manually mark the same
session done in the portal. That duplicate entry is what we are removing.

### What already exists — do not rebuild it

- `api/strava.js` handles OAuth, token refresh with a 5-minute buffer, and a
  429 fallback that returns `{ connected: true, activitiesAvailable: false }`.
  Reuse this. Do not add a second Strava fetch path.
- `window._stravaLoadPromise` is set once in `public/js/02-login-goals.js` and
  awaited by consumers. Any new consumer must await the same promise — do not
  trigger another `/api/strava` request.
- `deriveCompletedKmFromStrava()` in `05-handbook.js` already parses activities
  for weekly volume. Match its date and sport-type handling exactly so the
  auto-complete tick and the weekly km ring can never disagree.
- `markSessionLogged()`, `stampSessionSubmitted()` and `markSessionDone()` in
  `09-logging.js` are the existing completion path. Auto-complete must route
  through these, not around them.

### Matching rules

Build a pure function, `matchActivityToSession(session, activities, opts)`, in a
new file `public/js/strava-match.js`. Pure in, pure out, no DOM, no fetch — it
must be unit-testable under `node --test`.

A candidate activity matches a planned run session when all of these hold:

1. `sport_type` (falling back to `type`) contains `run`, case-insensitive.
   Rides and weight training never auto-complete a run session.
2. `start_date_local` date part equals the session's `date`. No cross-day
   matching — a session planned Tuesday is not satisfied by a Wednesday run.
3. Distance is within tolerance of the planned distance from `plannedRunKm()`:
   the greater of 15% or 1.5km. A 13.1km run satisfies a 12km prescription; a
   4km commute does not satisfy a 12km long run.
4. The activity is not already claimed by another session that day. Resolve
   greedily by closest distance, so a double day assigns each run once.

Return `{ matched: true, activity, confidence: 'high'|'low', reasons: [] }` or
`{ matched: false, reasons: [] }`. Confidence is `low` when the session has no
parseable planned distance — in that case, match on sport type and date alone
but never auto-tick; only offer it.

### UI behaviour

- On the today card and in the day plan overlay, a `high` confidence match
  renders as a completed state with a Strava attribution line: distance, moving
  time, and a "Matched from Strava" note. Follow the existing `#kmSrcStrava`
  attribution pattern in `06-nutrition.js` for tone and iconography.
- A `low` confidence match renders as a suggestion, not a completion:
  "Looks like you ran this — 13.1 km, 66 min. Mark it done?" with a confirm
  button. Never silently complete on low confidence.
- Every auto-completed session gets a visible, one-tap "Not this session"
  override that unmatches it and restores the manual log form. Persist the
  rejection so the matcher does not re-suggest the same activity for that
  session. Store rejections under an `athlete_data` key of
  `strava_match_rejections` via the existing `portalStateWrite` path.
- After auto-completion, the remaining prompt is RPE, pain flag, and notes only.
  Do not ask for distance or duration again.

### Truthfulness and degradation

- When `/api/strava` returns `activitiesAvailable: false` (rate limited), the
  portal must fall back to the current manual completion flow silently. Do not
  show a stale tick, do not show an error. The existing warning copy in
  `10-boot.js` is the reference.
- When the athlete has never connected Strava, nothing about this feature is
  visible. No empty states, no upsell banners on the today card.
- Auto-completion writes must be idempotent. Reloading the portal three times
  must not produce three `training_session_logs` rows for the same session.
  Guard on `isSessionLogged()` before writing.

### Constraints

- The Vercel Hobby plan caps deployments at 12 serverless functions and the repo
  is already at the limit — `strava-callback` was merged into `strava.js` for
  this reason. Do not add a new file under `api/`. If you need server work, put
  it behind a `mode=` query param on an existing handler.
- No new npm dependencies.
- No direct Supabase queries from the browser. `scripts/check-portal.mjs`
  enforces this and must still pass.

### Tests

Add `tests/strava-match.test.js` covering, at minimum:

- exact distance match completes
- 15% over and 15% under both complete
- a 4km commute ride does not complete a 12km run session
- a WeightTraining activity never matches a run
- two runs on one day map to two sessions, not one twice
- a session with no planned distance returns `low` confidence
- a rejected pairing is not re-suggested

### Done means

`npm run check` passes, `node --test` passes, and the diff touches no
serverless function count. Show me the diff before committing anything.

---

## PROMPT 1b — Intensity check (additive, run after Prompt 1)

Copy everything between the rules. Do not run this until Prompt 1 has landed and
`npm run check` passes on it.

---

You are working in the `dp-athlete-portal` repo. `public/js/strava-match.js`
already exists and exports `matchActivityToSession()`, which matches a planned
run to a Strava activity on sport type, date and distance. Read it and
`tests/strava-match.test.js` before writing anything.

### The gap being closed

Distance and date alone cannot distinguish an executed session from a jog of the
same length. A prescription of `4 × 1500m` and an easy 13km run both produce a
13km run on the matching date. Today the matcher would auto-complete the tempo
session in both cases, which claims work that may not have happened.

This change does not attempt to verify rep structure. It answers a narrower,
cheaper question: was this run hard or easy, and does that agree with what was
prescribed.

### The signal

Use `relative_effort` divided by distance in km. It is already present in the
activity summary payload that `/api/strava` returns. Do not make an additional
Strava API call for this — the per-activity endpoints are rate limited across the
whole app and this feature does not justify spending that budget.

Reference values from real portal data:

| Session | Relative effort / km |
| --- | --- |
| Tempo, 4 × 1500m | 5.4 |
| Hill repeats, 12 × 90s | 3.4 |
| Long run | 2.8 |
| Easy 60 min | 2.4 |

Seed the quality/easy boundary at `3.0` as an exported, named constant. Do not
bury it as a magic number.

`relative_effort` is derived from heart rate and will be absent or zero for any
athlete running without a strap. When it is missing, this entire check is
skipped and the match falls through to Prompt 1's behaviour unchanged. Never
treat a missing value as "easy".

### Classifying the prescription

Add `classifyPrescribedIntensity(session)` to `strava-match.js`. It returns
`'quality' | 'easy' | 'unknown'` from the session name, type and any coach
override, using the parsing helpers already in `08-training.js` — do not write a
second parser.

Treat as quality: tempo, threshold, interval, rep/repeat, hill, fartlek, track,
time trial, race, and any name containing rep notation such as `4 x 1500m`,
`12 x 90s`, `6x400`.

Treat as easy: easy, recovery, steady, shakeout, long run.

Everything else is `unknown`, and `unknown` never changes the confidence.

### The rule, and note that it is asymmetric

- **Prescribed quality, executed easy** (below the threshold): downgrade the
  match to `low` confidence with reason `intensity_below_prescription`. Do not
  auto-tick. The athlete is asked to confirm: "This looks easier than the session
  you had planned — did you do the intervals?" Confirming completes it normally.

- **Prescribed easy, executed quality** (above the threshold): still
  auto-complete at `high` confidence. They ran the distance; they ran it harder
  than asked. Attach a `ran_above_prescription` reason to the match result and
  persist it on the session log so the coach dashboard can pick it up later.
  Do not surface this to the athlete. Chronic over-pacing of easy runs is a
  coaching conversation, not a portal nag, and telling an athlete they ran too
  fast in the moment they finished reliably produces the opposite behaviour.

- Either side `unknown`, or `relative_effort` missing: no change.

### Per-athlete calibration

The threshold is personal — relative effort scales with an individual's HR
profile. Structure the code so a per-athlete value can replace the constant
later, and add a short comment saying so. Do not build the calibration now, and
do not compute a rolling median in this change.

### Tests

Extend `tests/strava-match.test.js`. All existing tests must still pass
unchanged — this is additive and must not alter any current behaviour.

Add coverage for:

- prescribed tempo, run at 2.4 RE/km → `low` confidence, correct reason
- prescribed tempo, run at 5.4 RE/km → `high` confidence, auto-completes
- prescribed easy, run at 5.4 RE/km → `high` confidence, `ran_above_prescription`
  flag present, athlete sees nothing unusual
- `relative_effort` absent → identical result to before this change
- `relative_effort` of `0` is treated as absent, not as easy
- an unparseable session name returns `unknown` and does not downgrade

### Done means

`npm run check` passes, `node --test` passes, no new serverless functions, no new
dependencies, and the diff to files outside `strava-match.js` and its test is
minimal. Show me the diff before committing.

---

## PROMPT 2 — Coach dashboard: roster triage

Copy everything between the rules.

---

You are working on the Dual Performance coaching system. Before writing code,
establish where this belongs. `api/notify.js` and `api/my-logs.js` both refer to
an existing "coaches dashboard" that reads Supabase and calls `/api/notify`.
Find it. Report back whether we are extending that app or building new, and wait
for my answer before proceeding.

Read `supabase/migrations/202606240001_structured_athlete_ingest.sql`,
`api/athletes.js`, `api/ingest.js` and `api/reminders.js` first. The tables that
matter are `athletes`, `daily_body_logs`, `weekly_checkins`,
`training_session_logs`, `session_logs` and `coach_change_log`.

### Goal

A single screen that answers one question in under ten seconds: which athletes
need me today. Not a data browser. Not a Strava clone. A triage queue.

### The core insight this is built around

Individual signals are noise. Pairs of signals are coaching decisions.

A hard training week is fine. Poor sleep is fine. A hard training week *and*
three days of declining sleep is a conversation. Every row in this dashboard
must earn its place by combining at least two sources.

### Priority rows

Rank the roster by severity, highest first. Each row states the athlete, the
combined signal in one sentence, and a single action.

1. **Pain flagged.** Any `daily_body_logs` row with `pain >= 5` in the last 7
   days, or `coach_alert` true. Always top. Action: message the athlete.
2. **Load vs recovery divergence.** Strava relative effort over the trailing 7
   days is more than 30% above the trailing 4-week average, while self-reported
   sleep or energy has declined across the last 3 check-ins. Action: review the
   week's plan.
3. **Gone quiet.** No `session_logs` row and no `daily_body_logs` row for 5+
   days on an athlete marked active. Action: check in.
4. **Compliance drift.** Completed sessions below 60% of planned for the current
   week, when the week is at least half elapsed. Action: review.
5. **Executed vs prescribed mismatch.** Where Strava lap data exists, surface
   sessions where the athlete ran materially faster than prescribed on easy
   days. Chronic over-pacing of easy runs is the single most common thing worth
   catching. Action: review the session.

Athletes with no flags do not appear in the queue. Show a count only:
"14 athletes, nothing flagged."

### Session detail view

Drilling into a flagged session shows the executed work against the prescription:
lap splits, average HR per rep, and the athlete's own RPE and note side by side.
Use `get_activity_performance`-shape data — laps, `avg_hr`, `avg_watts`.

This detail is coach-only. It must not be surfaced in the athlete portal. Athletes
seeing HR drift and pace decay charts produces anxiety, not adherence.

### Strava data budget — read this carefully

The athlete portal fetches 100 activities per athlete on load. Per-activity lap
and stream data is a separate Strava API call each, and the app-wide rate limit
is shared across every athlete. Fetching laps for a 20-athlete roster on every
dashboard load will exhaust the quota.

Therefore:

- Cache activity summaries in Supabase. Add a `strava_activities` table keyed on
  `(athlete_code, activity_id)` holding the summary fields only.
- Fetch lap detail lazily — only when a coach opens a specific session, and
  cache the result permanently. Laps for a past activity never change.
- Handle 429 the way `api/strava.js` already does: degrade to the portal's own
  logged data and label it as such. Never show a blank chart.
- Propose, but do not build without my sign-off, a Strava webhook subscription
  to replace polling. It is the right answer long-term and it costs a serverless
  function slot we do not currently have.

### Auth

Coach access must not reuse the athlete session path in `_lib/auth.js`. The
admin pattern in `api/athletes.js` — `x-admin-key` compared with
`crypto.timingSafeEqual`, fail-closed when `ADMIN_KEY` is unset — is the
reference. A coach must never be able to authenticate as an athlete, and roster
reads must stay server-side with the service key.

### Constraints

- Serverless function budget is exhausted at 12 on Vercel Hobby. If this needs
  new endpoints, either merge into existing handlers behind a `mode=` param, or
  tell me it needs a plan upgrade before you start. Do not silently break the
  deploy.
- Athlete-facing behaviour must not change. This is additive.
- No hard deletes, ever. History is keyed by athlete code and must survive.

### Build order

Ship rows 1 and 3 first — they need no Strava data at all and prove the triage
model. Rows 2 and 5 come after the `strava_activities` cache exists.

Show me the schema and the row-ranking logic before you build any UI.
