# Build prompt — Coach-owned daily macro overrides

Paste this into Claude Code from the repo root (`dp-coaches-dashboard-main`).
Written to be executed as-is. It follows the exact conventions already shipped
in `weekly_sport_targets` (migration, `server/` module, `/api/athletes` actions,
`/api/my-logs` read contract, soft removal, DB-side audit).

---

## Context you must read first

Read these before writing anything. The new feature is a sibling of the weekly
sport targets feature and must mirror its shape:

- `supabase/migrations/20260817052406_coach_owned_weekly_sport_targets.sql`
- `server/weekly-sport-targets.js`
- `server/coach-scope.js`
- `api/my-logs.js`
- `public/weekly-sport-targets.js` and `public/weekly-sport-targets.css`
- `public/js/06-nutrition.js` (athlete portal nutrition tab)
- `docs/weekly-sport-targets.md`
- `tests/weekly-sport-targets.test.js`

### Facts already verified in this repo — do not re-derive or second-guess

- `public.touch_updated_at()` exists (defined in `20260815000004_programming_audit.sql`)
  and is reusable as-is.
- `public.programme_change_log` columns: `programme_id`, `athlete_code`,
  `changed_by`, `entity_type`, `entity_id`, `action`, `scope`, `old_value`,
  `new_value`, `summary`, `changed_at`. **`scope` carries no check constraint** —
  `weekly_sport_targets` already writes `'week'`, so `'day'` is consistent.
- `public.athlete_programme_weeks` has `id`, `programme_id`, `block_id`,
  `week_number`, `start_date` (**nullable**), `week_label`, `coach_notes`,
  `athlete_notes`, timestamps, `unique (programme_id, week_number)`.
- `server/coach-scope.js` exports `normaliseCode`, `resolveCoachIdentity`,
  `authorisedAthleteCodes`, `assertAthleteAllowed`, `assertAdmin`, `EDIT_SCOPES`,
  `loadSession`, `resolveScope`, `logProgrammeChange`.
- `nutrition_plans` macro columns are **text**, not numeric — the portal parses
  ranges like `"35-38"` via `toNutNum()`. Override columns are deliberately
  `integer`: a day-level prescription is a specific number, not a range. Keep the
  weekly text parsing untouched.

---

## The problem

Nutrition is currently prescribed **per week**: one `nutrition_plans` row per
athlete per `week_label`, holding `calories`, `protein`, `carbs`, `fats`,
`fibre`, `notes`. Every day of that week reads the same numbers.

That is correct for a normal training week and wrong for the days that actually
matter. A 30 km long run, a double session day, a race, a full rest day and a
travel day all sit inside one week and all need different fuelling. Coaches
currently have no way to say "Saturday only: 3,400 kcal, 520 g carbs" without
distorting the whole week's prescription.

## What to build

**Coach-owned daily macro overrides.** A coach may attach an override to a
specific calendar date. The override carries **absolute** macro values for that
date — not deltas. Where an override exists and is published, it replaces the
weekly row for that date. Every other day of the week continues to read the
weekly row, untouched.

### Non-negotiable product rules

1. **The coach owns the prescription.** Athletes read overrides. They never
   create, edit, or dismiss one. No athlete-side override UI, no "adjust my
   macros" control, not now and not behind a flag.
2. **Absolute values, never deltas.** The stored value is what the athlete eats
   that day. Nothing recomputes if the weekly baseline later changes. A coach
   editing the week must never silently move a published day.
3. **The weekly row stays the source of truth for unoverridden days.** This is
   additive. Do not migrate weekly macros into per-day rows, do not backfill
   seven rows per week, and do not change how `nutrition_plans` is written.
4. **Draft vs published, same as sport targets.** A draft is invisible to the
   athlete. Only `publish_state = 'published'` with `removed_at is null` is
   returned by the athlete endpoint.
5. **Soft removal only.** Removing an override returns it to draft and stamps
   `removed_at`. Hard delete is rejected by a database trigger. Prescription
   history survives.
6. **Migrations ship as reviewable SQL files.** Never apply to production
   automatically.

---

## 1. Migration

New file: `supabase/migrations/<timestamp>_coach_owned_daily_macro_overrides.sql`
plus the matching `supabase/rollback/<same>_down.sql`.

### Table `public.daily_macro_overrides`

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid pk default gen_random_uuid()` | |
| `athlete_code` | `text not null` | FK `athletes(code)`, on delete restrict |
| `programme_week_id` | `uuid not null` | FK `athlete_programme_weeks(id)`, canonical week identity, same as sport targets |
| `override_date` | `date not null` | the calendar day this replaces |
| `calories` | `integer` | |
| `protein_g` | `integer` | |
| `carbs_g` | `integer` | |
| `fats_g` | `integer` | |
| `fibre_g` | `integer` | |
| `day_label` | `text` | short coach-facing tag: `Long run`, `Race day`, `Rest`, `Travel`. Nullable, max 60 chars |
| `coach_note` | `text` | shown to the athlete, max 2000 chars |
| `publish_state` | `text not null default 'draft'` | check in `('draft','published')` |
| `published_at` | `timestamptz` | |
| `removed_at` | `timestamptz` | soft removal marker |
| `updated_by` | `uuid not null` | FK `coaches(id)` |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

Constraints:

- `unique (athlete_code, override_date)` — one override per athlete per day.
  Named `daily_macro_overrides_identity_key`.
- Every macro column: `null or >= 0`.
- `calories <= 12000`, and each macro gram column `<= 2000` — sanity ceilings so
  a fat-fingered `35000` cannot reach an athlete.
- Published rows must carry at least `calories` **and** `protein_g`. A published
  day with no calorie target is meaningless.
  `check (publish_state = 'draft' or (calories is not null and protein_g is not null))`
- `check ((publish_state = 'published') = (published_at is not null))`
- `check (removed_at is null or publish_state = 'draft')`

Indexes:

- Partial index on `(athlete_code, override_date)` where published and not
  removed — this is the athlete read path.
- Index on `(programme_week_id)`.

### Triggers (all four, mirroring the sport targets migration)

1. `validate_daily_macro_override_owner()` — before insert/update of
   `athlete_code`, `programme_week_id`, `override_date`. Two checks:
   - the referenced programme week resolves through
     `athlete_programme_weeks -> athlete_programmes` to the same `athlete_code`,
     otherwise raise `23514`;
   - **and** where the week has a `start_date`, `override_date` must fall inside
     `[start_date, start_date + 6 days]`. A day must not be filed under the
     wrong week. Where `start_date` is null, skip only the date check.
2. `audit_daily_macro_override_change()` — after insert/update, writes to
   `programme_change_log` with `entity_type = 'daily_macro_override'`,
   `scope = 'day'`, action resolved as `created` / `published` / `unpublished` /
   `removed` / `updated` exactly as the sport target trigger does. Actor is
   resolved from `updated_by` against `coaches.handle`, never from the request
   body. Summary: `'Daily macros ' || to_char(new.override_date,'Dy DD Mon') || ' ' || audit_action`.
3. `reject_daily_macro_override_delete()` — before delete, always raises.
4. `trg_touch_daily_macro_overrides` — reuses the existing `touch_updated_at()`.

### Permissions

```sql
alter table public.daily_macro_overrides enable row level security;
revoke all on table public.daily_macro_overrides from public, anon, authenticated;
revoke all on table public.daily_macro_overrides from service_role;
grant select, insert, update on table public.daily_macro_overrides to service_role;
```

No `delete` for `service_role`. Browser roles get nothing.

### No legacy adoption block

Unlike the sport targets migration, there is nothing to adopt. Weekly macros
stay in `nutrition_plans` and remain the fallback. The migration creates schema
only.

---

## 2. Server module

New file: `server/daily-macro-overrides.js`. Same import surface and helper
style as `server/weekly-sport-targets.js` — reuse `assertAthleteAllowed`,
`logProgrammeChange`, `normaliseCode` from `./coach-scope.js`. Do not invent a
second validation dialect.

Exports:

```js
export function coachOverrideResponse(row)      // camelCase contract shape
export async function listDailyMacroOverrides(athleteCodeInput, sb, coach)
export async function saveDailyMacroOverride(body, sb, coach, now = new Date())
export async function saveDailyMacroOverrideRange(body, sb, coach, now = new Date())
export async function removeDailyMacroOverride(body, sb, coach, now = new Date())
```

Rules:

- `optionalWholeNumber` — reuse the same helper semantics (null / integer >= 0,
  400 otherwise), extended with an upper bound per field matching the DB check
  so the API rejects before Postgres does, with a readable message.
- `cleanDate(value)` — must match `^\d{4}-\d{2}-\d{2}$` and parse to a real date,
  else `400 'A date such as 2026-08-22 is required'`.
- `cleanDayLabel(value)` — trimmed, 60 char cap, null when empty.
- `cleanNote(value)` — trimmed, 2000 char cap, null when empty.
- `programmeWeekForAthlete(...)` — copy the sport targets version, including the
  deliberate identical 404 for "missing week" and "another athlete's week". A
  crafted UUID must not become an enumeration oracle.
- Publish path: `published_at` is preserved when the row was already published
  and not removed, otherwise stamped `now`. Same as sport targets.
- Upsert via `?on_conflict=athlete_code,override_date` with
  `prefer: 'resolution=merge-duplicates,return=representation'`, always setting
  `removed_at: null` and `updated_by: coach.id`.
- `saveDailyMacroOverrideRange` — accepts `dates: string[]` (max 14) plus one
  macro payload, and applies the identical values to each date. This is the
  "same numbers for Sat and Sun of a double weekend" case. It validates every
  date up front and fails the whole call if any is invalid; it must not
  half-apply.

`removeDailyMacroOverride` PATCHes to
`{ publish_state: 'draft', published_at: null, removed_at: now, updated_by: coach.id }`.

### Coach API wiring — `api/athletes.js`

Same auth as every other action: dashboard key + enabled `coaches` row +
coach-to-athlete scope.

- `GET /api/athletes?action=daily_macro_overrides&code=JORDAN`
  Returns `{ ok, athleteCode, programme, programmeWeeks, overrides }`.
  `programmeWeeks` reuses the sport targets shape (`id`, `programmeId`,
  `weekNumber`, `weekLabel`, `startDate`) so the coach UI can lay out real dates.
- `POST { action: 'daily_macro_override_save', ... }`
- `POST { action: 'daily_macro_override_range_save', ... }`
- `POST { action: 'daily_macro_override_remove', athlete_code, override_date }`

Save payload: `athlete_code`, `programme_week_id`, `override_date`, `calories`,
`protein_g`, `carbs_g`, `fats_g`, `fibre_g`, `day_label`, `coach_note`,
`publish_state`. `updated_by`, all timestamps and `published_at` are
server/database owned and must be ignored if a client sends them.

---

## 3. Athlete read contract

Extend `api/my-logs.js`, matching `weekly-sport-targets` exactly in structure.

`GET /api/my-logs?resource=daily-macro-overrides`

Requires an athlete bearer session. Any client-supplied athlete code is ignored;
the code is derived server-side through
`auth.users.id -> athletes.auth_user_id -> athletes.code` or the signed legacy
portal session.

Add alongside the existing helpers:

```js
export function publishedMacroOverrideContract(row) {
  return {
    date: row.override_date,
    weekIdentifier: row.programme_week_id,
    calories: row.calories,
    proteinG: row.protein_g,
    carbsG: row.carbs_g,
    fatsG: row.fats_g,
    fibreG: row.fibre_g,
    dayLabel: row.day_label,
    coachNote: row.coach_note,
    source: 'coach',
    locked: true,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}
export async function loadPublishedMacroOverrides(athleteCode, request = select)
```

Response:

```json
{
  "ok": true,
  "overrides": [
    {
      "date": "2026-08-22",
      "weekIdentifier": "canonical-programme-week-uuid",
      "calories": 3400,
      "proteinG": 175,
      "carbsG": 520,
      "fatsG": 85,
      "fibreG": 30,
      "dayLabel": "Long run",
      "coachNote": "Front-load carbs before the 30k. Gel every 30 min on the run.",
      "source": "coach",
      "locked": true,
      "publishedAt": "2026-08-18T01:00:00Z",
      "updatedAt": "2026-08-18T01:00:00Z"
    }
  ]
}
```

Filter to `publish_state = 'published'` and `removed_at is null`, ordered
`override_date.asc`. Constrain the query to a sane window
(`override_date >= today - 60 days`) so the payload cannot grow unbounded.

---

## 4. Coach UI — dashboard

The coach already edits nutrition per week in the Nutrition table, with the
three sport target columns per row. Add daily overrides **inside that same week
row**, not as a separate screen. A coach should never have to go looking.

### Week row: the day strip

Under each week's macro cells, render a seven-cell day strip — Mon to Sun of
that programme week, real dates from `athlete_programme_weeks.start_date`.

Each cell has three states:

- **Inherits** (default) — dim, shows the weekday letter and date only, with a
  faint `+` on hover. Tapping opens the editor pre-filled with the weekly values
  so the coach edits from the baseline rather than from an empty form.
- **Draft** — amber left border, shows calories, labelled `DRAFT`. Not visible
  to the athlete.
- **Published** — green left border, shows calories and the `day_label` if set,
  labelled with a lock. This is the athlete's prescription for that day.

Reuse the visual grammar already established in `weekly-sport-targets.css`:
`--brand` for focus, `#4ade80` for published/locked, `#fbbf24` for draft, mono
micro-labels at 7–8 px uppercase, 8 px radius, `var(--surface2)` cell fill.

### The editor

One overlay dialog, same shell as `.wst-overlay` / `.wst-dialog`. Opening it
from any cell shows the whole week as seven rows so the coach can set Saturday
and Sunday in one sitting, with the tapped day focused (`.wst-row.focused`
treatment — brand background, 3 px inset brand rule).

Each row: the date and weekday, a `Day label` free-text field, five macro
inputs (kcal, P, C, F, fibre), a coach note field, a draft/published select, and
Save / Remove. Above the rows, a locked reference line showing the week's
baseline macros, so the coach is always editing against a visible reference.

Two affordances that save Alex real time:

- **Prefill from week** — a per-row button that drops the weekly baseline values
  into the row's inputs, ready to be nudged.
- **Copy to…** — a small multi-select of the other six days that posts through
  `daily_macro_override_range_save`. This is how a coach sets an identical
  back-to-back weekend in one action.

Guardrails in the UI:

- Show a live delta next to each input versus the weekly baseline
  (`+520 kcal`, `−40 g C`) so a mistyped figure is obvious before publishing.
- Publishing with calories more than 60% above or below the weekly baseline
  requires a second confirm. It is allowed — race day genuinely is an outlier —
  but never accidental.

### The weekly macro cell

When a week has any published override, the weekly macro cell shows a small
`3 days adjusted` marker. A coach scanning the roster must be able to see that a
week is not uniform without opening it.

---

## 5. Athlete UI — portal

Edit `public/js/06-nutrition.js`. The nutrition tab currently renders one macro
row from the weekly `nutrition_plans` row.

### Resolution rule — implement in exactly one place

```
effectiveTargetsFor(date):
  published override for that date  →  use it, source 'coach_day'
  else weekly nutrition_plans row   →  use it, source 'coach_week'
  else                              →  nothing
```

Write this as a single exported helper. Do not resolve macros in two places —
the km target code already shows how quickly two resolvers drift into showing
one week two different numbers.

### What the athlete sees

1. **Today's card, at the top of Nutrition.** The effective targets for today.
   When today is overridden, the card carries a `Today · Long run` chip in
   brand blue, the coach note beneath the numbers, and each changed macro shows
   the weekly figure struck through beside the new one. The athlete must be able
   to tell instantly that today is deliberately different and why.
2. **A seven-day strip under the macro row.** One cell per day of the displayed
   week showing calories. Overridden days carry the brand accent and their day
   label. Tapping a day swaps the macro row to that day's numbers, so an athlete
   can see Saturday's fuelling on Thursday and shop for it.
3. **Nothing else changes** when a week has no overrides. The tab must look and
   behave exactly as it does today. This is the regression that matters most.

Overrides are locked, exactly like published sport targets: read-only, no
dismiss, no local edit, no `localStorage` shadow copy.

Fetch through the existing `_trainingReadSnapshot` warm-cache pattern where the
snapshot is fresh, otherwise a direct call. Do not add a second uncached network
round-trip to the nutrition tab load.

---

## 6. Tests

New `tests/daily-macro-overrides.test.js`, modelled on
`tests/weekly-sport-targets.test.js`. Cover:

**Server module**

- Save creates a draft with no `published_at`.
- Save with `publish_state: 'published'` and no calories → 400.
- Save with `publish_state: 'published'`, calories, no protein → 400.
- Publishing an already-published, unremoved row preserves the original
  `published_at`.
- Republishing a previously removed row stamps a fresh `published_at` and clears
  `removed_at`.
- Negative, non-integer, and above-ceiling macro values → 400.
- Malformed date, and a date outside the referenced week's `start_date + 6` →
  rejected.
- A programme week belonging to another athlete → 404, with a message identical
  to a genuinely missing week.
- Remove returns the row to draft, stamps `removed_at`, nulls `published_at`.
- Range save with 3 valid dates writes 3 rows; with 1 invalid date among 3
  writes 0 rows.

**Athlete contract**

- `resource=daily-macro-overrides` returns published, unremoved rows only.
- Drafts and removed rows never appear.
- A client-supplied athlete code in the query string is ignored.
- Every returned row carries `locked: true` and `source: 'coach'`.

**Resolution**

- Override wins for its date.
- Every other day of that week returns the weekly row.
- A week with no overrides returns identical output to the current behaviour —
  assert this against a fixture of the existing shape.
- A removed override falls back to the weekly row.

**Schema** — add `supabase/tests/daily-macro-overrides.verify.sql` following
`weekly-sport-targets.verify.sql`: assert the table, every constraint, all four
triggers, the RLS state, and that `service_role` holds no `DELETE`.

---

## 7. Docs

New `docs/daily-macro-overrides.md`, structured like
`docs/weekly-sport-targets.md`: source of truth, coach API, coach workflow,
athlete read contract with a sample payload, permission model, resolution rule,
and portal follow-up.

---

## 8. Delivery order

Ship in this sequence; each step is independently reviewable.

1. Migration + rollback + `supabase/tests` verify script. Do not apply.
2. `server/daily-macro-overrides.js` + `api/athletes.js` actions + unit tests.
3. `api/my-logs.js` read contract + contract tests.
4. Coach UI: day strip, editor, prefill, copy-to, the adjusted-week marker.
5. Portal UI: resolution helper, today's card, seven-day strip.
6. `docs/daily-macro-overrides.md`.

Report at the end: files added, files changed, the migration filename awaiting
manual review, and the exact test command to run.

## Out of scope for this release

State these as explicitly not built rather than silently omitting them:

- Athlete-created or athlete-adjusted overrides.
- Delta-based overrides.
- Named reusable day-type presets across the roster. (The `day_label` column is
  the hook for this later — it is free text now, and would become a FK to a
  `macro_day_types` table in a follow-up.)
- Auto-suggesting an override from the planned session type. (The obvious next
  step: mirror the `From plan · publish` pattern already used for running
  targets, so a 30 km Saturday proposes a carb bump the coach publishes with one
  tap.)
- Any change to how `nutrition_plans` weekly rows are written.
