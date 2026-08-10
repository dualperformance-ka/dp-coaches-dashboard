# Premium Portal Operations

The athlete portal is a coached command center rather than a passive data
viewer. It includes today-first training, weekly output, readiness, body and
nutrition logs, check-ins, progress photos, personal-best history, reminders,
Strava, coach contact, and offline retry.

## Data flow

- Local storage provides immediate drafts and offline continuity.
- `/api/portal-data` handles authenticated state and programme reads.
- `/api/ingest` writes structured goals, check-ins, body, nutrition, and
  training logs to Supabase.
- `/api/progress-photos` performs authenticated Cloudinary upload and deletion.
- The coach dashboard reads the structured Supabase tables.

The browser never receives a service-role or Cloudinary secret and never writes
directly to a database table.

## Athlete access

An access-code URL remains supported:

```text
https://your-portal.vercel.app?code=ATHLETE_CODE
```

The code is exchanged for a signed 24-hour session. Email OTP can be enabled
per athlete; both methods resolve to the same permanent athlete code and
history.

## Recovery signal

The portal highlights low readiness, pain, high stress or soreness, missed
logging, and incomplete weekly check-ins. Structured rows retain the raw
payload so coach-side review logic can evolve without losing athlete context.

## Release gate

Run:

```text
npm run check
```

Then deploy portal v80 before applying
`supabase/migrations/20260727085203_lock_down_portal_rls.sql`.
