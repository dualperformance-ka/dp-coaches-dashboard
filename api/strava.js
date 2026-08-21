/**
 * Protected coach Strava endpoint.
 *
 * GET /api/strava?athlete=CODE&history_start=YYYY-MM-DD
 *   &detail_start=YYYY-MM-DD&detail_end=YYYY-MM-DD
 * GET/POST /api/strava?mode=webhook (rewritten from /api/strava-webhook)
 */
import { coachError, requireCoach, setCoachCors } from '../server/coach-auth.js';
import { getRequestAthlete } from './_lib/auth.js';
import {
  cacheActivityDetail,
  cacheActivityStreams,
  canonicalAthleteCode,
  deleteCachedActivity,
  enqueueWebhookEvent,
  invalidateSyncState,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  readActivityCache,
  readAthleteZonesCache,
  readPendingWebhookEvents,
  readSyncState,
  removeStravaConnection,
  upsertActivitySummaries,
  writeAthleteZonesCache,
  writeSyncState,
} from '../server/strava-cache.js';
import { aerobicDecoupling, buildCoachingInsights } from '../server/strava-insights.js';
import { createStravaAuthorizeUrl } from '../server/strava-oauth-state.js';

const STRAVA_API = 'https://www.strava.com/api/v3';
const STRAVA_AUTH = 'https://www.strava.com/oauth/token';
const STRAVA_REVOKE = 'https://www.strava.com/oauth/revoke';
const LIST_CACHE_MS = 15 * 60 * 1000;
const ZONES_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const STREAM_KEYS = 'time,distance,heartrate,velocity_smooth,grade_smooth';

async function supabaseFetch(path, options = {}) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function getTokens(athleteCode) {
  const rows = await supabaseFetch(
    `athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens&select=value`
  );
  return Array.isArray(rows) && rows.length ? rows[0].value : null;
}

async function updateTokens(athleteCode, refreshed, tokens) {
  const updated = mergeRefreshedTokens(tokens, refreshed);
  await supabaseFetch(
    `athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}&key=eq.strava_tokens`,
    { method: 'PATCH', prefer: 'return=minimal', body: { value: updated, updated_at: new Date().toISOString() } }
  );
  return updated;
}

export function mergeRefreshedTokens(tokens, refreshed) {
  return {
    ...tokens,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: refreshed.expires_at,
  };
}

async function doRefreshToken(refreshToken) {
  const response = await fetch(STRAVA_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const error = new Error(`Token refresh failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function parseRateLimit(headers) {
  const split = value => String(value || '').split(',').map(Number).filter(Number.isFinite);
  const overall = split(headers.get('x-ratelimit-usage'));
  const read = split(headers.get('x-readratelimit-usage'));
  const overallLimit = split(headers.get('x-ratelimit-limit'));
  const readLimit = split(headers.get('x-readratelimit-limit'));
  if (!overall.length && !read.length) return null;
  return { overall, read, overallLimit, readLimit, observedAt: new Date().toISOString() };
}

function rateLimitNear(limit) {
  const near = (usage, maximum, shortRatio, dailyRatio) =>
    (maximum?.[0] > 0 && usage?.[0] / maximum[0] >= shortRatio) ||
    (maximum?.[1] > 0 && usage?.[1] / maximum[1] >= dailyRatio);
  return near(limit?.read, limit?.readLimit, 0.9, 0.95) ||
    near(limit?.overall, limit?.overallLimit, 0.9, 0.95);
}

async function stravaFetchJson(url, accessToken, rateContext, { optional = false } = {}) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  rateContext.latest = parseRateLimit(response.headers) || rateContext.latest;
  if (!response.ok) {
    if (optional && [401, 403, 404].includes(response.status)) return null;
    const error = new Error(`Strava request failed: ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after') || null;
    throw error;
  }
  return response.json();
}

async function fetchActivities(accessToken, rateContext, { afterEpoch = null, perPage = 200 } = {}) {
  const activities = [];
  let page = 1;
  while (true) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (afterEpoch != null) params.set('after', String(afterEpoch));
    const batch = await stravaFetchJson(`${STRAVA_API}/athlete/activities?${params}`, accessToken, rateContext);
    if (!Array.isArray(batch)) throw new Error('Strava activities returned an invalid response');
    activities.push(...batch);
    if (afterEpoch == null || batch.length < perPage) break;
    page += 1;
  }
  return activities;
}

async function fetchActivityDetail(accessToken, id, rateContext) {
  return stravaFetchJson(`${STRAVA_API}/activities/${id}`, accessToken, rateContext, { optional: true });
}

async function fetchActivityZones(accessToken, id, rateContext) {
  const zones = await stravaFetchJson(`${STRAVA_API}/activities/${id}/zones`, accessToken, rateContext, { optional: true });
  const heartRate = Array.isArray(zones) ? zones.find(zone => zone.type === 'heartrate') : null;
  return heartRate && Array.isArray(heartRate.distribution_buckets)
    ? heartRate.distribution_buckets
    : null;
}

async function fetchActivityStreams(accessToken, id, rateContext) {
  const params = new URLSearchParams({ keys: STREAM_KEYS, key_by_type: 'true' });
  return stravaFetchJson(`${STRAVA_API}/activities/${id}/streams?${params}`, accessToken, rateContext, { optional: true });
}

async function fetchAthleteZones(accessToken, rateContext) {
  return stravaFetchJson(`${STRAVA_API}/athlete/zones`, accessToken, rateContext, { optional: true });
}

export function activityLocalDate(activity) {
  const date = String(activity?.start_date_local || activity?.start_date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

export function activitiesInLocalDateRange(activities, startDate, endDate, limit = Infinity) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || '')) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || '')) || startDate > endDate) return [];
  const matched = (activities || []).filter(activity => {
    const date = activityLocalDate(activity);
    return date && date >= startDate && date <= endDate;
  });
  return Number.isFinite(limit) ? matched.slice(0, Math.max(0, limit)) : matched;
}

export function mergeActivityDetail(activity, detail, hrZones = null) {
  const base = { ...activity, hr_zones: hrZones || activity.hr_zones || null };
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
    perceived_exertion: detail.perceived_exertion ?? activity.perceived_exertion ?? null,
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
    gear_id: detail.gear_id || activity.gear_id || detail.gear?.id || null,
    gear: detail.gear || activity.gear || null,
    device_name: detail.device_name || activity.device_name || null,
    splits_metric: detail.splits_metric || activity.splits_metric || [],
    laps: detail.laps || activity.laps || [],
    segment_effort_count: Array.isArray(detail.segment_efforts)
      ? detail.segment_efforts.length
      : activity.segment_effort_count ?? null,
    best_efforts: (detail.best_efforts || activity.best_efforts || []).map(effort => ({
      name: effort.name,
      distance: effort.distance,
      elapsed_time: effort.elapsed_time,
      moving_time: effort.moving_time,
      pr_rank: effort.pr_rank ?? null,
    })),
  };
}

function dateStringInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function weeklyStats(activities, now = new Date(), timeZone = process.env.DASHBOARD_TIME_ZONE || 'Australia/Adelaide') {
  const todayStr = dateStringInTimeZone(now, timeZone);
  const todayUTC = new Date(`${todayStr}T00:00:00Z`);
  const mondayUTC = new Date(todayUTC);
  mondayUTC.setUTCDate(todayUTC.getUTCDate() - ((todayUTC.getUTCDay() + 6) % 7));
  const mondayStr = mondayUTC.toISOString().slice(0, 10);
  const previousMondayUTC = new Date(mondayUTC);
  previousMondayUTC.setUTCDate(mondayUTC.getUTCDate() - 7);
  const previousMondayStr = previousMondayUTC.toISOString().slice(0, 10);
  let weeklyKm = 0, weeklyRuns = 0, lastWeekKm = 0, lastWeekRuns = 0;
  const historyByWeekEnd = new Map();
  for (const activity of activities || []) {
    const localDate = activityLocalDate(activity);
    const isRun = activity.type === 'Run' || activity.sport_type === 'Run';
    if (!isRun || !localDate) continue;
    const activityDateUTC = new Date(`${localDate}T00:00:00Z`);
    const activityMondayUTC = new Date(activityDateUTC);
    activityMondayUTC.setUTCDate(activityDateUTC.getUTCDate() - ((activityDateUTC.getUTCDay() + 6) % 7));
    const activitySundayUTC = new Date(activityMondayUTC);
    activitySundayUTC.setUTCDate(activityMondayUTC.getUTCDate() + 6);
    const weekStart = activityMondayUTC.toISOString().slice(0, 10);
    const weekEnd = activitySundayUTC.toISOString().slice(0, 10);
    const distanceKm = (activity.distance || 0) / 1000;
    const history = historyByWeekEnd.get(weekEnd) || { weekStart, weekEnd, km: 0, runs: 0 };
    history.km += distanceKm;
    history.runs += 1;
    historyByWeekEnd.set(weekEnd, history);
    if (localDate >= mondayStr) { weeklyKm += distanceKm; weeklyRuns += 1; }
    else if (localDate >= previousMondayStr && localDate < mondayStr) {
      lastWeekKm += distanceKm; lastWeekRuns += 1;
    }
  }
  const lastRun = (activities || []).find(activity => activity.type === 'Run' || activity.sport_type === 'Run');
  return {
    weeklyKm: Math.round(weeklyKm * 10) / 10,
    weeklyRuns,
    lastWeekKm: Math.round(lastWeekKm * 10) / 10,
    lastWeekRuns,
    weeklyHistory: [...historyByWeekEnd.values()]
      .map(week => ({ ...week, km: Math.round(week.km * 10) / 10 }))
      .sort((a, b) => a.weekEnd.localeCompare(b.weekEnd)),
    daysSinceLastRun: lastRun ? Math.floor((now.getTime() - new Date(lastRun.start_date)) / 86400000) : null,
  };
}

export function unavailableActivitiesResponse(error) {
  if (error?.status !== 429) return null;
  return { connected: true, activities: [], activitiesAvailable: false, warning: 'strava_rate_limited' };
}

function cacheRowsToActivities(rows) {
  return (rows || []).map(row => {
    const activity = mergeActivityDetail(row.summary || {}, row.detail, row.hr_zones);
    const decoupling = aerobicDecoupling(row.streams);
    return decoupling ? { ...activity, aerobic_decoupling: decoupling } : activity;
  }).sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')));
}

function syncIsFresh(syncState) {
  const syncedAt = Date.parse(syncState?.last_list_sync || '');
  const invalidatedAt = Date.parse(syncState?.invalidated_at || '');
  return Number.isFinite(syncedAt) && Date.now() - syncedAt < LIST_CACHE_MS &&
    (!Number.isFinite(invalidatedAt) || invalidatedAt <= syncedAt);
}

function isLongRun(activity) {
  return /long/i.test(String(activity?.name || '')) || activity?.workout_type === 2 ||
    Number(activity?.distance) >= 15000 || Number(activity?.moving_time) >= 90 * 60;
}

async function enrichSelectedActivities(athleteCode, accessToken, activities, cacheRows, toEnrich, rateContext) {
  const rowsById = new Map((cacheRows || []).map(row => [String(row.activity_id), row]));
  const detailMap = new Map();
  const zonesMap = new Map();
  const streamsMap = new Map();
  await Promise.all(toEnrich.map(async activity => {
    const id = String(activity.id);
    const cached = rowsById.get(id);
    let detail = cached?.detail || null;
    let zones = cached?.hr_zones || null;
    let streams = cached?.streams || null;
    if (!cached?.detail_cached_at) {
      detail = await fetchActivityDetail(accessToken, activity.id, rateContext);
      zones = activity.has_heartrate ? await fetchActivityZones(accessToken, activity.id, rateContext) : null;
      if (detail) await cacheActivityDetail(athleteCode, activity.id, detail, zones).catch(error => {
        console.warn('[strava-cache] detail cache unavailable:', error.message);
      });
    }
    const detailed = mergeActivityDetail(activity, detail, zones);
    if (!cached?.streams_cached_at && isLongRun(detailed) && detailed.has_heartrate !== false) {
      streams = await fetchActivityStreams(accessToken, activity.id, rateContext);
      await cacheActivityStreams(athleteCode, activity.id, streams).catch(error => {
        console.warn('[strava-cache] stream cache unavailable:', error.message);
      });
    }
    detailMap.set(id, detail);
    zonesMap.set(id, zones);
    streamsMap.set(id, streams);
  }));
  return activities.map(activity => {
    const id = String(activity.id);
    const merged = mergeActivityDetail(activity, detailMap.get(id), zonesMap.get(id));
    const decoupling = aerobicDecoupling(streamsMap.get(id));
    return decoupling ? { ...merged, aerobic_decoupling: decoupling } : merged;
  });
}

async function athleteZones(athleteCode, accessToken, rateContext) {
  const cached = await readAthleteZonesCache(athleteCode).catch(() => null);
  const age = Date.now() - Date.parse(cached?.updated_at || '');
  if (cached && Number.isFinite(age) && age < ZONES_CACHE_MS) return cached.value || null;
  const zones = await fetchAthleteZones(accessToken, rateContext);
  await writeAthleteZonesCache(athleteCode, zones || null).catch(() => {});
  return zones || cached?.value || null;
}

export function normaliseScopes(value) {
  const scopes = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(scopes.map(scope => String(scope).trim().toLowerCase()).filter(Boolean))];
}

function connectionHealth(tokens, syncState, cacheRows, warning = null) {
  const scopes = normaliseScopes(tokens?.scope);
  const activityReadAll = scopes.includes('activity:read_all');
  const profileReadAll = scopes.includes('profile:read_all');
  const lastSyncAt = syncState?.last_list_sync || null;
  const syncAgeMinutes = lastSyncAt && Number.isFinite(Date.parse(lastSyncAt))
    ? Math.max(0, Math.round((Date.now() - Date.parse(lastSyncAt)) / 60000))
    : null;
  const rows = Array.isArray(cacheRows) ? cacheRows : [];
  const status = warning === 'strava_reconnect_required'
    ? 'needs_reconnect'
    : (!activityReadAll || !profileReadAll ? 'limited' : 'healthy');
  return {
    status,
    athleteName: tokens?.athlete_name || null,
    connectedAt: tokens?.connected_at || null,
    lastSyncAt,
    syncAgeMinutes,
    lastChangeAt: syncState?.invalidated_at || null,
    lastChangeReason: syncState?.reason || null,
    scopes: { granted: scopes, activityReadAll, profileReadAll },
    coverage: {
      cachedActivities: rows.length,
      detailedActivities: rows.filter(row => row?.detail_cached_at).length,
      streamedActivities: rows.filter(row => row?.streams_cached_at).length,
      heartRateActivities: rows.filter(row => row?.summary?.has_heartrate || row?.hr_zones).length,
    },
  };
}

async function processPendingWebhookEvents(athleteCode, stravaAthleteId) {
  if (!Number.isFinite(Number(stravaAthleteId))) return { processed: 0, deauthorized: false };
  const events = await readPendingWebhookEvents(stravaAthleteId).catch(error => {
    console.warn('[strava-webhook] pending event read unavailable:', error.message);
    return [];
  });
  let processed = 0;
  let deauthorized = false;
  for (const event of events || []) {
    try {
      if (event.object_type === 'athlete' && event.aspect_type === 'update' &&
          String(event.updates?.authorized) === 'false') {
        await removeStravaConnection(athleteCode);
        deauthorized = true;
      } else if (event.object_type === 'activity' && event.aspect_type === 'delete') {
        await deleteCachedActivity(athleteCode, event.object_id);
        await invalidateSyncState(athleteCode, 'activity_deleted');
      } else if (event.object_type === 'activity') {
        await invalidateSyncState(athleteCode, `activity_${event.aspect_type || 'changed'}`);
      }
      await markWebhookEventProcessed(event.id, athleteCode);
      processed += 1;
    } catch (error) {
      await markWebhookEventFailed(event.id, error, event.attempts).catch(() => {});
      console.warn('[strava-webhook] event processing failed:', error.message);
    }
  }
  return { processed, deauthorized };
}

async function revokeStravaConnection(athleteCode) {
  let tokens = await getTokens(athleteCode);
  if (!tokens?.access_token) return;
  if (Date.now() / 1000 > Number(tokens.expires_at) - 300 && tokens.refresh_token) {
    tokens = await updateTokens(athleteCode, await doRefreshToken(tokens.refresh_token), tokens);
  }
  const basic = Buffer.from(`${process.env.STRAVA_CLIENT_ID}:${process.env.STRAVA_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(STRAVA_REVOKE, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token: tokens.access_token }),
  });
  if (!response.ok && response.status !== 401) {
    const error = new Error(`Strava deauthorization failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  await removeStravaConnection(athleteCode);
}

async function handleWebhook(req, res) {
  if (req.method === 'GET') {
    const mode = String(req.query['hub.mode'] || '');
    const verifyToken = String(req.query['hub.verify_token'] || '');
    const challenge = req.query['hub.challenge'];
    if (mode !== 'subscribe' || !process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ||
        verifyToken !== process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
      return res.status(403).json({ error: 'Webhook verification failed' });
    }
    return res.status(200).json({ 'hub.challenge': challenge });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const event = req.body || {};
  if (!process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID ||
      String(event.subscription_id) !== String(process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID)) {
    return res.status(403).json({ error: 'Unknown subscription' });
  }
  if (!Number.isFinite(Number(event.owner_id)) || !Number.isFinite(Number(event.object_id)) ||
      !['activity', 'athlete'].includes(String(event.object_type || '')) ||
      !['create', 'update', 'delete'].includes(String(event.aspect_type || ''))) {
    return res.status(400).json({ error: 'Invalid webhook event' });
  }
  // A single durable insert keeps acknowledgement comfortably inside Strava's
  // two-second requirement. Protected reads drain the inbox for that athlete.
  await Promise.race([
    enqueueWebhookEvent(event),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Webhook queue timeout')), 1200)),
  ]).catch(error => console.error('[strava-webhook] queue failed:', error.message));
  return res.status(200).json({ received: true });
}

export default async function handler(req, res) {
  const mode = String(req.query?.mode || 'coach');
  if (mode === 'webhook') return handleWebhook(req, res);
  const portalMode = mode === 'athlete' || mode === 'athlete-disconnect';
  if (!portalMode) {
    setCoachCors(req, res, 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
  }
  const allowedMethod = mode === 'athlete-disconnect' ? 'POST' : 'GET';
  if (req.method !== allowedMethod) return res.status(405).json({ error: 'Method not allowed' });

  let athleteCode = '';
  if (portalMode) {
    const identity = await getRequestAthlete(req);
    if (!identity?.athlete?.code) return res.status(401).json({ error: 'Athlete session required' });
    athleteCode = canonicalAthleteCode(identity.athlete.code);
  } else {
    try { requireCoach(req); } catch (error) { return coachError(res, error); }
    return res.status(403).json({
      error: 'Direct Strava activity display is athlete-only. Use athlete-submitted training logs for coaching.',
      code: 'strava_athlete_only',
    });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' });
  }
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(500).json({ error: 'STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set' });
  }

  res.setHeader('Cache-Control', 'no-store');
  if (mode === 'athlete-disconnect') {
    try {
      await revokeStravaConnection(athleteCode);
      return res.status(200).json({ ok: true, connected: false });
    } catch (error) {
      console.error('[strava-disconnect]', error);
      return res.status(502).json({ error: 'Strava could not be disconnected. Please try again.' });
    }
  }

  let tokens = null;
  let syncState = null;
  let cacheRows = [];
  try {
    const authorizeUrl = portalMode ? createStravaAuthorizeUrl(req, athleteCode) : null;
    tokens = await getTokens(athleteCode);
    if (!tokens?.access_token) return res.status(200).json({
      connected: false,
      connection: { status: 'disconnected' },
      authorizeUrl,
      connectUrl: authorizeUrl,
    });
    const pending = await processPendingWebhookEvents(athleteCode, tokens.strava_athlete_id);
    if (pending.deauthorized) return res.status(200).json({
      connected: false,
      connection: { status: 'disconnected', lastChangeReason: 'deauthorized' },
      authorizeUrl,
      connectUrl: authorizeUrl,
    });
    if (Date.now() / 1000 > Number(tokens.expires_at) - 300) {
      tokens = await updateTokens(athleteCode, await doRefreshToken(tokens.refresh_token), tokens);
    }
    const accessToken = tokens.access_token;
    const rateContext = { latest: null };
    const historyStart = String(req.query.history_start || '').trim();
    let afterEpoch = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(historyStart)) {
      const startMs = Date.parse(`${historyStart}T00:00:00Z`);
      if (Number.isFinite(startMs)) afterEpoch = Math.floor((startMs - 86400000) / 1000);
    }

    cacheRows = await readActivityCache(athleteCode, historyStart).catch(() => []);
    syncState = await readSyncState(athleteCode).catch(() => null);
    rateContext.latest = syncState?.rate_limit || null;
    let activities = cacheRowsToActivities(cacheRows);
    let warning = null;
    let didRefresh = false;
    const forceRefresh = !portalMode && String(req.query.force || '') === '1';
    if (forceRefresh || !activities.length || !syncIsFresh(syncState)) {
      try {
        activities = await fetchActivities(accessToken, rateContext, { afterEpoch, perPage: 200 });
        didRefresh = true;
        await upsertActivitySummaries(athleteCode, activities).catch(error => {
          console.warn('[strava-cache] summary cache unavailable:', error.message);
        });
        await writeSyncState(athleteCode, {
          ...(syncState || {}),
          last_list_sync: new Date().toISOString(),
          activity_count: activities.length,
          rate_limit: rateContext.latest,
          last_sync_source: forceRefresh ? 'coach_manual' : (pending.processed ? 'webhook' : 'scheduled_read'),
        }).catch(() => {});
        cacheRows = await readActivityCache(athleteCode, historyStart).catch(() => cacheRows);
        if (cacheRows.length) activities = cacheRowsToActivities(cacheRows);
      } catch (error) {
        if (error.status !== 429 || !activities.length) throw error;
        warning = 'strava_rate_limited_stale_cache';
      }
    }

    const stats = weeklyStats(activities);
    const summaryOnly = String(req.query.summary || '') === '1';
    const detailStart = String(req.query.detail_start || '').trim();
    const detailEnd = String(req.query.detail_end || '').trim();
    const hasDetailRange = /^\d{4}-\d{2}-\d{2}$/.test(detailStart) &&
      /^\d{4}-\d{2}-\d{2}$/.test(detailEnd) && detailStart <= detailEnd;
    const requestedActivityId = String(req.query.activity_id || '').trim();
    // Detail is genuinely lazy: selected-week loads return summaries plus any
    // permanent detail already cached. A coach opening one activity sends its
    // id and spends at most detail + zones (+ streams for a long run) once.
    const explicitlyRequested = /^\d+$/.test(requestedActivityId)
      ? activities.filter(activity => String(activity.id) === requestedActivityId).slice(0, 1)
      : [];
    const rowsById = new Map(cacheRows.map(row => [String(row.activity_id), row]));
    const recentCutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const recentForMatcher = !summaryOnly && !hasDetailRange && !explicitlyRequested.length
      ? activities.filter(activity => activityLocalDate(activity) >= recentCutoff &&
          !rowsById.get(String(activity.id))?.detail_cached_at).slice(0, 3)
      : [];
    const toEnrich = explicitlyRequested.length ? explicitlyRequested : recentForMatcher;
    if (toEnrich.length && rateLimitNear(rateContext.latest)) {
      warning = warning || 'strava_rate_limit_near';
    } else if (toEnrich.length) {
      activities = await enrichSelectedActivities(athleteCode, accessToken, activities, cacheRows, toEnrich, rateContext);
    }
    const selectedActivities = hasDetailRange
      ? activitiesInLocalDateRange(activities, detailStart, detailEnd)
      : activities;
    const grantedScopes = normaliseScopes(tokens.scope);
    const zones = grantedScopes.includes('profile:read_all')
      ? await athleteZones(athleteCode, accessToken, rateContext).catch(() => null)
      : null;
    const latestSyncState = didRefresh
      ? { ...(syncState || {}), last_list_sync: new Date().toISOString(), rate_limit: rateContext.latest }
      : syncState;
    return res.status(200).json({
      connected: true,
      activitiesAvailable: true,
      warning,
      connection: connectionHealth(tokens, latestSyncState, cacheRows, warning),
      authorizeUrl,
      connectUrl: authorizeUrl,
      stats,
      activities: summaryOnly ? [] : activities,
      detailRange: hasDetailRange ? { start: detailStart, end: detailEnd } : null,
      athleteZones: zones,
      insights: summaryOnly ? null : buildCoachingInsights(selectedActivities),
      rateLimit: rateContext.latest || syncState?.rate_limit || null,
      cache: { list: didRefresh ? 'refreshed' : 'hit', permanentDetail: true, webhookEventsProcessed: pending.processed },
    });
  } catch (error) {
    console.error(portalMode ? '[strava-athlete]' : '[strava-coach]', error);
    if (error?.status === 401 || /refresh failed: 4\d\d/i.test(String(error?.message || ''))) {
      return res.status(200).json({
        connected: true,
        activitiesAvailable: false,
        warning: 'strava_reconnect_required',
        connection: connectionHealth(tokens, syncState, cacheRows, 'strava_reconnect_required'),
        authorizeUrl: portalMode ? createStravaAuthorizeUrl(req, athleteCode) : null,
      });
    }
    const unavailable = unavailableActivitiesResponse(error);
    if (unavailable) {
      if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
      return res.status(200).json({
        ...unavailable,
        connection: connectionHealth(tokens, syncState, cacheRows, 'strava_rate_limited'),
        authorizeUrl: portalMode ? createStravaAuthorizeUrl(req, athleteCode) : null,
      });
    }
    return res.status(500).json({ error: error.message });
  }
}
