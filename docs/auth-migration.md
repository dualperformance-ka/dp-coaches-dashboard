# Email OTP Auth Migration — Rollout & Operations Guide

Migration from coach-issued athlete codes to Supabase email OTP sign-in,
**without breaking any existing athlete, any historical data, or any sync flow.**

## Identity model (the one rule that keeps everything safe)

```
auth.users.id  ─→  athletes.auth_user_id  ─→  athletes.code  ─→  everything else
```

`athletes.code` remains the permanent business key for `athlete_data`,
`session_logs`, `daily_body_logs`, `daily_nutrition_logs`, `weekly_checkins`,
`training_session_logs`, `push_subscriptions`, `ghl_map`, and every sync job.
Email auth is only a new way to *prove* who you are; it
resolves (server-side, in `/api/auth-athlete`) to the athlete's existing code,
and the portal then boots through the exact same `doLogin(code)` pipeline as a
code login. Codes are never regenerated, reassigned or invalidated. No new
athlete rows are ever created by the auth flow.

## Feature flags / switches

| Switch | Where | Effect |
|---|---|---|
| `EMAIL_AUTH_ENABLED` env var | Vercel (per environment) | Global gate. Unset/`false` = no OTP is ever sent, regardless of UI. Set `true` in Preview first, Production later. |
| `EMAIL_AUTH_UI` const | `public/config.js` | Shows/hides the "Sign in with email" toggle on the login screen. |
| `athletes.auth_mode` column | Supabase, per athlete | `'code'` (default) = legacy only. `'both'` = email enabled, code still works (use during migration). `'email'` = migrated (code login still physically works until global retirement — this value is bookkeeping + future enforcement). |

Access-code login now creates a server-signed, expiring portal session. Email
OTP and code login therefore share the same authenticated data boundary.

## One-time setup

1. Run migration `202607110001_email_auth_identity.sql`
   (`supabase db push` or SQL editor). It only **adds** columns/policies —
   nothing existing is modified or dropped.
2. Supabase Dashboard → Authentication → Providers → **Email**: enabled,
   "Confirm email" flow not required (OTP handles verification). Set OTP length
   to 6 and expiry (default 1 h; 10–15 min is a reasonable tighter choice).
3. Supabase Dashboard → Authentication → Rate limits: keep the defaults or
   tighter for OTP sends.
4. Strongly recommended before real athletes use it: custom SMTP
   (Auth → SMTP) so codes come from a dualperformance address and don't hit
   spam; customise the OTP email template with the DP branding.
5. Vercel → env vars: add `EMAIL_AUTH_ENABLED=true` (start with Preview only).
   `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` are already set.

## Migrating an athlete (repeat per athlete, at your own pace)

1. Set their email + mode on the roster (SQL editor or a future dashboard UI):
   ```sql
   update public.athletes
   set email = 'athlete@example.com', auth_mode = 'both', invited_at = now()
   where code = 'THOMAS';
   ```
   The unique index on `lower(email)` guarantees an email can only belong to
   one athlete.
2. Tell the athlete to open the portal → "Sign in with email instead" → enter
   that email → enter the 6-digit code from their inbox.
3. First successful sign-in automatically links `auth_user_id` and stamps
   `email_verified_at` (see `resolveAthleteForUser` in `api/_lib/auth.js`).
   Verify:
   ```sql
   select code, email, auth_mode, auth_user_id, email_verified_at
   from public.athletes where code = 'THOMAS';
   ```
4. Once verified in production, optionally set `auth_mode = 'email'` for
   bookkeeping. **Do not** delete their code or stop them using it yet.

If the athlete is locked out (wrong email, lost inbox access): they can still
use their code — nothing about the legacy path is disabled. Fix the email and
retry. To re-link after an email change: clear `auth_user_id`, update `email`,
have them sign in again (and delete the stale auth user in Supabase if unused).

## Testing without touching real athletes

1. Add a test athlete via the dashboard/`/api/athletes` (gets a fresh code).
2. Set its `email`/`auth_mode='both'` to an inbox you control.
3. Run the test plan below against Preview (`EMAIL_AUTH_ENABLED=true` on
   Preview only means Production is untouched the whole time).

## Test plan

| # | Case | Expected |
|---|---|---|
| 1 | Non-migrated athlete, code login | Identical to today: code → portal, data loads, writes land under their code. |
| 2 | Non-migrated athlete taps "Sign in with email", enters their email | "This email isn't set up for sign-in" — pointed back to code. No OTP sent, no auth user created. |
| 3 | Migrated athlete, email OTP sign-in | Code emailed; 6 digits auto-submit; welcome screen; portal identical to their code login. `auth_user_id` populated after first sign-in. |
| 4 | Migrated athlete, browser refresh | No login screen flash; straight into portal (session restored before UI decision). |
| 5 | Migrated athlete, installed PWA closed & reopened days later | Still signed in (persisted session + auto-refresh). |
| 6 | Expired/garbage OTP entered | "Code expired/didn't match" + Resend (30 s cooldown) → new code works. |
| 7 | Session expired / revoked while app open | Friendly return to email panel: "session expired — send a new code", email prefilled. |
| 8 | Logout | Back to login, Supabase session ended, remembered email/method cleared. |
| 9 | Cross-athlete access: signed-in athlete A calls `/api/my-logs?code=B` with their token | Returns **A's** logs (identity from session, query param ignored). Same for `/api/ingest` and `/api/portal-data` payload spoofing — writes land under A's code. |
| 10 | Direct Supabase REST with A's session token querying `athlete_data` for B's code | Empty result (RLS: `athlete_code = current_athlete_code()`). |
| 11 | Mixed rollout | One migrated + one legacy athlete simultaneously; both fully functional. |
| 12 | History continuity | Migrated athlete sees all pre-migration logs/goals/photos/check-ins; new writes appear in the coach dashboard under the same code. |
| 13 | Legacy `?code=` coach link | Exchanges the code for a 24-hour signed portal session, then opens the portal. |
| 14 | Paused/archived athlete via email | Paused screen / no access — same as code path. Archived athletes never resolve. |

## Verifying PWA persistence (test 4/5 details)

The Supabase session lives in localStorage under `dp-portal-auth` with
`persistSession:true` + `autoRefreshToken:true`. On boot, `bootPortal()` awaits
`getSession()` **before** deciding login vs portal. Confirm on iPhone + Android
installed PWAs: sign in → force-close → reopen (portal, no login) → airplane
mode reopen (portal from cache) → after >1 h idle reopen (token refreshes
silently).

## When is it safe to retire legacy code login?

All of the following, sustained for at least a full check-in cycle:

1. Every non-archived athlete has `auth_user_id` set and `email_verified_at`
   stamped (`select code from athletes where archived_at is null and auth_user_id is null;` returns zero rows).
2. Each of them has signed in via email **in production** (auth logs / last
   sign-in in Supabase Auth).
3. No support fallbacks to code login needed for ~2 weeks.
4. Coach dashboard flows that mint `?code=` links have an agreed replacement
   (or are consciously kept as a coach-only backdoor behind `ADMIN_KEY`).

Retirement steps (a **separate, deliberate change** — not part of this rollout):
hide the code panel in `index.html`, reject access-code session creation for
`auth_mode='email'` athletes in `/api/auth-athlete`, drop the `?code=` boot path,
and replace the permissive `anon` RLS policies on `athlete_data`/`session_logs`
with authenticated-only. Keep `athletes.code` forever — it remains the join key
for all history and sync even after nobody logs in with it.

## Residual release step

- The browser no longer needs permissive anonymous RLS. Apply
  `20260727085203_lock_down_portal_rls.sql` only after portal v80 and any coach
  dashboard browser queries have been migrated to server gateways.
- `/api/my-logs`, `/api/ingest`, progress photos, reminders, Strava, and portal
  state all require a valid email JWT or signed access-code session.
- OTP email deliverability: set up custom SMTP + branded template before wide
  rollout.
- Supabase Auth rate limits: coordinate bulk migration waves so a team-wide
  announcement doesn't hit send limits.
- If an athlete changes email address later: update `athletes.email`, clear
  `auth_user_id`, have them sign in again with the new email.
