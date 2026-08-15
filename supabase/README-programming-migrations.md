# Programming system migrations — apply guide

Four additive migrations plus rollbacks. Nothing here has been run against
production. Everything below was verified on a local PostgreSQL 16 instance
against a fixture built from the live column definitions.

## What was verified

Applied from scratch, then re-applied twice more — clean every time.
Then rolled back in reverse and the original schema came back byte-for-byte,
with the original `trg_log_planned_sessions` trigger restored and all
pre-existing rows untouched.

Sixteen behavioural checks pass (`supabase/tests/programming-schema.verify.sql`):

| # | Guarantee |
|---|---|
| 1 | All 1,167 existing sessions stay `published` + `legacy` |
| 2 | Creating a draft session does **not** notify the athlete |
| 3 | Editing a draft repeatedly stays silent |
| 4 | Publishing notifies exactly once |
| 5 | `prescription_mode` / `coach_notes` / `day_order` changes are silent |
| 6 | Structured strength edits still reach the athlete |
| 7 | A coach-only note on an exercise is silent |
| 8 | An athlete-facing note notifies |
| 9 | Run steps on a draft session are silent |
| 10 | A completed session rejects every prescription edit |
| 11 | Repeat blocks must carry a count; plain steps must not |
| 12 | Exercise library seeds from your own splits and logs |
| 13 | One active programme per athlete, unlimited drafts |
| 14 | Templates structurally cannot hold athlete data |
| 15 | Prescription rows cascade cleanly, logs never do |
| 16 | No programming table is reachable by a browser role |

## Apply order

```
20260815000001_programming_core.sql
20260815000002_planned_sessions_programme_columns.sql
20260815000003_exercise_library_seed.sql
20260815000004_programming_audit.sql
```

Run them in that order. 0002 depends on tables from 0001; 0004 depends on both.

## Two things worth reading before you apply

**The defaults in 0002 are load-bearing.** `publish_state` defaults to
`'published'` and `prescription_mode` to `'legacy'`. Change either and you
blank or misrender 12 athletes' training on their next portal load.

**0002 replaces one trigger with three.** `trg_log_planned_sessions` becomes
`_ins` / `_upd` / `_del`, each with a `WHEN` clause so draft sessions never
fire an athlete notification. `log_coach_change()` itself is untouched —
`nutrition_plans` and `workout_splits` keep using it exactly as before.

## Rollback

`supabase/rollback/`, run in reverse order (0004 → 0001).

0002's rollback **refuses** while any session is structured, because dropping
`prescription_mode` would make those prescriptions unreachable. Revert those
sessions to legacy first if you really need to go back.

## Nothing is safe to deploy yet

These migrations change no behaviour on their own — that is the point. The
portal reader and the dashboard writer both ship after this, in that order,
so a structured session can never reach a portal that cannot render it.

## Re-running the verification yourself

```bash
createdb dp_migration_test
psql -d dp_migration_test -f supabase/tests/programming-schema.fixture.sql
for f in supabase/migrations/20260815*.sql; do psql -d dp_migration_test -v ON_ERROR_STOP=1 -f "$f"; done
psql -d dp_migration_test -v ON_ERROR_STOP=1 -f supabase/tests/programming-schema.verify.sql
```

The fixture is a minimal stand-in for the live schema, not a copy of your data.
