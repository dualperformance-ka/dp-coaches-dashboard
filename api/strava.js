/**
 * GET /api/strava?code={athleteCode}
 *
 * Returns recent Strava activities for an athlete.
 * Tokens are stored in Supabase athlete_data table.
 *
 * Response shapes:
 *   { connected: false, connectUrl: "https://strava.com/oauth/..." }
 *   { connected: true,  activities: [...] }
 *
 * Required env vars:
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key
 *   STRAVA_CLIENT_ID     — Strava app client ID
 *   STRAVA_CLIENT_SECRET — Strava app client secret
 *   PORTAL_URL           — full URL of this deployment, e.g. https://dp-athlete-portal.vercel.app
 */

const STRAVA_API  = 'https://www.strava.com/api/v3';
const STRAVA_AUTH = 'https://www.strava.com/oauth/token';

function portalUrl() {
  return process.env.PORTAL_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
}

function setCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin  = req.headers.origin;
  if (!allowed.length || (origin && allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function supabaseFetch(path) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const res  = await fetch(`${base}/rest/v1/${path}`, {
    headers: {
      apikey:        process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      Accept:        'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function getTokens(athleteCode) {
  const rows = await supabaseFetch(
    `athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens&select=id,value`
  );
  if (!Array.isArray(rows) || !rows.length) return null;
  return { id: rows[0].id, ...rows[0].value };
}

async function updateTokens(athleteCode, accessToken, expiresAt) {
  // Fetch current value first to merge
  const current = await getTokens(athleteCode);
  if (!current) return;

  const updated = { ...current, access_token: accessToken, expires_at: expiresAt };
  delete updated.id;

  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  await fetch(
    `${base}/rest/v1/athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens`,
    {
      method: 'PATCH',
      headers: {
        apikey:        process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ value: updated, updated_at: new Date().toISOString() }),
    }
  );
}

// ── Strava helpers ────────────────────────────────────────────────────────────

async function refreshStravaToken(refreshToken) {
  const res = await fetch(STRAVA_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);
  return res.json();
}

async function fetchActivities(accessToken, perPage = 10) {
  const res = await fetch(
    `${STRAVA_API}/athlete/activities?per_page=${perPage}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Strava activities fetch failed: ${res.status}`);
  return res.json();
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Support both ?code= (new) and ?athlete= (legacy) params
  const athleteCode = ((req.query.code || req.query.athlete) || '').trim().toUpperCase();
  if (!athleteCode) return res.status(400).json({ error: 'code param required' });

  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Strava credentials not configured' });
  }

  try {
    const tokenRow = await getTokens(athleteCode);

    // Not connected — return OAuth URL
    if (!tokenRow || !tokenRow.access_token) {
      const connectUrl =
        `https://www.strava.com/oauth/authorize` +
        `?client_id=${process.env.STRAVA_CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(portalUrl() + '/api/strava-callback')}` +
        `&scope=activity:read_all` +
        `&state=${encodeURIComponent(athleteCode)}`;

      return res.status(200).json({ connected: false, connectUrl });
    }

    // Refresh token if expired (5-min buffer)
    let { access_token, refresh_token, expires_at } = tokenRow;
    if (Date.now() / 1000 > expires_at - 300) {
      const refreshed = await refreshStravaToken(refresh_token);
      access_token = refreshed.access_token;
      await updateTokens(athleteCode, access_token, refreshed.expires_at);
    }

    const activities = await fetchActivities(access_token);
    return res.status(200).json({ connected: true, activities });
  } catch (err) {
    console.error('[strava]', err);
    return res.status(500).json({ error: err.message });
  }
}
