# Backend Data Safety

The athlete portal uses a Supabase-only save path. The Notion sync (mirror
endpoint + retry outbox) was removed on 2026-07-20 — Supabase is now the single
source of truth for every piece of portal data.

1. Browser saves immediately to local storage.
2. Authenticated compatibility state syncs through `/api/portal-data`; the browser never queries Supabase tables directly.
3. Browser sends every coach-facing structured write to authenticated `/api/ingest`.
4. Both routes derive `athlete_code` from the verified session and ignore any client-supplied athlete identity.
5. On a weekly check-in, `/api/ingest` also adds the `checkin_done` GHL tag (best-effort, never blocks the write).
6. If the Supabase write itself fails, the browser keeps the payload in its own local retry queue and replays it to `/api/ingest` when back online.

There is no external mirror and no `coach_write_outbox` queue in the write path.

## Required Environment Variables

```text
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
PORTAL_SESSION_SECRET=
ALLOWED_ORIGINS=
REMINDERS_CRON_SECRET=
NOTIFY_SECRET=
GHL_API_KEY=        # optional — enables the weekly check-in GHL tag
```

`SUPABASE_SERVICE_KEY`, `PORTAL_SESSION_SECRET`, cron secrets, notification
secrets, Cloudinary secrets, and VAPID private keys must only exist server-side.
`NOTION_TOKEN` is no longer used.

## Database Setup

Apply:

```text
supabase/migrations/202606240001_structured_athlete_ingest.sql
```

The structured-ingest migration creates:

- `athlete_data`
- `session_logs`
- `athlete_goals`
- `weekly_checkins`
- `daily_body_logs`
- `daily_nutrition_logs`
- `training_session_logs`

RLS is enabled on every table. Portal v80 removes all direct browser database
access. After v80 and the coach dashboard's equivalent server gateway are live,
apply `20260727085203_lock_down_portal_rls.sql` to remove the remaining legacy
anonymous policies and grants, revoke browser access to administrative
`SECURITY DEFINER` RPCs, and make `notify_status` security-invoker. Do not apply
that lockdown before both clients are released.

The legacy `coach_write_outbox` table is no longer written to and can be dropped once any remaining rows have been reviewed.

## Coach Dashboard Rule

Coach dashboards read entirely from Supabase:

- weekly reviews from `weekly_checkins`
- daily body trends from `daily_body_logs`
- daily nutrition from `daily_nutrition_logs`
- training compliance and history from `training_session_logs`
- profile targets from `athlete_goals`
