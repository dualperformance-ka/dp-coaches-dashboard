# Dual Performance Athlete Portal

A private athlete portal for delivering training, nutrition, progress tracking, and coach feedback through a lightweight Vercel app backed by Supabase.

> **Note:** The Notion integration was removed on 2026-07-20. Supabase is the single source of truth for all portal data — there is no external mirror or sync.

## Setup

### 1. Configure environment variables in Vercel

In your Vercel project, go to Settings > Environment Variables and add:

Use `.env.example` as the complete key checklist. Keep real values in Vercel or
an ignored local `.env` file; never commit them.

- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_KEY`: Supabase service role key, server-side only
- `PORTAL_SESSION_SECRET`: random secret of at least 32 characters used to sign expiring access-code sessions
- `ALLOWED_ORIGINS`: comma-separated production origins, for example `https://your-portal.vercel.app`
- `GHL_API_KEY`: (optional) enables the weekly check-in `checkin_done` GHL tag
- `EMAIL_AUTH_ENABLED`: set to `true` to enable email OTP sign-in for enrolled athletes (see `docs/auth-migration.md`; leave unset for legacy code login only)
- `REMINDERS_CRON_SECRET` or `CRON_SECRET`: required bearer secret for scheduled reminder delivery
- `NOTIFY_SECRET`: required bearer secret for coach-triggered push notifications
- `GHL_API_TOKEN`: GoHighLevel private-integration token with calendar-event and contact read scopes; used to recover booked call times
- `GHL_LOCATION_ID`: GoHighLevel location containing the coaching-call calendar
- `GHL_CALENDAR_ID`: optional calendar override (defaults to the portal widget calendar)
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: push notification credentials

`NOTION_TOKEN` is no longer used and should be deleted from the Vercel project.

Do not commit real tokens, athlete codes, or private database credentials to GitHub.

### Public Client Configuration

The browser bundle includes the Supabase publishable key for email OTP only.
Athlete data and progress-media operations use authenticated same-origin
server routes.

Keep these private and server-side only:

- `SUPABASE_SERVICE_KEY`
- `CLOUDINARY_API_SECRET`

Supabase access must be protected by RLS policies. Cloudinary API credentials
remain server-side; unsigned browser uploads are not used.

### 3. Deploy

Push to GitHub, import the repository in Vercel, add the environment variables, then deploy.

### 4. Share athlete links

Access-code links remain supported, but the code is exchanged server-side for
an expiring, signed session before any athlete data can be read:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

The root route loads the athlete portal:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

Email OTP can be enabled per athlete. Both login methods resolve to the same
permanent athlete code and use the same server-side authorization boundary.

## Structure

```text
api/
  ingest.js      Structured Supabase ingest (single write endpoint)
  write.js       Authenticated athlete data gateway (/api/portal-data)
  my-logs.js     Athlete-facing read of their own structured logs
  athletes.js    Roster management (source of truth for identity)
supabase/
  migrations/    Structured source-of-truth tables
public/
  index.html     Athlete portal app shell and main client logic
  styles.css     Portal styling and responsive layout
  config.js      Public browser config only, no write-capable secrets
vercel.json      Routes / to the portal
```

## Data Safety

Athlete reads and compatibility-state writes pass through `/api/portal-data`.
Structured submissions pass through `/api/ingest`. Both derive the athlete
identity from the authenticated session and ignore client-supplied identity.
If a write fails, the browser keeps the payload in a local retry queue and
replays it when back online.

Apply the migration in `supabase/migrations/202606240001_structured_athlete_ingest.sql` before enabling the structured ingest path in production.

See `docs/backend-data-safety.md` for the full backend flow and deployment notes.

## Premium Command Center

The athlete portal includes:

- Today's training card
- Weekly coach-focus area
- Readiness score
- Athlete body check-in
- Stress, sleep, energy, soreness, motivation, and bodyweight logging
- Post-session RPE
- Pain/injury flag
- Coach alert state
- Local fallback saving when the network is unavailable

### Responsive experience

- Desktop uses a persistent left navigation rail, an athlete command-center hero, weekly output rings, and wide data layouts.
- Tablet keeps the full portal hierarchy while compressing the hero and content grids.
- Mobile prioritizes today&rsquo;s session, compact weekly signals, touch-sized controls, and a five-item bottom navigation.
- Outdoor mode preserves the same information hierarchy with a daylight-friendly palette.

Your BODY check-in database has already been extended with the premium fields: `Session`, `Motivation`, `RPE`, `Pain`, and `Coach Alert`.

## Premium Portal Roadmap

The portal already covers training delivery, completion logging, goals, nutrition, and progress tracking. The next improvements should focus on trust, personalization, and coach operations.

### Release verification

Run `npm run check` before every deploy. It verifies JavaScript syntax, service
worker asset parity, the serverless function limit, security helpers, and that
no direct browser database query has returned.

### Phase 2: Premium Athlete Experience

- Keep improving the today-first dashboard around the athlete's next action, weekly focus, and coach note.
- Add readiness, sleep, soreness, stress, and motivation check-ins.
- Add post-session RPE, pain flags, and athlete notes.
- Show the athlete why each session matters inside the current training phase.

### Phase 3: Coach Operating System

- Build a coach dashboard for roster status, missed sessions, check-ins, and alerts.
- Add coach notes and interventions per athlete.
- Add weekly review workflows for compliance, fatigue, and progress.
- Add monthly athlete reports that prove service value.

### Phase 4: Product Polish

- Continue splitting the single-file app into focused client modules.
- Add typed data mapping for the Supabase row shapes.
- Add empty, loading, and error states for every major view.
- Add basic integration tests for the ingest endpoint.
