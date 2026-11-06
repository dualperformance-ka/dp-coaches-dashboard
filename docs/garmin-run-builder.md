# Structured run builder (Garmin-compatible)

Coaches build running workouts step by step in the prescription drawer
(Plan Session → **Edit prescription →**). The athlete reviews the published run
in the portal and taps **Send to Garmin**; Garmin Connect then syncs it to the
watch. This dashboard never sends anything to Garmin.

```
coach builds + publishes  →  athlete reviews in portal  →  athlete taps Send to Garmin
        (this repo)                 (dp-athlete-portal)          →  Garmin Connect  →  watch sync
```

## Where coaches build it

**Plan Session window (Nov 2026).** Choose Running, and the step builder sits
in the window under "Workout steps · Garmin". With no steps, the window works
as before: a text-only run that the portal cannot send to Garmin. Once a step
is added, Warm up, Intervals, Working pace, Rest, Cool down and Target pace are
hidden and **written from the steps** (`DPRunWorkout.cardText`), shown as
"Athlete card will read". Save Session stores the session and its steps in one
transaction (`plan_save_run` → `save_run_session()`, migration
20261106000001). Total distance follows the steps when every step is a
distance, until the coach types their own total. A run that already has text
keeps it until steps are added; saving then asks before replacing it. A save
that changes only session fields (date, title, status) leaves the steps
untouched, so an athlete's Garmin receipt does not read as changed.

**Run templates draft the steps.** Picking a run template fills the title
and details as before and also drafts the steps from the template's own
wording (`DPRunWorkout.fromTemplate`): "8x800m strong with 2min jog recovery"
with warm-up "15min easy" and cool-down "10min easy" becomes 15 min warm-up,
8 × (800 m + 2 min jog), 10 min cool-down. Nothing is typed twice. A banner
lists anything to check: a range ("10-15min") takes its low end, strides with
no stated recovery get a lap-button walk-back, and the template's pace word
("10K pace", "Threshold") becomes an effort target because it is not a
number. Templates with no fixed shape (Pyramid, the open long runs) draft no
steps and say so. Picking a template over existing steps asks first. Template
types that are not Plan Session types map to the nearest one the portal sends
(Track, Hills, Fartlek, Race Pace → Speed; Threshold → Tempo; Easy Run → Easy
Effort; Progression → Run), so Type is no longer left on "—".

The prescription drawer (Edit prescription →) still works for the same steps
and holds the publish toggle.

## What a step can be

| Field | Options | Stored as (`run_steps`) |
| --- | --- | --- |
| Type | Warm-up, Run, Interval, Recovery, Rest, Cool-down, Repeat block | `step_type` |
| Ends by | Distance (km, whole metres), Time (mm:ss, `90s`, `10 min`), Lap button | `distance_km` **or** `duration_sec`; neither = lap press |
| Target | None, Pace range (min/km), HR zone 1–5, RPE 1–10, Effort | `intensity_type` + one of `pace_min`/`pace_max`, `hr_zone`, `rpe`, `effort` |
| Instructions | Free text, athlete sees it, shown on the watch | `instructions` |
| Coach note | Private | `coach_notes` (never selected by the portal or sent to Garmin) |
| Repeat | 1–100 rounds, at least one step inside, one nested repeat allowed | `repeat_count`, children via `parent_step_id` |

Pace is stored fast-first (`pace_min` 4:30, `pace_max` 4:45). A single pace is
allowed but the builder warns that it gives the watch a zero-width band. RPE and
effort reach the watch as text with an open target, not as an alert. The whole
workout is limited to 100 Garmin steps once repeats are expanded.

Steps can be added, edited, duplicated (a repeat block is copied with
everything inside it), moved up or down within their block, and removed.

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

`tests/run-workout-contract.test.js` checks the builder against a verbatim
copy of the portal converter in `tests/fixtures/portal-garmin-workouts.js`:
the acceptance fixture must convert to exactly
`tests/fixtures/garmin-acceptance-fixture.json`, the session-type lists must
be equal, and 10,000 random workouts must agree (nothing the portal refuses is
ever called Garmin-ready). When the portal converter changes, copy it into the
fixture again and run `npm test`.

November 2026: the portal's list was accidentally reverted to `run`/`running`
only by portal PR #125. Until the portal restore ships, the portal refuses
Easy Effort, Long Run, Tempo and the other run types this builder accepts.

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
- The date check follows the portal: Send to Garmin uses the athlete's own move
  (`athlete_data.reschedules`, keyed by `notion_page_id` or `id`) when there is
  one. The builder shows that move, and only warns when the date on Garmin no
  longer matches the date the portal would send now.
- Sessions already marked Completed are refused, including old ones with no
  `locked_at`, the same as every other programming write.
- Duplicating a session copies its run steps through the same
  `replace_run_steps()` call: every level of a nested repeat is remapped, and a
  failed copy removes the new session rather than leaving an empty duplicate.

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
psql … -f supabase/migrations/20261106000001_save_run_session.sql
psql … -f supabase/tests/save-run-session.verify.sql
PSQL="psql -d <scratch db>" node scripts/verify-run-roundtrip.mjs   # real save →
                                           # real DB → portal query + converter
node scripts/serve-preview.mjs & node scripts/verify-run-builder.mjs
node scripts/verify-plan-session-run.mjs   # Plan Session window, 1280 and 390 wide
```

A real Garmin Connect and watch test needs a test athlete with Garmin
connected and `GARMIN_WORKOUTS_ENABLED=true` on the portal. Do not use a real
athlete's account for development.
