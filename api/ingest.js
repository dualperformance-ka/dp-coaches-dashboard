// /api/ingest.js — the single athlete write endpoint.
//
// Supabase is the source of truth. Every coach-facing write from the portal is
// persisted straight into the structured Supabase tables here. There is no
// external mirror: the Notion sync (and its retry outbox) was removed on
// 2026-07-20, so this endpoint now succeeds or fails purely on the Supabase write.
//
// Identity: the Supabase roster (public.athletes) is the sole source of identity.
// Every athlete code comes from a verified email JWT or signed access-code
// session; client-supplied identity is overwritten.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Env required for GHL check-in tagging (best-effort): GHL_API_KEY.
import { upsert } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest } from './_lib/http.js';
import { createHash } from 'node:crypto';
import {
  activityFormat,
  decodeBase64File,
  parseActivityFile,
} from '../server/activity-file.js';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

// Column-tolerant upsert. New optional columns (the strength swap fields) ship
// in the same release as their migration, and whichever lands first would
// otherwise reject every write in between — a training log lost to deploy
// ordering. PostgREST names the offending column, so we drop it and retry;
// raw_payload still carries the full submission either way, so nothing is
// actually lost while the migration catches up.
export const OPTIONAL_COLUMNS = ['exercise_name', 'programmed_exercise', 'muscle_group', 'is_swap'];

export async function upsertTolerant(table, row, onConflict, write = upsert) {
  let attempt = { ...row };
  for (let i = 0; i <= OPTIONAL_COLUMNS.length; i++) {
    try {
      return await write(table, attempt, onConflict);
    } catch (error) {
      const message = String(error?.message || '');
      const missing = OPTIONAL_COLUMNS.find(
        (column) => Object.hasOwn(attempt, column) && message.includes(`'${column}'`)
      );
      if (!missing) throw error;
      console.warn(`[ingest] ${table}.${missing} not present yet — retrying without it`);
      delete attempt[missing];
    }
  }
  return write(table, attempt, onConflict);
}

function has(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function text(value, max = 2000) {
  return has(value) ? String(value).trim().slice(0, max) : null;
}

function number(value) {
  if (!has(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function date(value) {
  const v = text(value, 40);
  return /^\d{4}-\d{2}-\d{2}/.test(v || '') ? v.slice(0, 10) : null;
}

// Dual Performance coaches and athletes are in South Australia. new Date()
// .toISOString() returns a UTC date, so between midnight and ~09:30 local it
// names YESTERDAY — and because these logs upsert on (athlete_code, log_date),
// an early-morning entry with no explicit date overwrote the previous day's
// real body or nutrition log rather than creating a new one.
const LOCAL_TIME_ZONE = process.env.DP_TIME_ZONE || 'Australia/Adelaide';
function localToday(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: LOCAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// client_write_id carries a UNIQUE constraint that is not scoped to the athlete,
// and the portal's scheme ("strava_<activity id>") is guessable, so one athlete
// could upsert straight over another's session log. Namespacing by athlete code
// closes that; the random suffix keeps a missing id from inserting a duplicate
// row on every retry, since NULLs never conflict in a Postgres unique index.
function scopedWriteId(code, raw) {
  const id = text(raw, 90);
  const prefix = String(code || 'UNKNOWN').toUpperCase();
  if (!id) return `${prefix}:auto:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return id.startsWith(`${prefix}:`) ? id : `${prefix}:${id}`;
}

function submittedAt(payload) {
  return text(payload.submittedAt || payload.savedAt, 80) || new Date().toISOString();
}

function athleteCode(payload) {
  return text(payload.athleteCode, 120);
}

// Name must never be null: prefer the resolved/submitted name, fall back to the
// athlete code so every row stays human-identifiable.
function athleteName(payload) {
  return text(payload.athleteName, 180) || athleteCode(payload);
}

function weekKey(payload) {
  if (payload.weekKey) return text(payload.weekKey, 80);
  if (payload.weekEnding) return `week_ending_${date(payload.weekEnding) || text(payload.weekEnding, 40)}`;
  return payload.clientWriteId || null;
}

function safeFileName(value) {
  return String(value || 'activity')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
    .slice(0, 180) || 'activity';
}

function activityContentType(format, provided) {
  const value = text(provided, 120);
  if (value && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)) return value;
  return format === 'gpx' ? 'application/gpx+xml'
    : format === 'tcx' ? 'application/vnd.garmin.tcx+xml'
      : 'application/vnd.ant.fit';
}

async function storeOriginalActivity({ path, buffer, contentType }) {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !key) throw new Error('Supabase service credentials not configured');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${baseUrl}/storage/v1/object/athlete-activity-files/${encodedPath}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message || data.error || `Activity file storage failed (${response.status})`);
  }
}

export async function persistActivityFile(payload, write = upsert, store = storeOriginalActivity) {
  if (payload.coachAccessConsent !== true) {
    const error = new Error('Coach access consent is required for an activity-file upload');
    error.status = 400;
    throw error;
  }
  const code = athleteCode(payload);
  if (!code) throw new Error('Authenticated athlete identity is required');
  const originalFilename = safeFileName(payload.fileName);
  const format = activityFormat(originalFilename, payload.mimeType);
  if (!format) {
    const error = new Error('Choose a FIT, TCX or GPX activity file');
    error.status = 400;
    throw error;
  }
  const buffer = decodeBase64File(payload.fileBase64);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const parsed = parseActivityFile({ buffer, fileName: originalFilename, mimeType: payload.mimeType });
  const contentType = activityContentType(format, payload.mimeType);
  const rawFilePath = `${code}/${hash}.${format}`;

  await store({ path: rawFilePath, buffer, contentType });
  const rows = await write('athlete_activity_uploads', {
    athlete_code: code,
    athlete_name: athleteName(payload),
    client_write_id: text(payload.clientWriteId, 120) || `activity-${hash}`,
    content_hash: hash,
    source_format: parsed.sourceFormat,
    original_filename: originalFilename,
    content_type: contentType,
    file_size_bytes: buffer.length,
    raw_file_path: rawFilePath,
    activity_name: text(payload.sessionName, 240) || parsed.activityName,
    sport_type: parsed.sportType,
    activity_date: date(payload.activityDate) || parsed.activityDate,
    start_time: parsed.startTime,
    device_name: parsed.deviceName,
    summary: parsed.summary,
    laps: parsed.laps,
    splits: parsed.splits,
    streams: parsed.streams,
    parse_warnings: parsed.warnings,
    athlete_notes: text(payload.notes, 2000),
    coach_access_granted_at: new Date().toISOString(),
    consent_version: 'activity-file-coach-access-v1',
    submitted_at: submittedAt(payload),
    updated_at: new Date().toISOString(),
  }, 'athlete_code,content_hash');

  return {
    rows,
    activity: {
      name: text(payload.sessionName, 240) || parsed.activityName,
      sportType: parsed.sportType,
      activityDate: date(payload.activityDate) || parsed.activityDate,
      sourceFormat: parsed.sourceFormat,
      summary: parsed.summary,
      lapCount: parsed.laps.length,
      splitCount: parsed.splits.length,
      storedStreamPoints: parsed.streams.length,
      warnings: parsed.warnings,
    },
  };
}

async function persistStructured(payload) {
  const type = text(payload.type, 80);
  const code = athleteCode(payload);
  if (!code) return null;

  if (type === 'activity_file_import') {
    return persistActivityFile(payload);
  }

  if (type === 'goals') {
    return upsert('athlete_goals', {
      athlete_code: code,
      athlete_name: athleteName(payload),
      athlete_notion_id: text(payload.athleteId, 120),
      submitted_at: submittedAt(payload),
      goal_race: text(payload.goalRace, 240),
      race_date: date(payload.raceDate),
      peak_week: text(payload.peakWeek, 80),
      start_weight: number(payload.startWeight || payload.weight),
      target_weight: number(payload.targetWeight),
      body_fat: text(payload.bodyFat, 80),
      time_5k: text(payload.time5k, 80),
      time_10k: text(payload.time10k, 80),
      time_half: text(payload.timeHalf, 80),
      time_marathon: text(payload.timeMarathon, 80),
      long_run_pace: text(payload.lrPace, 80),
      why: text(payload.why, 2000),
      milestone_w4: text(payload.m4, 1000),
      milestone_w8: text(payload.m8, 1000),
      milestone_w12: text(payload.m12, 1000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code');
  }

  if (type === 'weekly_checkin') {
    return upsert('weekly_checkins', {
      athlete_code: code,
      athlete_name: athleteName(payload),
      athlete_notion_id: text(payload.athleteId, 120),
      week_key: weekKey(payload),
      week_ending: date(payload.weekEnding),
      submitted_at: submittedAt(payload),
      run_completed: number(payload.runCompleted),
      run_planned: number(payload.runPlanned),
      run_km: number(payload.runKm),
      run_feel: number(payload.runFeel),
      run_wins: text(payload.runWins, 2000),
      run_niggles: text(payload.runNiggles, 2000),
      lift_completed: number(payload.liftCompleted),
      lift_planned: number(payload.liftPlanned),
      lift_feel: number(payload.liftFeel),
      lift_wins: text(payload.liftWins, 2000),
      lift_niggles: text(payload.liftNiggles, 2000),
      sleep: text(payload.sleep, 80),
      energy: number(payload.energy),
      soreness: number(payload.soreness),
      nutrition: number(payload.nutrition),
      fuelling: text(payload.fuelling, 1000),
      social_eating: text(payload.socialEating, 1000),
      stress: number(payload.stress),
      motivation: number(payload.motivation),
      upcoming_impact: text(payload.upcomingImpact, 2000),
      testimonial: text(payload.testimonial, 2000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code,week_key');
  }

  if (type === 'daily_body') {
    return upsert('daily_body_logs', {
      athlete_code: code,
      athlete_name: athleteName(payload),
      athlete_notion_id: text(payload.athleteId, 120),
      log_date: date(payload.date) || localToday(),
      submitted_at: submittedAt(payload),
      weight: number(payload.weight),
      sleep: number(payload.sleep),
      energy: number(payload.energy),
      soreness: number(payload.soreness),
      stress: number(payload.stress),
      notes: text(payload.notes, 2000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code,log_date');
  }

  if (type === 'daily_nutrition') {
    return upsert('daily_nutrition_logs', {
      athlete_code: code,
      athlete_name: athleteName(payload),
      athlete_notion_id: text(payload.athleteId, 120),
      log_date: date(payload.date) || localToday(),
      submitted_at: submittedAt(payload),
      calories: number(payload.calories),
      protein: number(payload.protein),
      carbs: number(payload.carbs),
      fat: number(payload.fat),
      fibre: number(payload.fibre),
      notes: text(payload.notes, 2000),
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }, 'athlete_code,log_date');
  }

  if (type === 'Run' || type === 'Strength' || type === 'training_log') {
    return upsertTolerant('training_session_logs', {
      // client_write_id is globally unique, not per athlete, and the client's
      // scheme ("strava_<activity id>") is guessable. Namespacing it by athlete
      // stops one athlete's log from upserting over another's, and the random
      // fallback stops a missing id from inserting duplicates every retry
      // (NULLs are distinct in a Postgres unique index).
      client_write_id: scopedWriteId(code, payload.clientWriteId),
      athlete_code: code,
      athlete_name: athleteName(payload),
      athlete_notion_id: text(payload.athleteId, 120),
      session_name: text(payload.session, 240),
      session_category: text(payload.sessionCategory || payload.type, 80),
      session_date: date(payload.date),
      exercise_log: text(payload.exerciseLog, 2000),
      // Strength swap context. Sets are stored under the exercise actually
      // performed so progression follows the real movement; these columns keep
      // the link back to what was prescribed, and give the coach dashboard a
      // muscle-group dimension that survives any substitution.
      exercise_name: text(payload.exerciseName, 240),
      programmed_exercise: text(payload.programmedExercise, 240),
      muscle_group: text(payload.muscleGroup, 120),
      is_swap: payload.isSwap === true,
      distance_km: number(payload.distanceKm ?? payload.distance),
      duration_min: number(payload.durationMin ?? payload.duration),
      pace: text(payload.pace, 80),
      rpe: number(payload.rpe),
      feel: number(payload.feel),
      raw_sets: payload.rawSets ?? null,
      notes: text(payload.notes, 2000),
      raw_payload: payload,
      submitted_at: submittedAt(payload),
      updated_at: new Date().toISOString(),
    }, 'client_write_id');
  }

  return null;
}

// ── GHL check-in tagging ────────────────────────────────────────────────────
// On a weekly check-in submit, find the athlete's GHL contact via the Supabase
// ghl_map table (athlete_code -> ghl_contact_id) and add the "checkin_done" tag
// so the GHL reminder workflow skips them this week. Best-effort: any failure
// here must NOT block the check-in write. The Supabase client is imported LAZILY
// so a missing '@supabase/supabase-js' dependency cannot crash the function.
async function tagGhlCheckinDone(code) {
  if (!has(code)) return;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GHL_API_KEY) {
    console.warn('[ingest] GHL tagging skipped — missing env vars');
    return;
  }

  let createClient;
  try {
    ({ createClient } = await import('@supabase/supabase-js'));
  } catch (e) {
    console.warn('[ingest] GHL tagging skipped — @supabase/supabase-js not installed');
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await sb
    .from('ghl_map')
    .select('ghl_contact_id')
    .eq('athlete_code', String(code))
    .single();

  if (error || !data || !data.ghl_contact_id) {
    console.warn('[ingest] no ghl_map row for code', code);
    return;
  }

  const resp = await fetch(
    `https://services.leadconnectorhq.com/contacts/${data.ghl_contact_id}/tags`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: ['checkin_done'] }),
    }
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`GHL tag ${resp.status}: ${t}`);
  }
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });

  const body = req.body || {};
  // Accept both the current payload-only shape and the legacy { targetUrl, payload }
  // shape sent by older cached clients. targetUrl (the old Notion mirror target)
  // is ignored — everything is persisted to Supabase.
  let payload = body.payload || body;
  const identity = await getRequestAthlete(req);
  if (!identity) return send(res, 401, { ok: false, stage: 'auth', error: 'invalid_session' });
  payload = {
    ...payload,
    athleteCode: String(identity.athlete.code).toUpperCase(),
    athleteName: identity.athlete.name || String(identity.athlete.code),
  };

  try {
    const persisted = await persistStructured(payload);
    if (!persisted) return send(res, 400, { ok: false, error: 'unsupported_write_type' });
    if (text(payload.type, 80) === 'activity_file_import') {
      return send(res, 200, { ok: true, queued: false, activity: persisted.activity });
    }
  } catch (error) {
    const status = Number(error?.status) || 502;
    return send(res, status, { ok: false, stage: status < 500 ? 'validation' : 'supabase', error: error.message });
  }

  // Best-effort GHL tag on a weekly check-in — never let it fail the write.
  if (text(payload.type, 80) === 'weekly_checkin') {
    try { await tagGhlCheckinDone(athleteCode(payload)); }
    catch (e) { console.warn('[ingest] GHL tag failed:', e && e.message); }
  }

  return send(res, 200, { ok: true, queued: false });
}
