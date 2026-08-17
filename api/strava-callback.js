/** Strava OAuth callback. Stores the connection under a canonical athlete code. */
import { upsert } from './_lib/supabase-rest.js';
import { canonicalAthleteCode } from '../server/strava-cache.js';

const STRAVA_AUTH = 'https://www.strava.com/oauth/token';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page({ athleteCode = '', error = '' } = {}) {
  const failed = Boolean(error);
  const title = failed ? 'Connection failed' : 'Strava connected';
  const message = failed
    ? `${escapeHtml(error)} Contact your coach for a new connection link.`
    : `${escapeHtml(athleteCode)} is connected. Your coach can now use your activity data; you can close this tab.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Dual Performance</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0a0a0a;color:#f0ede8;font-family:system-ui,sans-serif}.card{width:min(420px,100%);padding:38px 30px;border:1px solid ${failed ? 'rgba(248,113,113,.3)' : 'rgba(74,222,128,.25)'};border-radius:16px;background:#161616;text-align:center}h1{margin:0 0 12px;font-size:23px;text-transform:uppercase}p{margin:0;color:#aaa;line-height:1.6}.brand{display:inline-block;margin-top:20px;padding:6px 12px;border-radius:20px;background:#fc4c02;color:white;font-size:11px;font-weight:800}</style></head><body><main class="card"><h1>${title}</h1><p>${message}</p>${failed ? '' : '<span class="brand">Powered by Strava</span>'}</main></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const { code, state, error } = req.query || {};
  if (error) return res.status(400).send(page({ error: 'Strava access was denied.' }));
  const athleteCode = canonicalAthleteCode(state);
  if (!code || !/^[A-Z0-9_-]{1,64}$/.test(athleteCode)) {
    return res.status(400).send(page({ error: 'The connection link is missing a valid athlete identifier.' }));
  }
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET ||
      !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).send(page({ error: 'The Strava connection is not configured on the server.' }));
  }
  try {
    const tokenResponse = await fetch(STRAVA_AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok) throw new Error(`Strava token exchange failed (${tokenResponse.status})`);
    const { access_token, refresh_token, expires_at, athlete, scope } = await tokenResponse.json();
    await upsert('athlete_data', {
      athlete_code: athleteCode,
      key: 'strava_tokens',
      value: {
        access_token,
        refresh_token,
        expires_at,
        scope: scope || null,
        strava_athlete_id: athlete?.id || null,
        athlete_name: athlete?.firstname
          ? `${athlete.firstname} ${athlete.lastname || ''}`.trim()
          : null,
        connected_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, 'athlete_code,key');
    return res.status(200).send(page({ athleteCode }));
  } catch (connectionError) {
    console.error('[strava-callback]', connectionError);
    return res.status(500).send(page({ error: 'The token exchange could not be completed.' }));
  }
}
