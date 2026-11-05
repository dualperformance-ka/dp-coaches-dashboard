# Structured run builder (Garmin-compatible)

Coaches build running workouts step by step in the prescription drawer
(Plan Session → **Edit prescription →**). The athlete reviews the published run
in the portal and taps **Send to Garmin**; Garmin Connect then syncs it to the
watch. This dashboard never sends anything to Garmin.

```
coach builds + publishes  →  athlete reviews in portal  →  athlete taps Send to Garmin
        (this repo)                 (dp-athlete-portal)          →  Garmin Connect  →  watch sync
```

## What a step can be

| Field | Options | Stored as (`run_steps`) |
| --- | --- | --- |
| Type | Warm-up, Run, Interval, Recovery, Rest, Cool-down, Repeat block | `step_type` |
| Ends by | Distance (km), Time (mm:ss, `90s`, `10 min`), Lap button | `distance_km` **or** `duration_sec`; neither = lap press |
| Target | None, Pace range (min/km), HR zone 1–5, RPE 1–10, Effort | `intensity_type` + one of `pace_min`/`pace_max`, `hr_zone`, `rpe`, `effort` |
| Instructions | Free text, athlete sees it, shown on the watch | `instructions` |
| Coach note | Private | `coach_notes` (never selected by the portal or sent to Garmin) |
| Repeat | 1–100 rounds, at least one step inside, one nested repeat allowed | `repeat_count`, children via `parent_step_id` |

Pace is stored fast-first (`pace_min` 4:30, `pace_max` 4:45). RPE and effort
reach the watch as text with an open target, not as an alert. The whole workout
is limited to 100 Garmin steps once repeats are expanded.

## Rules: one copy, matching the portal

`public/run-workout.js` holds every rule and is loaded by the builder in the
browser **and** imported by `server/programming.js`, so the builder cannot call
a workout valid that the server refuses. It mirrors the portal's converter,
`dp-athlete-portal/api/_lib/garmin-workouts.js`, which is the integration
contract. If the converter changes, change `run-workout.js` and
`tests/run-workout.test.js` with it.

The running session types the portal will send are listed in both files
(`GARMIN_RUN_SESSION_TYPES`). Brick, Run + Strength, Optional, Weekly KM Total
and untyped sessions can still hold steps, but the builder says the portal will
not offer Send to Garmin for them.

## Saving and publishing

- A save sends the whole tree to `runsteps_save`. The server validates it,
  assigns fresh ids and calls `replace_run_steps()` once. That function
  deletes the old rows, inserts the new tree, sets `prescription_mode =
  'structured'` and optionally publishes, **in one transaction**. The portal
  sees the old workout or the new one, never half of it.
- Invalid workouts are refused with a plain-language reason. Nothing is saved
  until every step is valid; unsaved edits prompt before the drawer closes.
- Publishing a structured run (footer or **Save & publish**) re-validates on the
  server. Moving to draft is always allowed.
- Saving a published session is live immediately. If the athlete already sent
  it to Garmin, the builder shows that receipt and says the athlete must send
  it again; Garmin is not updated automatically.

## Text (legacy) runs

A run with only text fields opens on an explicit **Build structured steps**
step. The builder starts empty: nothing is parsed out of the text, and the
text fields are never changed. The text stays visible for reference. For a
published session the save button reads **Review & publish structured version**
and asks for confirmation before the athlete sees the change.

## What it does not do (yet)

- Edits and new dates need the athlete to tap Send to Garmin again.
- Deleting a session or moving it to draft does not remove a workout already in
  Garmin Connect. Deleting also removes DP's delivery receipt (cascade).
- The portal's session card still shows the text fields, not the structured
  steps; athletes see the steps in the portal's Garmin review panel.
- No second Garmin connection, token or AI use: the builder only reads DP's own
  delivery receipt (state and dates) from `garmin_workout_deliveries`.

## Checks

```
npm test                                   # rules, save path, publish gate
node scripts/check-portal.mjs
psql … -f supabase/tests/programming-schema.fixture.sql  # then the programming
                                           # migrations, the 20261105000001
                                           # migration, and:
psql … -f supabase/tests/replace-run-steps.verify.sql
node scripts/serve-preview.mjs & node scripts/verify-run-builder.mjs
```

A real Garmin Connect and watch test needs a test athlete with Garmin
connected and `GARMIN_WORKOUTS_ENABLED=true` on the portal. Do not use a real
athlete's account for development.
