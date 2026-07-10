// /api/notify.js  (COACHES DASHBOARD)
// Custom coach → athlete-portal push notifications.
//
// The actual web-push send happens on the ATHLETE PORTAL's /api/notify —
// that's where the VAPID private key already lives. This endpoint:
//   GET  (x-admin-key) -> recipients + subscribed device counts (from Supabase)
//   POST (x-admin-key) -> validates, then forwards the send to the portal
//     body: { code: 'ABC123' | 'ALL', title?, message }
//
// Env required (DASHBOARD Vercel project):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (already configured)
//   ADMIN_KEY                           (already configured)
//   ATHLETE_PORTAL_URL                  (already configured; falls back to default)
//   NOTIFY_SECRET                       -> same value as on the portal project.
//     Create it yourself, e.g. run:  openssl rand -hex 32

const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();
const PORTAL_URL = String(process.env.ATHLETE_PORTAL_URL || 'https://dp-athlete-portal.vercel.app').replace(/\/+$/, '');

function requireAdmin(req) {
  if (!ADMIN_KEY) throw new Error('ADMIN_KEY is not configured');
  const supplied = String(req.headers['x-admin-key'] || '').trim();
  if (!supplied || supplied !== ADMIN_KEY) {
    const error = new Error('Admin key rejected');
    error.status = 401;
    throw error;
  }
}

// ── Minimal Supabase REST helper (same pattern as /api/coach-data) ───────────
async function sb(path) {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { /* ignore */ }
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase ${response.status} on ${path}`);
  return data;
}

// ── GET: recipients with device counts ───────────────────────────────────────
async function handleRecipients(req, res) {
  const [athletes, subs] = await Promise.all([
    sb('athletes?archived_at=is.null&select=code,name&order=name.asc'),
    sb('push_subscriptions?select=athlete_code'),
  ]);
  const counts = {};
  for (const s of subs || []) counts[s.athlete_code] = (counts[s.athlete_code] || 0) + 1;
  const recipients = (athletes || []).map((a) => ({
    code: a.code,
    name: a.name,
    devices: counts[a.code] || 0,
  }));
  return res.status(200).json({ ok: true, recipients, totalDevices: (subs || []).length });
}

// ── POST: forward the send to the portal (which holds the VAPID keys) ────────
async function handleSend(req, res) {
  // Auth to the portal: the shared Supabase service key (identical on both
  // projects already) — no separate NOTIFY_SECRET to keep in sync.
  const secret = String(
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NOTIFY_SECRET || ''
  ).trim();
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_KEY is not configured on the dashboard' });
  }

  const code = String(req.body?.code || '').trim().toUpperCase();
  const title = String(req.body?.title || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!code) return res.status(400).json({ ok: false, error: 'code required (athlete code or ALL)' });
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });

  const response = await fetch(`${PORTAL_URL}/api/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ code, title, message }),
  });

  const data = await response.json().catch(() => ({ ok: false, error: `Portal returned HTTP ${response.status}` }));

  // Don't pass the portal's 401 through as-is — the dashboard UI treats 401
  // as "admin key rejected". A portal 401 means the NOTIFY_SECRET values on
  // the two Vercel projects don't match.
  if (response.status === 401) {
    return res.status(502).json({
      ok: false,
      error: 'Portal rejected the shared secret — the SUPABASE_SERVICE_KEY on the dashboard and portal Vercel projects should be identical (redeploy after any env change)',
    });
  }
  return res.status(response.status).json(data);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET (recipient list) is public — same exposure as GET /api/athletes.
    // POST (actually sending) requires the admin key.
    if (req.method === 'GET') return await handleRecipients(req, res);
    requireAdmin(req);
    if (req.method === 'POST') return await handleSend(req, res);
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ ok: false, error: String(error.message || error).slice(0, 500) });
  }
}
