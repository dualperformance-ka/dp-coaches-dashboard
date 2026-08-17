// /api/my-logs.js — athlete-facing read of the structured, source-of-truth logs.
// The progress tab cannot read daily_body_logs directly (anon access is revoked
// by design), so this serverless function returns the athlete's own body logs
// using the service key, scoped to their athlete_code. This keeps the athlete's
// progress view in sync with exactly what the coach dashboard sees.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set for /api/ingest).
import { select } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest } from './_lib/http.js';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

export function publishedCoachTargetContract(row) {
  return {
    sport: row.sport,
    weekIdentifier: row.programme_week_id,
    distanceTargetMetres: row.distance_target_metres,
    sessionTarget: row.session_target,
    durationTargetMinutes: row.duration_target_minutes,
    coachNote: row.coach_note,
    source: 'coach',
    locked: true,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

export async function loadPublishedCoachTargets(athleteCode, request = select) {
  const rows = await request('weekly_sport_targets', {
    athlete_code: `eq.${athleteCode}`,
    publish_state: 'eq.published',
    removed_at: 'is.null',
    select: [
      'sport',
      'programme_week_id',
      'distance_target_metres',
      'session_target',
      'duration_target_minutes',
      'coach_note',
      'published_at',
      'updated_at',
    ].join(','),
    order: 'programme_week_id.asc,sport.asc',
  });
  return Array.isArray(rows) ? rows.map(publishedCoachTargetContract) : [];
}

export function publishedMacroOverrideContract(row) {
  return {
    date: row.override_date,
    weekIdentifier: row.programme_week_id,
    calories: row.calories,
    proteinG: row.protein_g,
    carbsG: row.carbs_g,
    fatsG: row.fats_g,
    fibreG: row.fibre_g,
    dayLabel: row.day_label,
    coachNote: row.coach_note,
    source: 'coach',
    locked: true,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

export async function loadPublishedMacroOverrides(athleteCode, request = select, today = new Date()) {
  const floor = new Date(today);
  floor.setUTCDate(floor.getUTCDate() - 60);
  const rows = await request('daily_macro_overrides', {
    athlete_code: `eq.${athleteCode}`,
    publish_state: 'eq.published',
    removed_at: 'is.null',
    override_date: `gte.${floor.toISOString().slice(0, 10)}`,
    select: [
      'override_date',
      'programme_week_id',
      'calories',
      'protein_g',
      'carbs_g',
      'fats_g',
      'fibre_g',
      'day_label',
      'coach_note',
      'published_at',
      'updated_at',
    ].join(','),
    order: 'override_date.asc',
  });
  return Array.isArray(rows) ? rows.map(publishedMacroOverrideContract) : [];
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'GET, OPTIONS')) return;

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });

  try {
    const identity = await getRequestAthlete(req);
    if (!identity) return send(res, 401, { ok: false, error: 'invalid_session', body: [] });
    const code = identity.athlete.code;
    const resource = String(req.query?.resource || '').trim().toLowerCase();
    if (resource === 'weekly-sport-targets') {
      const targets = await loadPublishedCoachTargets(code);
      return send(res, 200, { ok: true, targets });
    }
    if (resource === 'daily-macro-overrides') {
      const overrides = await loadPublishedMacroOverrides(code);
      return send(res, 200, { ok: true, overrides });
    }
    if (resource) return send(res, 400, { ok: false, error: 'unknown_resource' });
    const body = await select('daily_body_logs', {
      athlete_code: `eq.${code}`,
      select: 'log_date,weight,sleep,energy,stress,soreness,notes,raw_payload,submitted_at',
      order: 'log_date.desc',
      limit: '400',
    });
    return send(res, 200, { ok: true, body: Array.isArray(body) ? body : [] });
  } catch (e) {
    return send(res, 502, { ok: false, error: 'Unable to load body logs', body: [] });
  }
}
