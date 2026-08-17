# Build prompt — Consolidated Programming tab + daily macro overrides

Paste into Claude Code from the repo root (`dp-coaches-dashboard-main`).

**This supersedes `docs/daily-macro-overrides-prompt.md`.** That document put the
daily override editor inside the Nutrition week row. That was wrong: an override
is a day-shaped object and belongs on the day-shaped surface. The schema, server
module, API actions and athlete read contract from that document carry over
unchanged and are restated here in full. Only the coach UI moved.

Four phases. Each is independently reviewable and shippable. Do not start a
phase before the previous one is merged.

---

## Why

Planning and Nutrition are two tabs describing the same athlete's programme on
two different time axes — Planning is one week of day columns, Nutrition is
every week as table rows. The coaches plan **one athlete at a time**, working
through everything about that athlete before moving on. The split forces them to
select the same athlete twice, from two variables that do not know about each
other, and it puts the fuelling decision in a tab that cannot show the session
being fuelled.

Target: one **Programming** tab, one athlete context, a **Week / Block** view
toggle, and daily macro overrides edited directly on the day cell beneath the
session they belong to.

---

## Read first

- `public/index.html` — `switchTab()` (~9115), `renderPlanning()`,
  `renderPlanGrid()` (~3633), `renderNutritionTab()`, `renderNutTable()`,
  `updatePlanningBadge()`, the `#tab-planning-content` panel (~2370) and the
  `#tab-nut-content` panel that follows it
- `public/weekly-sport-targets.js`, `public/weekly-sport-targets.css`
- `server/weekly-sport-targets.js`, `server/coach-scope.js`, `api/my-logs.js`
- `supabase/migrations/20260817052406_coach_owned_weekly_sport_targets.sql`
- `public/js/06-nutrition.js` (athlete portal)
- `docs/consolidated-programming-tab.html` — the agreed layout for both views

### Facts already verified — do not re-derive

**Schema**

- `public.touch_updated_at()` exists (`20260815000004_programming_audit.sql`),
  reusable as-is.
- `public.programme_change_log`: `programme_id`, `athlete_code`, `changed_by`,
  `entity_type`, `entity_id`, `action`, `scope`, `old_value`, `new_value`,
  `summary`, `changed_at`. **`scope` has no check constraint** —
  `weekly_sport_targets` already writes `'week'`, so `'day'` is consistent.
- `public.athlete_programme_weeks`: `id`, `programme_id`, `block_id`,
  `week_number`, `start_date` (**nullable**), `week_label`, `coach_notes`,
  `athlete_notes`, timestamps, `unique (programme_id, week_number)`.
- `server/coach-scope.js` exports `normaliseCode`, `resolveCoachIdentity`,
  `authorisedAthleteCodes`, `assertAthleteAllowed`, `assertAdmin`,
  `EDIT_SCOPES`, `loadSession`, `resolveScope`, `logProgrammeChange`.
- `nutrition_plans` macro columns are **text** and the portal parses ranges like
  `"35-38"` via `toNutNum()`. Override columns are deliberately `integer` — a
  day-level prescription is a specific number, not a range. Leave the weekly
  text parsing alone.

**Dashboard UI**

- Two athlete states: `_planAthlete` (~2980) in `dp_plan_athlete`, `_nutAthlete`
  (~3011) in `dp_nut_athlete`.
- **`_nutAthleteCodes()` is a superset of `_planAthleteCodes()`** — it unions in
  athletes that have `nutrition_plans` rows but no active roster entry. The
  unified list must keep that union or athletes with nutrition-only history
  disappear from the chips.
- `renderPlanning()` and `renderNutritionTab()` share an identical
  resolve-athlete preamble (codes → localStorage → first non-coach code) and
  both render chips through `buildAthChipsHTML(codes, active, handlerName)`.
- `_plannedKmForWeek(athleteCode, weekLabel)` is **already called from inside
  the nutrition render**. The training/nutrition join exists today. This is a UI
  change, not a data-plumbing one.
- `fpPlanWeek(id)` (~9569) sets `_planAthlete`, writes `dp_plan_athlete`, then
  calls `switchTab('planning')`. It is an entry point from the athlete full-page
  view and must keep working.
- Badges: `updatePlanningBadge()` sets `tab-planning-count` to this week's
  session count. `tab-nut-count` is set to the **number of distinct athletes
  with any nutrition plan** — a near-constant, so it is the disposable one.
- `.plan-grid` is `repeat(7,1fr)`, dropping to 2 columns at 980px and 1 at 560px.
- `.nut-table` is `min-width:780px` across 11 columns, already horizontally
  scrolling, with a sticky first column at the narrow breakpoint (~1455).

---

# Phase 1 — Unify the athlete and week context

No visual change. No new features. This phase exists so every later phase has
one source of truth to build on, and it is independently valuable: today a coach
can be on Jordan in Planning and Sam in Nutrition with nothing on screen saying
so.

1. Replace `_planAthlete` and `_nutAthlete` with a single `_progAthlete`.
2. Replace `_planAthleteCodes()` / `_nutAthleteCodes()` with one
   `_progAthleteCodes()` that **keeps the union semantics** of the nutrition
   version — roster actives plus coaches plus any code appearing in
   `_nutPlans`.
3. One localStorage key `dp_prog_athlete`. On first load, migrate: read
   `dp_prog_athlete`, else fall back to `dp_plan_athlete`, else
   `dp_nut_athlete`, then write the new key. Do not delete the old keys in this
   phase — leave them for one release so a rollback does not lose a coach's
   selection.
4. One `setProgAthlete(code)` replacing `setPlanAthlete` / `setNutAthlete`. Keep
   thin aliases for the old names so any inline `onclick` you miss still works,
   and mark them `@deprecated`.
5. `_planWeekOffset` becomes `_progWeekOffset`, and the Nutrition table gains
   awareness of it: the currently displayed week highlights in the table as
   `NOW`-adjacent styling. Do not change what the table renders yet.
6. `fpPlanWeek(id)` writes `_progAthlete` and `dp_prog_athlete`.

**Tests** — `tests/programming-context.test.js`:

- Migration picks `dp_plan_athlete` when `dp_prog_athlete` is absent, and
  `dp_nut_athlete` when both others are absent.
- `_progAthleteCodes()` still includes an athlete present only in `_nutPlans`.
- Setting the athlete from either tab's chips updates one variable.
- `fpPlanWeek()` still lands on the programming surface with that athlete
  selected.

---

# Phase 2 — Merge the tabs

Still no new features. Structure only.

### Markup

Replace the `#tab-planning-content` and `#tab-nut-content` panels with a single
`#tab-programming-content`:

- one `#prog-ath-chips` (delete `plan-ath-chips` and `nut-ath-chips`)
- a `Week | Block` segmented control, `#prog-view-toggle`
- a toolbar whose contents swap by view:
  - **Week**: `← Prev` / week label / `Next →`, `⧉ Copy → Next Wk`,
    `+ Session`, `Library`
  - **Block**: start-date override, programme weeks, `↻ Restart programme`,
    `+ Week`
- a context strip showing athlete, week, and date range in both views
- `#prog-week-body` holding `plan-week-meta`, `plan-grid`, `plan-lib`
- `#prog-block-body` holding `nut-meta`, `nut-table-wrap`,
  `weekly-sport-targets-editor`

The programme-level settings (start-date override, programme length, restart)
currently sit in the Nutrition toolbar by accident of build order. They are
programme settings. They move to the Block toolbar and stay there.

### Behaviour

- `switchTab()`: remove `'planning'` and `'nutrition'` from the tabs array, add
  `'programming'`. Update `idMap` — the panel id is `tab-programming-content`,
  so no mapping entry is needed; remove the stale `nutrition: 'nut'` entry.
  Accept `'planning'` and `'nutrition'` as **aliases** that resolve to
  `'programming'` and preselect the matching view, so existing call sites
  (`fpPlanWeek`, anything in `03-nav-nudges.js`) keep working.
- One `renderProgramming()` orchestrator: resolve athlete once, render chips
  once, then delegate to `renderPlanGrid()` / `renderPlanLibrary()` or
  `renderNutTable()` by view.
- View mode persists in `dp_prog_view`, defaulting to `week`.
- Clicking a week row in Block view sets `_progWeekOffset` to that week and
  switches to Week view. This is the main reason to keep both.

### Badges

One `tab-programming-count`, carrying the **session count** from
`updatePlanningBadge()`. Drop the nutrition badge — it counted distinct athletes
with any plan and barely moved. Add `!` handling: if `_nutPlansLoadError` is
set, the badge shows `!` regardless of session count, so the existing
error signal is not lost.

### CSS

Keep `.plan-grid` and `.nut-table` rules as they are. Add `.prog-*` wrappers
only. Do not touch the nutrition table breakpoints in this phase — Phase 4 is
where its column set changes.

**Tests** — `tests/programming-tab.test.js`:

- `switchTab('planning')` and `switchTab('nutrition')` both land on
  `tab-programming-content`, with the week and block view respectively.
- View mode round-trips through `dp_prog_view`.
- Clicking a block row sets the week offset and flips to Week view.
- The badge shows `!` when `_nutPlansLoadError` is set.
- Both view bodies render for an athlete with data, and neither throws for an
  athlete with none.

---

# Phase 3 — Daily macro overrides

The feature. Schema, server and athlete contract are carried over verbatim from
the superseded document; the coach UI is new.

## 3a. Migration

`supabase/migrations/<timestamp>_coach_owned_daily_macro_overrides.sql` plus
`supabase/rollback/<same>_down.sql`.

### Table `public.daily_macro_overrides`

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid pk default gen_random_uuid()` | |
| `athlete_code` | `text not null` | FK `athletes(code)`, on delete restrict |
| `programme_week_id` | `uuid not null` | FK `athlete_programme_weeks(id)` |
| `override_date` | `date not null` | the calendar day this replaces |
| `calories` | `integer` | |
| `protein_g` | `integer` | |
| `carbs_g` | `integer` | |
| `fats_g` | `integer` | |
| `fibre_g` | `integer` | |
| `day_label` | `text` | `Long run`, `Race day`, `Rest`. Max 60 chars |
| `coach_note` | `text` | athlete-visible, max 2000 chars |
| `publish_state` | `text not null default 'draft'` | `('draft','published')` |
| `published_at` | `timestamptz` | |
| `removed_at` | `timestamptz` | soft removal marker |
| `updated_by` | `uuid not null` | FK `coaches(id)` |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

Constraints:

- `unique (athlete_code, override_date)` named
  `daily_macro_overrides_identity_key`.
- Every macro column `null or >= 0`.
- `calories <= 12000`; each gram column `<= 2000`. Sanity ceilings so a
  fat-fingered `35000` cannot reach an athlete.
- `check (publish_state = 'draft' or (calories is not null and protein_g is not null))`
- `check ((publish_state = 'published') = (published_at is not null))`
- `check (removed_at is null or publish_state = 'draft')`

Indexes: partial on `(athlete_code, override_date)` where published and not
removed (the athlete read path); plain on `(programme_week_id)`.

### Triggers — all four, mirroring the sport targets migration

1. `validate_daily_macro_override_owner()` before insert/update of
   `athlete_code`, `programme_week_id`, `override_date`:
   - the week resolves through `athlete_programme_weeks -> athlete_programmes`
     to the same `athlete_code`, else raise `23514`;
   - **and** where `start_date` is not null, `override_date` falls within
     `[start_date, start_date + 6]`. Skip only the date half when `start_date`
     is null.
2. `audit_daily_macro_override_change()` after insert/update → 
   `programme_change_log`, `entity_type = 'daily_macro_override'`,
   `scope = 'day'`, action resolved `created` / `published` / `unpublished` /
   `removed` / `updated` exactly as the sport target trigger does. Actor from
   `updated_by` against `coaches.handle`, never from the request body. Summary:
   `'Daily macros ' || to_char(new.override_date,'Dy DD Mon') || ' ' || audit_action`.
3. `reject_daily_macro_override_delete()` before delete, always raises.
4. `trg_touch_daily_macro_overrides` reusing `touch_updated_at()`.

### Permissions

```sql
alter table public.daily_macro_overrides enable row level security;
revoke all on table public.daily_macro_overrides from public, anon, authenticated;
revoke all on table public.daily_macro_overrides from service_role;
grant select, insert, update on table public.daily_macro_overrides to service_role;
```

No `delete` for `service_role`. Browser roles get nothing. **No legacy adoption
block** — weekly macros stay in `nutrition_plans` as the fallback; this
migration creates schema only. Ship the file for review; never auto-apply.

## 3b. Server module

`server/daily-macro-overrides.js`, same import surface and helper style as
`server/weekly-sport-targets.js`. Reuse `assertAthleteAllowed`,
`logProgrammeChange`, `normaliseCode`. Do not invent a second validation
dialect.

```js
export function coachOverrideResponse(row)
export async function listDailyMacroOverrides(athleteCodeInput, sb, coach)
export async function saveDailyMacroOverride(body, sb, coach, now = new Date())
export async function saveDailyMacroOverrideRange(body, sb, coach, now = new Date())
export async function removeDailyMacroOverride(body, sb, coach, now = new Date())
```

- `optionalWholeNumber` semantics as in sport targets (null / integer >= 0, else
  400), extended with the per-field ceilings so the API rejects before Postgres
  does, with a readable message.
- `cleanDate` — `^\d{4}-\d{2}-\d{2}$` and a real date, else
  `400 'A date such as 2026-08-22 is required'`.
- `cleanDayLabel` — trimmed, 60 cap, null when empty.
- `cleanNote` — trimmed, 2000 cap, null when empty.
- `programmeWeekForAthlete` — copy the sport targets version **including the
  deliberately identical 404** for a missing week and another athlete's week. A
  crafted UUID must not become an enumeration oracle.
- Publish: preserve `published_at` when already published and not removed,
  else stamp `now`.
- Upsert `?on_conflict=athlete_code,override_date` with
  `prefer: 'resolution=merge-duplicates,return=representation'`, always setting
  `removed_at: null` and `updated_by: coach.id`.
- `saveDailyMacroOverrideRange` — `dates: string[]`, max 14, one macro payload
  applied to each. Validate every date up front; fail the whole call if any is
  invalid. It must not half-apply.
- `removeDailyMacroOverride` PATCHes to
  `{ publish_state: 'draft', published_at: null, removed_at: now, updated_by: coach.id }`.

### API — `api/athletes.js`

Same auth as every other action: dashboard key, enabled `coaches` row, coach-to-
athlete scope.

- `GET /api/athletes?action=daily_macro_overrides&code=JORDAN` →
  `{ ok, athleteCode, programme, programmeWeeks, overrides }`, `programmeWeeks`
  reusing the sport targets shape so the grid can map real dates.
- `POST { action: 'daily_macro_override_save', ... }`
- `POST { action: 'daily_macro_override_range_save', ... }`
- `POST { action: 'daily_macro_override_remove', athlete_code, override_date }`

Save payload: `athlete_code`, `programme_week_id`, `override_date`, `calories`,
`protein_g`, `carbs_g`, `fats_g`, `fibre_g`, `day_label`, `coach_note`,
`publish_state`. `updated_by`, `published_at` and all timestamps are
server/database owned and must be ignored if a client sends them.

## 3c. Coach UI — the day cell

This is the part that moved. Build it in `renderPlanGrid()`.

Each `.plan-day` gains a **fuel footer** pinned to the bottom of the cell, below
the session cards and the `+ Add` button:

- **Inherits** — dim. `2,750` and `inherits week`. The weekly `nutrition_plans`
  value for the week that day belongs to.
- **Draft** — amber top border, calories, day label, delta. Athlete cannot see
  it.
- **Published** — green top border, calories, day label, signed delta against
  the weekly baseline.

Tapping the footer opens the override editor. Reuse the
`weekly-sport-targets.css` grammar: `--brand` focus, `#4ade80` published,
`#fbbf24` draft, 7–8px uppercase mono micro-labels, `var(--surface3)` fills.

Above the grid, a **week bar** showing the week's baseline macros, so the coach
always edits against a visible reference, plus a `3 days adjusted` count.

### The editor

One overlay, same shell as `.wst-overlay` / `.wst-dialog`. Opening from any day
shows all seven days as rows with the tapped day focused (`.wst-row.focused`
treatment), so a back-to-back weekend is set in one sitting.

Each row: date and weekday, `Day label`, five macro inputs, coach note,
draft/published select, Save / Remove. Plus:

- **Prefill from week** — drops the weekly baseline into that row's inputs.
- **Copy to…** — multi-select of the other six days, posting through
  `daily_macro_override_range_save`.
- A **live delta** beside each input versus the weekly baseline, so a mistyped
  figure is obvious before publishing.
- Publishing at more than ±60% of the weekly baseline calories requires a second
  confirm. Allowed — race day genuinely is an outlier — but never accidental.

## 3d. Athlete read contract

Extend `api/my-logs.js` exactly as `weekly-sport-targets` did.

`GET /api/my-logs?resource=daily-macro-overrides`, athlete bearer session
required. Any client-supplied athlete code is ignored; the code is derived
server-side via `auth.users.id -> athletes.auth_user_id -> athletes.code` or the
signed legacy portal session.

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

Published and unremoved only, ordered `override_date.asc`, windowed to
`override_date >= today - 60 days` so the payload cannot grow unbounded.

## 3e. Athlete portal

`public/js/06-nutrition.js`. Resolution rule, in **exactly one place**:

```
effectiveTargetsFor(date):
  published override for that date  →  use it, source 'coach_day'
  else weekly nutrition_plans row   →  use it, source 'coach_week'
  else                              →  nothing
```

Export it as a single helper. Do not resolve macros in two places — the km
target code already shows how fast two resolvers drift into showing one week two
different numbers.

1. **Today's card** at the top of Nutrition: effective targets for today. When
   overridden it carries a `Today · Long run` chip, the coach note, and each
   changed macro shows the weekly figure struck through beside the new one.
2. **Seven-day strip** under the macro row, one cell per day showing calories,
   overridden days accented with their label. Tapping swaps the macro row to
   that day.
3. **Nothing else changes** when a week has no overrides. This is the regression
   that matters most.

Overrides are locked: read-only, no dismiss, no local edit, no `localStorage`
shadow copy. Fetch through the existing `_trainingReadSnapshot` warm-cache
pattern where fresh, else a direct call. Do not add a second uncached round-trip
to the nutrition tab load.

## 3f. Tests — `tests/daily-macro-overrides.test.js`

Modelled on `tests/weekly-sport-targets.test.js`.

**Server** — draft save leaves `published_at` null; published with no calories →
400; published with calories but no protein → 400; republishing an already
published unremoved row preserves the original `published_at`; republishing a
removed row stamps fresh and clears `removed_at`; negative, non-integer and
above-ceiling values → 400; malformed date and a date outside
`start_date + 6` rejected; another athlete's week → 404 with a message identical
to a missing week; remove returns to draft and stamps `removed_at`; range save
with 3 valid dates writes 3, with 1 invalid among 3 writes 0.

**Contract** — published unremoved only; drafts and removed never appear; a
client-supplied code in the query string is ignored; every row carries
`locked: true` and `source: 'coach'`.

**Resolution** — override wins for its date; every other day of that week
returns the weekly row; a week with no overrides returns output identical to
current behaviour, asserted against a fixture of the existing shape; a removed
override falls back to the weekly row.

**Schema** — `supabase/tests/daily-macro-overrides.verify.sql` following
`weekly-sport-targets.verify.sql`: table, every constraint, all four triggers,
RLS state, and that `service_role` holds no `DELETE`.

---

# Phase 4 — Block view columns

Cosmetic, and the only phase that touches the nutrition table's column set.

1. Add a training group between the macro columns and the sport targets:
   **Sessions**, **Load** (week km), **Key session** (the longest or
   highest-priority session title). All three come from data already in
   `_planRowsSB`; `_plannedKmForWeek()` already computes the load.
2. Add a **Days adj.** cell per week — `3 days` or `0`, clicking through to Week
   view for that week.
3. **Move the Run / Bike / Swim sport target cells out of the table** and into
   the Week view's week bar. They are weekly targets and belong next to the week
   they describe. This keeps the table's net width roughly where it is today
   instead of pushing it three columns wider, and puts each number closer to
   where it is used. `WeeklySportTargetsEditor.mount()` moves accordingly; the
   editor itself does not change.
4. Rework the `max-width:760px` cell-remapping rules for the new column set.
   Verify on a phone-width viewport before calling this done.

**Tests** — extend `tests/programming-tab.test.js`: the training columns render
from planned sessions; `Days adj.` counts published overrides only; the sport
target editor still mounts and saves from its new home.

---

# Delivery

Ship phase by phase. After each, report: files added, files changed, any
migration filename awaiting manual review, and the exact test command.

Never apply a migration to production automatically.

## Out of scope — state these explicitly rather than omitting them

- Athlete-created or athlete-adjusted overrides.
- Delta-based overrides.
- Reusable day-type presets across the roster. `day_label` is the hook: free
  text now, a FK to a `macro_day_types` table later.
- Auto-suggesting an override from the planned session type. The obvious next
  step is mirroring the `From plan · publish` pattern already used for running
  targets, so a 30 km Saturday proposes a carb bump the coach publishes with one
  tap.
- Any change to how `nutrition_plans` weekly rows are written.
- Deleting the `dp_plan_athlete` / `dp_nut_athlete` localStorage keys. They stay
  for one release as a rollback path.
