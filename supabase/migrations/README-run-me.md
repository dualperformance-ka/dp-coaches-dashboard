# Migrations to run

## 20260904000002_scope_client_write_id_to_athlete.sql — RUN THIS

Apply it in the same deploy as the `api/ingest.js` change that namespaces
`client_write_id` by athlete code.

Without it, the first athlete re-sync after deploy will not match the existing
unprefixed row and will INSERT a duplicate session log rather than updating it —
the same session counted twice in compliance figures.

Idempotent; running it twice is safe.

---

# Finding: the RLS "gap" was a false alarm (checked 2026-09-04)

An audit of `supabase/migrations/*.sql` concluded that `public.athlete_data` and
`public.session_logs` were left wide open — that `202606240001` created a
`using (true)` policy for `anon, authenticated` and the `20260727085203` lockdown
failed to drop it, because the lockdown drops a policy name that was never
created.

**That is true of the migration files and false of the live database.** Checked
against production:

| table | policy | roles | qual |
| --- | --- | --- | --- |
| athlete_data | athlete syncs own data | {authenticated} | `athlete_code = current_athlete_code()` |
| session_logs | athlete syncs own session logs | {authenticated} | `athlete_code = current_athlete_code()` |

Row-scoped to the signed-in athlete, `authenticated` only, no `anon`, and the
`with_check` expressions additionally require a non-null key. These are correct.
No migration was needed and none was written.

## The real problem this exposed

**The migration history in this repo does not match the live database.** Someone
replaced those policies without leaving a migration file, and
`public.current_athlete_code()` — the function the entire row-level security of
these two tables depends on — is *granted* in `20260727085203` but **defined
nowhere in this repo**.

That means:

- Anyone auditing from the files alone reaches the wrong conclusion, in both
  directions. This one was a false positive; the next could be a false negative.
- A rebuild from migrations would produce a database missing both the function
  and the policies, silently losing the protection.

Worth fixing by dumping the live schema and reconciling it into a migration:

```bash
supabase db dump --schema public --file supabase/migrations/<timestamp>_reconcile_live_schema.sql
```

## Verified 2026-09-04 — no action needed

```
reads_user_metadata   false
reads_raw_user_meta   false
reads_app_metadata    false
reads_uid             true
reads_email           false
reads_athletes_table  true

body: select code from public.athletes where auth_user_id = auth.uid()
```

`security_definer` is true, and the code is resolved from `auth.uid()` — the JWT
subject, which a client cannot forge — via a lookup in `public.athletes`. No
metadata field is read, so there is no `updateUser()` path to claiming another
athlete's code.

Combined with the row-scoped policies above, `athlete_data` and `session_logs`
are correctly protected. The audit finding was a false positive caused entirely
by the migration files being out of date.


---

# Schema drift — partly reconciled 2026-09-04

`supabase/migrations/` does not reproduce this database.

## Reconciled (20260904000003_reconcile_live_rls_objects.sql)

- `public.current_athlete_code()`
- policy `athlete syncs own data` on `public.athlete_data`
- policy `athlete syncs own session logs` on `public.session_logs`

Every statement is guarded, so applying it to production changes nothing — it
only does work on a rebuild. The two policies are verbatim from production. The
function's body, security_definer flag and search_path were read from
production; its return type, language, volatility and trailing `limit 1` are
inferred, and only ever used on a fresh rebuild.

## NOT reconciled — still missing

- `public.athletes` — the roster, and the identity boundary every other table's
  `athlete_code` points at
- `public.applications`

Neither has a `create table` in any migration. A rebuild from migrations
produces a database with no roster at all. These cannot be reconstructed from
the application code without guessing at types, defaults, constraints and
indexes, so nothing was written for them.

To capture them properly, run `scripts/capture-missing-schema.sql` in the SQL
editor, export the single `migration_sql` column, and save it as
`supabase/migrations/<timestamp>_reconcile_roster_tables.sql`.

The better long-term fix is a real dump, which needs the Supabase CLI (not
installed on this machine):

```bash
npm install -g supabase
supabase login
supabase link --project-ref rugdupplsswxmpoudhpv
supabase db dump --schema public --file supabase/migrations/<timestamp>_reconcile_live_schema.sql
```

That captures everything at once, including objects nobody has thought to look
for yet.
