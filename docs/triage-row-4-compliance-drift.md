# Triage row 4 — compliance drift

Design note for review. No code written yet. Rows 1 (pain / coach alert) and 3
(gone quiet) are already shipped in `buildTriageQueue()`; this extends the same
function rather than adding an endpoint.

## Schema

**No migration required.** Row 4 reads two tables `loadTriage()` already fetches:

| Table | Columns needed | Already selected? |
| --- | --- | --- |
| `planned_sessions` | `athlete_code`, `planned_date`, `title`, `session_type`, `status` | Yes — line 719 |
| `training_session_logs` | `athlete_code`, `session_date`, `session_name`, `session_category` | Yes — line 714 |

Two window changes to the existing queries, both widening only:

- `planned_sessions` currently starts at `today`. Compliance needs the whole
  current week, so the lower bound moves to `weekStart` (Monday). Upper bound
  stays `today + 7`, which already covers the week's tail.
- `training_session_logs` currently starts at `painStart - 2` (9 days back).
  Monday of the current week is at most 6 days back, so **this window already
  covers it**. No change.

Net new Supabase cost: zero extra round trips, one slightly wider date filter.

### Index note — portal-owned, not ours to migrate

`planned_sessions` is an athlete-portal table and is not defined in this repo's
migrations. A `(athlete_code, planned_date)` index would help this query, but it
should land in the portal's migration set, not here. Flagging rather than
writing it.

### `status` has no constraint

Nothing in this repo constrains `planned_sessions.status`. The only existing
handling is a loose regex at `api/coach-data.js:513`:

```js
!/^(done|completed?|complete|skipped|missed)$/i.test(String(row.status || '').trim())
```

Note that regex lumps `skipped` and `missed` in with `done` — correct for its
purpose (finding the *next upcoming* session) but wrong for counting
completions. Row 4 must not reuse it.

## The decision I need from you: what counts as "completed"

Two sources disagree, and your spec doesn't say which wins.

**Option A — `planned_sessions.status`.** Cheap and directly comparable to
planned. But status is free text with no CHECK constraint, so a typo or an
unmigrated portal value silently reads as non-completion and manufactures a
false compliance row.

**Option B — count `training_session_logs` rows in the week.** Ground truth for
what the athlete actually did, and it's the same source gone-quiet already
trusts. **Serious gotcha:** strength logs write *one row per exercise* — see
`reconSessionShape` around line 437, which emits a row per exercise name. A
five-exercise strength session becomes five rows. Counting raw rows would
overcount strength weeks wildly and suppress real drift. Any count here must be
`DISTINCT (session_date, session_name)`, not `rows.length`.

**Option C — hybrid (my recommendation).** Trust `status` when it matches
`/^(done|complete|completed)$/i`; otherwise fall back to whether a distinct
`(session_date, session_name)` log exists for that date. A session counts as
completed if *either* says so. Fails toward "completed", so the queue
under-reports drift rather than crying wolf — the right bias for a triage screen
whose credibility depends on every row being real.

## Ranking logic

### Week boundaries

Monday-anchored in `Australia/Adelaide`, consistent with `TRIAGE_TIMEZONE` and
with `api/strava.js:251`, which already uses Monday week starts.

```
weekStart = most recent Monday on or before `today`   (Adelaide)
dayIndex  = dayDistance(weekStart, today) + 1          (Mon = 1 … Sun = 7)
```

### Gate: "week at least half elapsed"

Half of seven is 3.5, so the row is only eligible from **day 4 (Thursday)**
onward. Before Thursday, no compliance row for anyone — a 0/4 Tuesday is not yet
information.

### Trigger

```
planned   = planned sessions with weekStart <= planned_date <= today
completed = of those, completed per Option C above
ratio     = completed / planned

fires when:  dayIndex >= 4  AND  planned > 0  AND  ratio < 0.60
```

`planned === 0` produces no row — that's a programming gap, not athlete drift,
and dividing by zero would flag the whole roster.

Note the ratio denominator is sessions planned **up to today**, not the whole
week. Counting Sunday's session as missed on Thursday would be wrong.

### Priority bands

Your spec's severity order is pain > divergence > quiet > compliance >
mismatch. The shipped code uses `10000+` for pain and `5000` for quiet. Keeping
those two numbers **exactly as they are** so the existing rows and their six
tests don't move:

| Row | Flag | Band | Severity |
| --- | --- | --- | --- |
| 1 | `pain` | `10000` + `1000` if coach_alert + `10 ×` pain | `critical` |
| 2 | `load_divergence` | `7000` | `high` |
| 3 | `gone_quiet` | `5000` (unchanged) | `high` |
| 4 | `compliance_drift` | `3000` + `round((0.60 - ratio) × 1000)` | `medium` |
| 5 | `pace_mismatch` | `1000` | `low` |

The shortfall term orders drift internally — 1/6 sorts above 3/6 — and is capped
by the band width so a compliance row can never outrank a quiet one.

`severity: 'medium'` is a new value. `public/triage.js` renders severity as a
CSS class, so `triage.css` needs a `medium` tone before this ships or the row
renders unstyled. UI work, deferred per your instruction, but noted so it
doesn't get lost.

### Suppression — one row per athlete

`buildTriageQueue()` currently emits at most one row per athlete, with pain
absorbing the gone-quiet sentence rather than duplicating it. Row 4 follows the
same rule and is **suppressed when pain or gone-quiet is already firing**.

This matters more than it looks: an athlete who has gone quiet has 0% compliance
by definition. Emitting both would put the same person in the queue twice and
make the flagged count lie. Compliance drift is only interesting for an athlete
who *is* logging and still isn't completing the work.

### Copy

One sentence, one action, matching the existing `painSignalCopy` register:

> **Ellie N.** — Completed 2 of 6 sessions planned so far this week, with four
> days elapsed. → *Review*

Action shape reuses the existing contract:
`{ type: 'review', label: 'Review', athleteCode }`.

## Honest caveat on the two-source rule

You said every row must earn its place by combining at least two sources. Row 4
combines `planned_sessions` with `training_session_logs`, gated on elapsed time
— so it qualifies. But it's the weakest pair of the five: it measures one thing
(work not done) against its own prescription, rather than putting two
independent signals side by side the way rows 2 and 5 do. It will be the row
most likely to generate a shrug. Worth watching once it's live; if it fires on
athletes you'd not have called, the 0.60 threshold is the dial.

## Tests to add

Extending `tests/triage.test.js`, which already covers the pure function
directly:

1. No compliance row before Thursday, even at 0 of 5.
2. Fires at 2 of 6 on a Thursday; does not fire at 4 of 6.
3. `planned === 0` produces no row.
4. Suppressed when the same athlete already has pain or gone-quiet.
5. A five-exercise strength session counts as **one** completion, not five.
6. Compliance never outranks gone-quiet regardless of shortfall.
