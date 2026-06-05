/**
 * GET /api/strava-callback?code={code}&state={athleteName}
 *
 * Strava redirects here after an athlete approves access.
 * Exchanges the code for tokens, stores them in Supabase (athlete_data table),
 * then shows a success page the athlete can close.
 *
 * Required env vars:
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key (server-side only)
 *   STRAVA_CLIENT_ID     — Strava app client ID
 *   STRAVA_CLIENT_SECRET — Strava app client secret
 */

const STRAVA_AUTH = 'https://www.strava.com/oauth/token';

async function supabaseUpsert(athleteCode, tokens) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const url  = `${base}/rest/v1/athlete_data`;

  const headers = {
    apikey:        process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer:        'return=minimal',
  };

  // Try PATCH first (update existing row)
  const patchRes = await fetch(
    `${url}?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens`,
    { method: 'PATCH', headers, body: JSON.stringify({ value: tokens, updated_at: new Date().toISOString() }) }
  );

  // If no row existed (204 with 0 rows updated), INSERT instead
  if (patchRes.status === 204 || patchRes.status === 200) {
    const checkRes = await fetch(
      `${url}?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens&select=athlete_code`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } }
    );
    const rows = await checkRes.json();
    if (!rows.length) {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          athlete_code: athleteCode,
          key:          'strava_tokens',
          value:        tokens,
          updated_at:   new Date().toISOString(),
        }),
      });
    }
  }
}

function successPage(athleteName) {
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
  .athlete{color:#f59e0b;font-weight:700}
  .brand{display:inline-flex;align-items:center;gap:6px;background:#fc4c02;
         color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;
         letter-spacing:.1em;padding:5px 12px;border-radius:20px;margin-top:20px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>Strava Connected</h1>
  <p>Your Strava account has been linked to<br>
     <span class="athlete">${athleteName}</span>'s coaching profile.<br><br>
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
  <p><code>${message}</code></p>
  <p>Contact your coach to get a new connect link.</p>
</div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
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

  // state = athleteName passed through from the connect link
  const athleteName = decodeURIComponent(state);

  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage('Strava credentials not configured on server'));
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
        grant_type:    'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Strava token exchange failed: ${err}`);
    }

    const { access_token, refresh_token, expires_at, athlete } = await tokenRes.json();

    // Store in Supabase — keyed by athleteName (matches how strava.js looks up by athlete param)
    await supabaseUpsert(athleteName, {
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
    return res.status(200).send(successPage(athleteName));
  } catch (err) {
    console.error('[strava-callback]', err);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage(err.message));
  }
};
