# Ready-to-push dashboard patch

Replace/add these files in `dp-coaches-dashboard`:

- `api/coach-data.js`
- `public/index.html`
- `public/dashboard-detail-cleanup.css`
- `vercel.json`

Required Vercel environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Push:

```bash
git add api/coach-data.js public/index.html public/dashboard-detail-cleanup.css vercel.json
git commit -m "Connect portal Supabase data to coaches dashboard"
git push
```

After deployment, verify:

`https://dp-coaches-dashboard.vercel.app/api/coach-data`

The response should contain `"ok": true` and real row counts.
