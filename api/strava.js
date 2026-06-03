/**
 * GET /api/strava?athlete={name}
 *
 * Returns recent Strava activities for the given athlete.
 * Tokens are stored in a Notion database (STRAVA_TOKENS_DB_ID).
 *
 * Response shapes:
 *   { connected: false, connectUrl: "https://strava.com/oauth/..." }
 *   { connected: true,  activities: [...] }
 *
 * Required env vars:
 *   NOTION_TOKEN          — existing Notion integration token
 *   STRAVA_TOKENS_DB_ID  — ID of the "Strava Tokens" Notion database
 *   STRAVA_CLIENT_ID     — Strava app client ID (254938)
 *   STRAVA_CLIENT_SECRET — Strava app client secret
 *   PORTAL_URL           — full URL of this Vercel deployment, e.g. https://dp-athlete-portal.vercel.app
 */

const NOTION_API  = 'https://api.notion.com/v1';
const NOTION_VER  = '2022-06-28';
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

// ── Notion helpers ────────────────────────────────────────────────────────────

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

async function findAthleteToken(athleteName) {
  const dbId = process.env.STRAVA_TOKENS_DB_ID;
  if (!dbId) return null;

  const data = await notionReq(`databases/${dbId}/query`, 'POST', {
    filter: {
      property: 'Name',
      title: { equals: athleteName },
    },
    page_size: 1,
  });

  const page = data.results?.[0];
  if (!page) return null;

  const props = page.properties;
  return {
    pageId:       page.id,
    accessToken:  props['Access Token']?.rich_text?.[0]?.plain_text  || null,
    refreshToken: props['Refresh Token']?.rich_text?.[0]?.plain_text || null,
    expiresAt:    props['Expires At']?.number || 0,
  };
}

async function updateTokenInNotion(pageId, accessToken, expiresAt) {
  await notionReq(`pages/${pageId}`, 'PATCH', {
    properties: {
      'Access Token': { rich_text: [{ text: { content: accessToken } }] },
      'Expires At':   { number: expiresAt },
    },
  });
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

async function fetchActivities(accessToken) {
  const res = await fetch(
    `${STRAVA_API}/athlete/activities?per_page=10`,
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

  const athlete = (req.query.athlete || '').trim();
  if (!athlete) return res.status(400).json({ error: 'athlete param required' });

  // Check required env vars
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Strava credentials not configured' });
  }

  try {
    let tokenRow = await findAthleteToken(athlete);

    // Not connected — return OAuth URL for this athlete
    if (!tokenRow || !tokenRow.accessToken) {
      const connectUrl =
        `https://www.strava.com/oauth/authorize` +
        `?client_id=${process.env.STRAVA_CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(portalUrl() + '/api/strava-callback')}` +
        `&scope=activity:read_all` +
        `&state=${encodeURIComponent(athlete)}`;

      return res.status(200).json({ connected: false, connectUrl });
    }

    // Refresh token if expired (with 5-min buffer)
    let { accessToken } = tokenRow;
    if (Date.now() / 1000 > tokenRow.expiresAt - 300) {
      const refreshed = await refreshStravaToken(tokenRow.refreshToken);
      accessToken = refreshed.access_token;
      await updateTokenInNotion(tokenRow.pageId, accessToken, refreshed.expires_at);
    }

    const activities = await fetchActivities(accessToken);

    return res.status(200).json({ connected: true, activities });
  } catch (err) {
    console.error('[strava]', err);
    return res.status(500).json({ error: err.message });
  }
}
