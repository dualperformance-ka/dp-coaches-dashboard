import { remove, select, tablePath, supabaseRequest, upsert } from '../api/_lib/supabase-rest.js';

const SYNC_STATE_KEY = 'strava_sync_state';
const ZONES_KEY = 'strava_athlete_zones';

export function canonicalAthleteCode(value) {
  return String(value || '').trim().toUpperCase();
}

function activityRow(athleteCode, activity) {
  return {
    athlete_code: canonicalAthleteCode(athleteCode),
    activity_id: Number(activity.id),
    activity_date: String(activity.start_date_local || activity.start_date || '').slice(0, 10) || null,
    summary: activity,
    updated_at: new Date().toISOString(),
  };
}

export async function readActivityCache(athleteCode, startDate = '') {
  const query = {
    athlete_code: `eq.${canonicalAthleteCode(athleteCode)}`,
    select: 'activity_id,activity_date,summary,detail,hr_zones,streams,detail_cached_at,streams_cached_at,updated_at',
    order: 'activity_date.desc',
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) query.activity_date = `gte.${startDate}`;
  return select('strava_activities', query);
}

export async function upsertActivitySummaries(athleteCode, activities) {
  const rows = (activities || [])
    .filter(activity => activity && Number.isFinite(Number(activity.id)))
    .map(activity => activityRow(athleteCode, activity));
  if (!rows.length) return [];
  return upsert('strava_activities', rows, 'athlete_code,activity_id');
}

export async function cacheActivityDetail(athleteCode, activityId, detail, hrZones) {
  const now = new Date().toISOString();
  const values = { detail: detail || null, detail_cached_at: now, updated_at: now };
  if (hrZones !== undefined) values.hr_zones = hrZones;
  return supabaseRequest(tablePath('strava_activities', {
    athlete_code: `eq.${canonicalAthleteCode(athleteCode)}`,
    activity_id: `eq.${Number(activityId)}`,
  }), { method: 'PATCH', prefer: 'return=representation', body: values });
}

export async function cacheActivityStreams(athleteCode, activityId, streams) {
  const now = new Date().toISOString();
  return supabaseRequest(tablePath('strava_activities', {
    athlete_code: `eq.${canonicalAthleteCode(athleteCode)}`,
    activity_id: `eq.${Number(activityId)}`,
  }), {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { streams: streams || null, streams_cached_at: now, updated_at: now },
  });
}

export async function deleteCachedActivity(athleteCode, activityId) {
  return remove('strava_activities', {
    athlete_code: `eq.${canonicalAthleteCode(athleteCode)}`,
    activity_id: `eq.${Number(activityId)}`,
  });
}

async function readAthleteDataValue(athleteCode, key) {
  const rows = await select('athlete_data', {
    athlete_code: `eq.${canonicalAthleteCode(athleteCode)}`,
    key: `eq.${key}`,
    select: 'value,updated_at',
    limit: '1',
  });
  return rows?.[0] || null;
}

async function upsertAthleteDataValue(athleteCode, key, value) {
  return upsert('athlete_data', {
    athlete_code: canonicalAthleteCode(athleteCode),
    key,
    value,
    updated_at: new Date().toISOString(),
  }, 'athlete_code,key');
}

export async function readSyncState(athleteCode) {
  return (await readAthleteDataValue(athleteCode, SYNC_STATE_KEY))?.value || null;
}

export async function writeSyncState(athleteCode, value) {
  return upsertAthleteDataValue(athleteCode, SYNC_STATE_KEY, value);
}

export async function invalidateSyncState(athleteCode, reason = 'webhook') {
  const current = await readSyncState(athleteCode);
  return writeSyncState(athleteCode, { ...(current || {}), invalidated_at: new Date().toISOString(), reason });
}

export async function readAthleteZonesCache(athleteCode) {
  return readAthleteDataValue(athleteCode, ZONES_KEY);
}

export async function writeAthleteZonesCache(athleteCode, zones) {
  return upsertAthleteDataValue(athleteCode, ZONES_KEY, zones);
}

export async function removeStravaConnection(athleteCode) {
  const code = canonicalAthleteCode(athleteCode);
  await remove('athlete_data', { athlete_code: `eq.${code}`, key: 'eq.strava_tokens' });
  return invalidateSyncState(code, 'deauthorized');
}

export async function findAthleteCodeByStravaId(stravaAthleteId) {
  const rows = await select('athlete_data', {
    key: 'eq.strava_tokens',
    'value->>strava_athlete_id': `eq.${Number(stravaAthleteId)}`,
    select: 'athlete_code',
    limit: '1',
  });
  return canonicalAthleteCode(rows?.[0]?.athlete_code);
}
