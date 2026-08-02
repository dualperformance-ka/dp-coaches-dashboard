/**
 * GET /api/strava?athlete={athleteCode}&history_start=YYYY-MM-DD
 *   &detail_start=YYYY-MM-DD&detail_end=YYYY-MM-DD
 * Use summary=1 for squad-card aggregates without activity-detail requests.
 * (or use ?code={athleteCode})
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
import { coachError, requireCoach, setCoachCors } from '../server/coach-auth.js';

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

async function fetchActivities(accessToken, { afterEpoch = null, perPage = 200 } = {}) {
  const activities = [];
  let page = 1;

  // When a programme start is supplied, keep paging until Strava has returned
  // every activity in that date range. Without one, retain the legacy one-page
  // behaviour so older callers cannot accidentally request an athlete's entire
  // lifetime history.
  while (true) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (afterEpoch != null) params.set('after', String(afterEpoch));
    const res = await fetch(`${STRAVA_API}/athlete/activities?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Strava activities failed: ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('Strava activities returned an invalid response');
    activities.push(...batch);
    if (afterEpoch == null || batch.length < perPage) break;
    page += 1;
  }

  return activities;
}

async function fetchActivityDetail(accessToken, id) {
  const res = await fetch(`${STRAVA_API}/activities/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// Time-in-HR-zones for one activity. Returns [{min,max,time}] seconds per zone
// (Z1→Z5) or null. Requires the athlete to have HR zones set up in Strava.
async function fetchActivityZones(accessToken, id) {
  const res = await fetch(`${STRAVA_API}/activities/${id}/zones`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const zones = await res.json();
  const hr = Array.isArray(zones) ? zones.find(z => z.type === 'heartrate') : null;
  return hr && Array.isArray(hr.distribution_buckets) ? hr.distribution_buckets : null;
}

export function activityLocalDate(activity) {
  const value = String(activity?.start_date_local || activity?.start_date || '');
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

export function activitiesInLocalDateRange(activities, startDate, endDate, limit = Infinity) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || '')) ||
      startDate > endDate) return [];
  const matched = (activities || []).filter(activity => {
      const date = activityLocalDate(activity);
      return date && date >= startDate && date <= endDate;
    });
  return Number.isFinite(limit) ? matched.slice(0, Math.max(0, limit)) : matched;
}

export function mergeActivityDetail(activity, detail, hrZones = null) {
  const base = { ...activity, hr_zones: hrZones || null };
  if (!detail) return base;
  return {
    ...base,
    description: detail.description || null,
    start_date: detail.start_date || activity.start_date,
    start_date_local: detail.start_date_local || activity.start_date_local,
    timezone: detail.timezone || activity.timezone || null,
    utc_offset: detail.utc_offset ?? activity.utc_offset ?? null,
    moving_time: detail.moving_time ?? activity.moving_time ?? null,
    elapsed_time: detail.elapsed_time ?? activity.elapsed_time ?? null,
    distance: detail.distance ?? activity.distance ?? null,
    total_elevation_gain: detail.total_elevation_gain ?? activity.total_elevation_gain ?? null,
    elev_high: detail.elev_high ?? activity.elev_high ?? null,
    elev_low: detail.elev_low ?? activity.elev_low ?? null,
    average_speed: detail.average_speed ?? activity.average_speed ?? null,
    max_speed: detail.max_speed ?? activity.max_speed ?? null,
    average_grade_adjusted_speed: detail.average_grade_adjusted_speed ?? activity.average_grade_adjusted_speed ?? null,
    average_heartrate: detail.average_heartrate ?? activity.average_heartrate ?? null,
    max_heartrate: detail.max_heartrate ?? activity.max_heartrate ?? null,
    average_cadence: detail.average_cadence ?? activity.average_cadence ?? null,
    average_watts: detail.average_watts ?? activity.average_watts ?? null,
    weighted_average_watts: detail.weighted_average_watts ?? activity.weighted_average_watts ?? null,
    max_watts: detail.max_watts ?? activity.max_watts ?? null,
    kilojoules: detail.kilojoules ?? activity.kilojoules ?? null,
    device_watts: detail.device_watts ?? activity.device_watts ?? null,
    average_temp: detail.average_temp ?? activity.average_temp ?? null,
    calories: detail.calories ?? null,
    suffer_score: detail.suffer_score ?? activity.suffer_score ?? null,
    perceived_exertion: detail.perceived_exertion ?? null,
    achievement_count: detail.achievement_count ?? activity.achievement_count ?? null,
    pr_count: detail.pr_count ?? activity.pr_count ?? null,
    kudos_count: detail.kudos_count ?? activity.kudos_count ?? null,
    comment_count: detail.comment_count ?? activity.comment_count ?? null,
    athlete_count: detail.athlete_count ?? activity.athlete_count ?? null,
    photo_count: detail.photo_count ?? activity.photo_count ?? null,
    total_photo_count: detail.total_photo_count ?? activity.total_photo_count ?? null,
    trainer: detail.trainer ?? activity.trainer ?? null,
    commute: detail.commute ?? activity.commute ?? null,
    manual: detail.manual ?? activity.manual ?? null,
    workout_type: detail.workout_type ?? activity.workout_type ?? null,
    gear: detail.gear || null,
    device_name: detail.device_name || null,
    splits_metric: detail.splits_metric || [],
    laps: detail.laps || [],
    segment_effort_count: Array.isArray(detail.segment_efforts) ? detail.segment_efforts.length : null,
    best_efforts: (detail.best_efforts || []).map(effort => ({
      name: effort.name,
      distance: effort.distance,
      elapsed_time: effort.elapsed_time,
      moving_time: effort.moving_time,
      pr_rank: effort.pr_rank ?? null,
    })),
  };
}

// ── Weekly stats helper ───────────────────────────────────────────────────────

function dateStringInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function weeklyStats(
  activities,
  now = new Date(),
  timeZone = process.env.DASHBOARD_TIME_ZONE || 'Australia/Adelaide'
) {
  // Anchor the reporting week to the dashboard's local Monday. Vercel runs in
  // UTC, which is still Sunday during the first hours of Monday in Adelaide.
  const todayStr = dateStringInTimeZone(now, timeZone);
  const todayUTC = new Date(`${todayStr}T00:00:00Z`);
  const day = todayUTC.getUTCDay();
  const daysFromMonday = (day + 6) % 7;
  const mondayUTC = new Date(todayUTC);
  mondayUTC.setUTCDate(todayUTC.getUTCDate() - daysFromMonday);
  const mondayStr = mondayUTC.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const previousMondayUTC = new Date(mondayUTC);
  previousMondayUTC.setUTCDate(mondayUTC.getUTCDate() - 7);
  const previousMondayStr = previousMondayUTC.toISOString().slice(0, 10);

  let weeklyKm = 0, weeklyRuns = 0, lastWeekKm = 0, lastWeekRuns = 0;
  const historyByWeekEnd = new Map();
  for (const a of activities) {
    const localDate = (a.start_date_local || a.start_date || '').slice(0, 10);
    const isRun = a.type === 'Run' || a.sport_type === 'Run';
    if (!isRun || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) continue;

    const activityDateUTC = new Date(`${localDate}T00:00:00Z`);
    const activityDaysFromMonday = (activityDateUTC.getUTCDay() + 6) % 7;
    const activityMondayUTC = new Date(activityDateUTC);
    activityMondayUTC.setUTCDate(activityDateUTC.getUTCDate() - activityDaysFromMonday);
    const activitySundayUTC = new Date(activityMondayUTC);
    activitySundayUTC.setUTCDate(activityMondayUTC.getUTCDate() + 6);
    const weekStart = activityMondayUTC.toISOString().slice(0, 10);
    const weekEnd = activitySundayUTC.toISOString().slice(0, 10);
    const distanceKm = (a.distance || 0) / 1000;
    const history = historyByWeekEnd.get(weekEnd) || { weekStart, weekEnd, km: 0, runs: 0 };
    history.km += distanceKm;
    history.runs += 1;
    historyByWeekEnd.set(weekEnd, history);

    if (localDate >= mondayStr) {
      weeklyKm   += distanceKm;
      weeklyRuns += 1;
    } else if (localDate >= previousMondayStr && localDate < mondayStr) {
      lastWeekKm   += distanceKm;
      lastWeekRuns += 1;
    }
  }

  const lastRun = activities.find(a => a.type === 'Run' || a.sport_type === 'Run');
  const daysSince = lastRun
    ? Math.floor((now.getTime() - new Date(lastRun.start_date)) / 86400000)
    : null;

  return {
    weeklyKm:        Math.round(weeklyKm * 10) / 10,
    weeklyRuns,
    lastWeekKm:      Math.round(lastWeekKm * 10) / 10,
    lastWeekRuns,
    weeklyHistory:   [...historyByWeekEnd.values()]
      .map(week => ({ ...week, km: Math.round(week.km * 10) / 10 }))
      .sort((a, b) => a.weekEnd.localeCompare(b.weekEnd)),
    daysSinceLastRun: daysSince,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCoachCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try { requireCoach(req); } catch (error) { return coachError(res, error); }

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

    const historyStart = String(req.query.history_start || '').trim();
    let afterEpoch = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(historyStart)) {
      const startMs = Date.parse(`${historyStart}T00:00:00Z`);
      if (Number.isFinite(startMs)) {
        // Include a one-day timezone buffer. Weekly aggregation uses each
        // activity's start_date_local, so anything before Week 1 is discarded
        // naturally by the dashboard's programme-week mapping.
        afterEpoch = Math.floor((startMs - 86400000) / 1000);
      }
    }

    // Fetch and aggregate every activity since this athlete's Week 1. The date
    // range grows with their programme, so Week 18+ is not truncated by a
    // fixed week or activity limit.
    const activities = await fetchActivities(access_token, { afterEpoch, perPage: 200 });
    const stats      = weeklyStats(activities);

    // Squad-card prefetch only needs aggregate stats. Full-page requests send
    // the selected Mon-Sun range, so that historical week's activities receive
    // detail, laps, efforts and zones without enriching the entire programme.
    const summaryOnly = String(req.query.summary || '') === '1';
    const detailStart = String(req.query.detail_start || '').trim();
    const detailEnd = String(req.query.detail_end || '').trim();
    const hasDetailRange = /^\d{4}-\d{2}-\d{2}$/.test(detailStart) &&
      /^\d{4}-\d{2}-\d{2}$/.test(detailEnd) && detailStart <= detailEnd;
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const toEnrich = summaryOnly
      ? []
      : hasDetailRange
        ? activitiesInLocalDateRange(activities, detailStart, detailEnd, 20)
        : activities.filter(a => activityLocalDate(a) >= cutoff).slice(0, 8);
    const details = await Promise.all(toEnrich.map(a => fetchActivityDetail(access_token, a.id)));
    const zoneResults = await Promise.all(toEnrich.map(a =>
      a.has_heartrate ? fetchActivityZones(access_token, a.id) : Promise.resolve(null)
    ));
    const detailMap = {}, zonesMap = {};
    details.forEach(d => { if (d) detailMap[d.id] = d; });
    toEnrich.forEach((a, i) => { if (zoneResults[i]) zonesMap[a.id] = zoneResults[i]; });

    // Keep every summary activity since programme start for exact historical
    // date alignment; selected-week activities are replaced with detailed data.
    const enriched = activities.map(a =>
      mergeActivityDetail(a, detailMap[a.id], zonesMap[a.id] || null)
    );

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    return res.status(200).json({
      connected:  true,
      stats,
      activities: summaryOnly ? [] : enriched,
      detailRange: hasDetailRange ? { start: detailStart, end: detailEnd } : null,
    });
  } catch (err) {
    console.error('[strava-coach]', err);
    return res.status(500).json({ error: err.message });
  }
}
