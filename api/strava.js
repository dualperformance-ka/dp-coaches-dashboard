/**
 * GET /api/strava
 *
 * Returns recent Strava activities for the authenticated athlete.
 * Tokens are stored in Supabase athlete_data table.
 *
 * Response shapes:
 *   { connected: false, connectUrl: "https://strava.com/oauth/..." }
 *   { connected: true,  activities: [...], activitiesAvailable: true }
 *   { connected: true,  activities: [], activitiesAvailable: false, warning: "strava_rate_limited" }
 *
 * Required env vars:
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key
 *   STRAVA_CLIENT_ID     — Strava app client ID
 *   STRAVA_CLIENT_SECRET — Strava app client secret
 *   PORTAL_URL           — full URL of this deployment, e.g. https://dp-athlete-portal.vercel.app
 */
import { getRequestAthlete } from './_lib/auth.js';
import { createPortalSession, verifyPortalSession } from './_lib/legacy-session.js';
import { allowPortalRequest } from './_lib/http.js';

const STRAVA_API  = 'https://www.strava.com/api/v3';
const STRAVA_AUTH = 'https://www.strava.com/oauth/token';

function portalUrl() {
  return process.env.PORTAL_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
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

async function fetchActivities(accessToken, perPage = 100) {
  const res = await fetch(
    `${STRAVA_API}/athlete/activities?per_page=${perPage}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const error = new Error(`Strava activities fetch failed: ${res.status}`);
    error.status = res.status;
    error.retryAfter = res.headers.get('retry-after');
    throw error;
  }
  return res.json();
}

export function unavailableActivitiesResponse(error) {
  if (!error || Number(error.status) !== 429) return null;
  return {
    connected: true,
    activities: [],
    activitiesAvailable: false,
    warning: 'strava_rate_limited',
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.query && req.query.mode === 'callback') return handleCallback(req, res);
  if (!allowPortalRequest(req, res, 'GET, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const identity = await getRequestAthlete(req);
  if (!identity) return res.status(401).json({ error: 'invalid_session' });
  const athleteCode = String(identity.athlete.code).toUpperCase();

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
        `&state=${encodeURIComponent(createPortalSession(athleteCode, { purpose: 'strava', ttlSeconds: 10 * 60 }))}`;

      return res.status(200).json({ connected: false, connectUrl });
    }

    // Refresh token if expired (5-min buffer)
    let { access_token, refresh_token, expires_at } = tokenRow;
    if (Date.now() / 1000 > expires_at - 300) {
      const refreshed = await refreshStravaToken(refresh_token);
      access_token = refreshed.access_token;
      await updateTokens(athleteCode, access_token, refreshed.expires_at);
    }

    try {
      const activities = await fetchActivities(access_token);
      return res.status(200).json({ connected: true, activities, activitiesAvailable: true });
    } catch (activityError) {
      // A rate limit affects activity sync, not the athlete's OAuth connection.
      // Keep the UI truthful and let activity-dependent views use their normal
      // portal-log fallback until Strava is available again.
      const fallback = unavailableActivitiesResponse(activityError);
      if (fallback) {
        console.warn(JSON.stringify({
          level: 'warning',
          message: 'Strava activity sync rate limited',
          route: '/api/strava',
          requestId: req.headers && req.headers['x-vercel-id'],
          retryAfter: activityError.retryAfter || null,
        }));
        return res.status(200).json(fallback);
      }
      throw activityError;
    }
  } catch (err) {
    console.error('[strava]', err);
    return res.status(500).json({ error: err.message });
  }
}


// ── OAUTH CALLBACK (merged from /api/strava-callback) ────────────────────────
// The /api/strava-callback URL registered with Strava still works via a
// vercel.json rewrite to /api/strava?mode=callback. Merged into this file to
// stay under the Vercel Hobby plan's 12-serverless-function deployment cap.


async function supabaseUpsert(athleteCode, tokens) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/athlete_data`;

  // Try update first
  const updateRes = await fetch(
    `${url}?athlete_code=eq.${athleteCode}&key=eq.strava_tokens`,
    {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ value: tokens, updated_at: new Date().toISOString() }),
    }
  );

  // If nothing was updated, insert
  if (updateRes.status === 200 || updateRes.status === 204) {
    // Check if it actually updated a row
    const countRes = await fetch(
      `${url}?athlete_code=eq.${athleteCode}&key=eq.strava_tokens&select=id`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    const rows = await countRes.json();
    if (!rows.length) {
      // Insert
      await fetch(url, {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          athlete_code: athleteCode,
          key: 'strava_tokens',
          value: tokens,
          updated_at: new Date().toISOString(),
        }),
      });
    }
  }
}

function successPage(athleteCode) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Strava Connected — Dual Performance</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#f0ede8;font-family:'Helvetica Neue',sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#161616;border:1px solid rgba(255,255,255,.1);border-radius:16px;
        padding:40px 32px;max-width:420px;width:100%;text-align:center}
  .icon{font-size:48px;margin-bottom:16px}
  h1{font-size:22px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
  p{font-size:14px;color:rgba(255,255,255,.55);line-height:1.6}
  .brand{display:inline-flex;align-items:center;gap:6px;background:#fc4c02;
         color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;
         letter-spacing:.1em;padding:5px 12px;border-radius:20px;margin-top:20px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>Strava Connected</h1>
  <p>Your Strava account has been linked to your coaching profile.<br><br>
     Your coach can now view your activity data. You can close this tab.</p>
  <div class="brand">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066z"/>
      <path d="M11.234 13.828L7.07 6h5.886l4.143 7.828z" opacity=".6"/>
    </svg>
    Powered by Strava
  </div>
</div>
</body>
</html>`;
}

function errorPage(message) {
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Connection Failed — Dual Performance</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#f0ede8;font-family:'Helvetica Neue',sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#161616;border:1px solid rgba(248,113,113,.25);border-radius:16px;
        padding:40px 32px;max-width:420px;width:100%;text-align:center}
  h1{font-size:20px;font-weight:900;text-transform:uppercase;margin-bottom:8px;color:#f87171}
  p{font-size:13px;color:rgba(255,255,255,.5);line-height:1.6;margin-top:8px}
  code{font-family:monospace;font-size:11px;color:#f87171;background:rgba(248,113,113,.08);
       padding:2px 6px;border-radius:4px}
</style>
</head>
<body>
<div class="card">
  <h1>Connection Failed</h1>
  <p>Something went wrong connecting your Strava account.</p>
  <p><code>${safeMessage}</code></p>
  <p>Contact your coach to get a new connect link.</p>
</div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .slice(0, 500);
}

async function handleCallback(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const { code, state, error } = req.query;

  if (error) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(errorPage('Strava access was denied'));
  }

  if (!code || !state) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(errorPage('Missing code or athlete identifier'));
  }

  const verifiedState = verifyPortalSession(decodeURIComponent(state), 'strava');
  if (!verifiedState) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(errorPage('The connection link expired. Start again from the portal.'));
  }
  const athleteCode = verifiedState.code;

  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage('Strava credentials not configured'));
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage('Supabase credentials not configured'));
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(STRAVA_AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Strava token exchange failed: ${err}`);
    }

    const { access_token, refresh_token, expires_at, athlete } = await tokenRes.json();

    // Store in Supabase
    await supabaseUpsert(athleteCode, {
      access_token,
      refresh_token,
      expires_at,
      strava_athlete_id: athlete?.id || null,
      athlete_name: athlete?.firstname
        ? `${athlete.firstname} ${athlete.lastname || ''}`.trim()
        : null,
      connected_at: new Date().toISOString(),
    });

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(successPage(athleteCode));
  } catch (err) {
    console.error('[strava-callback]', err);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage(err.message));
  }
}
