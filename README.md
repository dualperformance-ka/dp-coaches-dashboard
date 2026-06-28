# DP Athlete Portal → Coaches Dashboard Sync

This package fixes the full data path:

1. Athlete portal writes structured submissions into Supabase.
2. `api/coach-data.js` reads the server-only structured tables using the service key.
3. The dashboard merges Supabase over legacy Notion data.
4. Supabase wins on matching athlete/date/session/week records.
5. Notion remains a fallback for historical or unmatched records.
6. The athlete day-by-day section receives a cleaner, wider layout.

## Install

```bash
python3 apply-portal-sync.py /path/to/dp-coaches-dashboard
```

The installer creates:

- `api/coach-data.js`
- `public/dashboard-detail-cleanup.css`
- a patched `public/index.html`
- `public/index.html.before-portal-sync`
- an updated `vercel.json`

## Required Vercel variables

Add these to the **dp-coaches-dashboard** Vercel project:

```text
SUPABASE_URL
SUPABASE_SERVICE_KEY
```

Use the same Supabase project used by `dp-athlete-portal`. The service key must remain server-side.

## Push

```bash
git add api/coach-data.js   public/index.html   public/dashboard-detail-cleanup.css   vercel.json

git commit -m "Connect portal Supabase data and clean athlete ledger"
git push
```

## Verify after deployment

Open:

```text
https://dp-coaches-dashboard.vercel.app/api/coach-data
```

You should receive:

```json
{
  "ok": true,
  "counts": {
    "body": 1,
    "nutrition": 1,
    "sessions": 1,
    "weekly": 1,
    "goals": 1
  }
}
```

Counts will reflect your real database.

Then submit a test entry in the athlete portal and confirm it appears after refreshing the coaches dashboard.
