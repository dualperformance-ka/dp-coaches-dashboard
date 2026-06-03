/**
 * GET /api/strava-callback?code={code}&state={athleteName}
 *
 * Strava redirects here after an athlete approves access.
 * Exchanges the code for tokens, stores them in the Strava Tokens
 * Notion database, then shows a success page the athlete can close.
 *
 * Required env vars (same as strava.js):
 *   NOTION_TOKEN          — existing Notion integration token
 *   STRAVA_TOKENS_DB_ID  — ID of the "Strava Tokens" Notion database
 *   STRAVA_CLIENT_ID     — Strava app client ID
 *   STRAVA_CLIENT_SECRET — Strava app client secret
 */

const NOTION_API  = 'https://api.notion.com/v1';
const NOTION_VER  = '2022-06-28';
const STRAVA_AUTH = 'https://www.strava.com/oauth/token';

async function notionReq(endpoint, method, body) {
  const res = await fetch(`${NOTION_API}/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VER,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function findExistingPage(dbId, athleteName) {
  const data = await notionReq(`databases/${dbId}/query`, 'POST', {
    filter: { property: 'Name', title: { equals: athleteName } },
    page_size: 1,
  });
  return data.results?.[0]?.id || null;
}

async function upsertToken(dbId, athleteName, accessToken, refreshToken, expiresAt, stravaAthleteId) {
  const existingId = await findExistingPage(dbId, athleteName);

  const properties = {
    Name:           { title: [{ text: { content: athleteName } }] },
    'Access Token': { rich_text: [{ text: { content: accessToken } }] },
    'Refresh Token':{ rich_text: [{ text: { content: refreshToken } }] },
    'Expires At':   { number: expiresAt },
    'Strava ID':    { number: stravaAthleteId },
  };

  if (existingId) {
    await notionReq(`pages/${existingId}`, 'PATCH', { properties });
  } else {
    await notionReq('pages', 'POST', {
      parent: { database_id: dbId },
      properties,
    });
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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { code, state, error } = req.query;

  // Athlete denied access
  if (error) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(errorPage('Strava access was denied'));
  }

  if (!code || !state) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(errorPage('Missing code or athlete identifier'));
  }

  const athleteName = decodeURIComponent(state);

  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage('Strava credentials not configured on server'));
  }

  if (!process.env.STRAVA_TOKENS_DB_ID) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage('STRAVA_TOKENS_DB_ID not configured'));
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

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_at, athlete } = tokenData;

    // Store in Notion
    await upsertToken(
      process.env.STRAVA_TOKENS_DB_ID,
      athleteName,
      access_token,
      refresh_token,
      expires_at,
      athlete?.id || 0
    );

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(successPage(athleteName));
  } catch (err) {
    console.error('[strava-callback]', err);
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(errorPage(err.message));
  }
}
