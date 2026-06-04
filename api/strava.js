/**
 * GET /api/strava?athlete={athleteCode}  (or ?code={athleteCode})
 *
 * Coaches dashboard endpoint — reads Strava tokens from Supabase,
 * refreshes if expired, returns recent activities + weekly summary stats.
 *
 * Required env vars (add to coaches dashboard Vercel project):
 *   SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_KEY — Supabase service role key
 *   STRAVA_CLIENT_ID     — Strava app client ID
 *   STRAVA_CLIENT_SECRET — Strava app client secret
 */

const STRAVA_API  = 'https://www.strava.com/api/v3';
const STRAVA_AUTH = 'https://www.strava.com/oauth/token';

// ── Supabase ──────────────────────────────────────────────────────────────────

async function supabaseFetch(path) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const url  = `${base}/rest/v1/${path}`;
  const res  = await fetch(url, {
    headers: {
      apikey:        process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      Accept:        'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function getTokens(athleteCode) {
  const rows = await supabaseFetch(
    `athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens&select=value`
  );
  return Array.isArray(rows) && rows.length ? rows[0].value : null;
}

async function updateTokens(athleteCode, accessToken, expiresAt, tokens) {
  const updated = { ...tokens, access_token: accessToken, expires_at: expiresAt };
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

  await fetch(
    `${base}/rest/v1/athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens`,
    {
      method: 'PATCH',
      headers: {
        apikey:        process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer:        'return=minimal',
      },
      body: JSON.stringify({ value: updated, updated_at: new Date().toISOString() }),
    }
  );
}

// ── Strava ────────────────────────────────────────────────────────────────────

async function doRefreshToken(refreshToken) {
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
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  return res.json();
}

async function fetchActivities(accessToken, perPage = 20) {
  const res = await fetch(`${STRAVA_API}/athlete/activities?per_page=${perPage}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Strava activities failed: ${res.status}`);
  return res.json();
}

async function fetchActivityDetail(accessToken, id) {
  const res = await fetch(`${STRAVA_API}/activities/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Weekly stats helper ───────────────────────────────────────────────────────

function weeklyStats(activities) {
  // Use local date string (YYYY-MM-DD) from start_date_local to avoid UTC offset issues
  const now = new Date();
  const day = now.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  const mondayUTC = new Date(now);
  mondayUTC.setUTCDate(now.getUTCDate() - daysFromMonday);
  mondayUTC.setUTCHours(0, 0, 0, 0);
  const mondayStr = mondayUTC.toISOString().slice(0, 10); // "YYYY-MM-DD"

  let weeklyKm = 0, weeklyRuns = 0;
  for (const a of activities) {
    const localDate = (a.start_date_local || a.start_date || '').slice(0, 10);
    if (localDate >= mondayStr &&
        (a.type === 'Run' || a.sport_type === 'Run')) {
      weeklyKm   += (a.distance || 0) / 1000;
      weeklyRuns += 1;
    }
  }

  const lastRun = activities.find(a => a.type === 'Run' || a.sport_type === 'Run');
  const daysSince = lastRun
    ? Math.floor((Date.now() - new Date(lastRun.start_date)) / 86400000)
    : null;

  return {
    weeklyKm:        Math.round(weeklyKm * 10) / 10,
    weeklyRuns,
    daysSinceLastRun: daysSince,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Support both ?code= and legacy ?athlete= params
  const athleteCode = ((req.query.code || req.query.athlete) || '').trim().toUpperCase();
  if (!athleteCode) return res.status(400).json({ error: 'athlete/code param required' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' });
  }
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(500).json({ error: 'STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set' });
  }

  try {
    const tokens = await getTokens(athleteCode);

    if (!tokens || !tokens.access_token) {
      return res.status(200).json({ connected: false });
    }

    // Refresh if within 5 min of expiry
    let { access_token, refresh_token, expires_at } = tokens;
    if (Date.now() / 1000 > expires_at - 300) {
      const refreshed = await doRefreshToken(refresh_token);
      access_token = refreshed.access_token;
      await updateTokens(athleteCode, access_token, refreshed.expires_at, tokens);
    }

    const activities = await fetchActivities(access_token, 20);
    const stats      = weeklyStats(activities);

    // Fetch detail (description + splits) for the 5 most recent runs only
    const runs    = activities.filter(a => a.type === 'Run' || a.sport_type === 'Run');
    const details = await Promise.all(runs.slice(0, 5).map(a => fetchActivityDetail(access_token, a.id)));
    const detailMap = {};
    details.forEach(d => { if (d) detailMap[d.id] = d; });

    const enriched = activities.slice(0, 10).map(a => {
      const d = detailMap[a.id];
      if (!d) return a;
      return {
        ...a,
        description:        d.description        || null,
        splits_metric:      d.splits_metric       || [],
        laps:               d.laps                || [],
        perceived_exertion: d.perceived_exertion  ?? null,
        average_cadence:    d.average_cadence     ?? null,
        max_heartrate:      d.max_heartrate       ?? null,
        calories:           d.calories            ?? null,
        gear:               d.gear                || null,
        workout_type:       d.workout_type        ?? null,
      };
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      connected:  true,
      stats,
      activities: enriched,
    });
  } catch (err) {
    console.error('[strava-coach]', err);
    return res.status(500).json({ error: err.message });
  }
};
