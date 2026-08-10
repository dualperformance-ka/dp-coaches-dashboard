// Authenticated athlete data gateway.
//
// `/api/portal-data` rewrites here with `?mode=portal`. The historic `/api/write`
// endpoint is intentionally retired and returns 410 so old unauthenticated
// Notion writes cannot be revived accidentally.

import { remove, select, upsert } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest, safeError } from './_lib/http.js';
import { syncBookingsForAthlete } from './bookings.js';
import crypto from 'node:crypto';

const ALLOWED_STATE_KEYS = [
  /^goals$/,
  /^logs$/,
  /^ticked$/,
  /^reschedules$/,
  /^photos$/,
  /^ex_picks$/,
  /^pending_writes$/,
  /^strava_ack$/,
  /^strava_match_rejections$/,
  // ISO week keys ("call_booked_2026_31") — the format the portal, the GHL
  // webhook and the backlog sync all write. The old date form is kept so any
  // historic row still round-trips.
  /^call_booked_\d{4}_\d{2}$/,
  /^call_booked_\d{4}-\d{2}-\d{2}$/,
  /^checkin_[a-z0-9_-]{1,80}$/i,
  /^daily_body_\d{4}-\d{2}-\d{2}$/,
  /^daily_nut_\d{4}-\d{2}-\d{2}$/,
];

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function text(value, max = 100) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function date(value) {
  const candidate = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function weekLabel(value) {
  const candidate = text(value, 30);
  return /^Week \d{1,2}$/i.test(candidate) ? candidate : null;
}

function safeStateKey(value) {
  const key = text(value, 120);
  return ALLOWED_STATE_KEYS.some((pattern) => pattern.test(key)) ? key : null;
}

function assertValueSize(value) {
  let encoded = '';
  try {
    encoded = JSON.stringify(value);
  } catch {
    const error = new Error('State value must be valid JSON');
    error.status = 400;
    throw error;
  }
  if (encoded.length > 750_000) {
    const error = new Error('State value is too large');
    error.status = 413;
    throw error;
  }
}

export async function stateRead(code, selectRows = select) {
  const [stateRows, checkins] = await Promise.all([
    selectRows('athlete_data', {
      athlete_code: `eq.${code}`,
      key: 'neq.strava_tokens',
      select: 'key,value,updated_at',
      order: 'updated_at.asc',
      limit: '1000',
    }),
    // weekly_checkins is the coach-facing source of truth. Returning its
    // completion dates prevents a stale athlete_data cache flag from hiding a
    // form that was never actually submitted.
    selectRows('weekly_checkins', {
      athlete_code: `eq.${code}`,
      select: 'week_key,week_ending,submitted_at',
      order: 'submitted_at.desc',
      limit: '100',
    }),
  ]);
  const rows = (Array.isArray(stateRows) ? stateRows : [])
    .filter((row) => !String(row.key || '').startsWith('checkin_'));
  return { rows, checkins: Array.isArray(checkins) ? checkins : [] };
}

async function stateWrite(code, body) {
  const key = safeStateKey(body.key);
  if (!key) {
    const error = new Error('State key is not writable');
    error.status = 400;
    throw error;
  }
  assertValueSize(body.value);
  await upsert('athlete_data', {
    athlete_code: code,
    key,
    value: body.value,
    updated_at: new Date().toISOString(),
  }, 'athlete_code,key');
  return { key, synced_at: new Date().toISOString() };
}

async function plannedSessions(code, body) {
  const start = date(body.start);
  const end = date(body.end);
  if (!start || !end || start > end) {
    const error = new Error('A valid date range is required');
    error.status = 400;
    throw error;
  }

  // Return the athlete's programme, not only the rows whose coach-planned date
  // falls inside the visible week. Athlete reschedules are stored separately in
  // athlete_data, so a session moved across a week boundary must still reach the
  // browser before that override can be applied.
  const programme = await select('planned_sessions', {
    athlete_code: `eq.${code}`,
    select: 'id,notion_page_id,title,planned_date,session_type,status,library_id,run_details,intensity,week_label,distance_km,target_pace,warm_up,intervals,working_pace,rest,cool_down,notes',
    order: 'planned_date.asc',
    limit: '1000',
  });
  const rows = Array.isArray(programme) ? programme : [];
  const next = rows.find((row) => row.planned_date > end) || null;

  return {
    rows,
    next,
  };
}

async function workoutSplits(code) {
  const rows = await select('workout_splits', {
    archived: 'eq.false',
    or: `(athlete_code.is.null,athlete_code.eq.${code})`,
    select: 'name,athlete_code,exercises',
    order: 'name.asc',
    limit: '200',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

function libraryRevision(rows) {
  return crypto.createHash('sha1').update(JSON.stringify(rows || [])).digest('hex').slice(0, 16);
}

export async function sessionLibrary(body = {}, selectRows = select) {
  const rows = await selectRows('session_library', {
    archived: 'eq.false',
    select: '*',
    order: 'name.asc',
    limit: '1000',
  });
  const safeRows = Array.isArray(rows) ? rows : [];
  const revision = libraryRevision(safeRows);
  if (text(body.libraryRevision, 80) === revision) {
    return { rows: [], revision, notModified: true };
  }
  return { rows: safeRows, revision, notModified: false };
}

async function nutritionProgramme(code, selectRows = select) {
  const rows = await selectRows('nutrition_plans', {
    athlete_code: `eq.${code}`,
    select: '*',
    order: 'week_label.asc',
    limit: '100',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function nutritionWeek(code, body) {
  const label = weekLabel(body.weekLabel);
  if (!label) {
    const error = new Error('A valid programme week is required');
    error.status = 400;
    throw error;
  }
  const [plans, planned] = await Promise.all([
    select('nutrition_plans', {
      athlete_code: `eq.${code}`,
      week_label: `eq.${label}`,
      select: '*',
      limit: '1',
    }),
    select('planned_sessions', {
      athlete_code: `eq.${code}`,
      week_label: `eq.${label}`,
      select: 'distance_km,title,session_type,library_id,week_label',
      order: 'planned_date.asc',
      limit: '100',
    }),
  ]);
  return {
    plan: Array.isArray(plans) && plans[0] ? plans[0] : null,
    planned: Array.isArray(planned) ? planned : [],
  };
}

async function programmeData(code) {
  const [planned, nutrition] = await Promise.all([
    select('planned_sessions', {
      athlete_code: `eq.${code}`,
      select: 'week_label,distance_km,title,session_type,library_id,planned_date,status',
      order: 'planned_date.asc',
      limit: '1000',
    }),
    select('nutrition_plans', {
      athlete_code: `eq.${code}`,
      select: 'week_label,weekly_km_target',
      order: 'week_label.asc',
      limit: '100',
    }),
  ]);
  return {
    planned: Array.isArray(planned) ? planned : [],
    nutrition: Array.isArray(nutrition) ? nutrition : [],
  };
}

async function sessionLogsRead(code) {
  const rows = await select('session_logs', {
    athlete_code: `eq.${code}`,
    select: 'session_key,logged_at',
    order: 'logged_at.desc',
    limit: '1000',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

async function sessionLogWrite(code, body) {
  const sessionKey = text(body.sessionKey, 180);
  if (!sessionKey) {
    const error = new Error('sessionKey is required');
    error.status = 400;
    throw error;
  }
  await upsert('session_logs', {
    athlete_code: code,
    session_key: sessionKey,
    logged_at: new Date().toISOString(),
  }, 'athlete_code,session_key');
  return { session_key: sessionKey };
}

async function rejectStravaMatch(code, body) {
  const sessionKey = text(body.sessionKey, 180);
  const clientWriteId = text(body.clientWriteId, 120);
  if (!sessionKey || !clientWriteId || !clientWriteId.startsWith('strava_')) {
    const error = new Error('A valid Strava match is required');
    error.status = 400;
    throw error;
  }
  await Promise.all([
    remove('session_logs', { athlete_code: `eq.${code}`, session_key: `eq.${sessionKey}` }),
    remove('training_session_logs', { athlete_code: `eq.${code}`, client_write_id: `eq.${clientWriteId}` }),
  ]);
  return { session_key: sessionKey, client_write_id: clientWriteId };
}

async function bodyLogs(code) {
  const rows = await select('daily_body_logs', {
    athlete_code: `eq.${code}`,
    select: 'log_date,weight,sleep,energy,stress,soreness,notes,raw_payload,submitted_at',
    order: 'log_date.desc',
    limit: '400',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

export async function bookingRead(code, selectRows = select) {
  const rows = await selectRows('athlete_data', {
    athlete_code: `eq.${code}`,
    key: 'like.call_booked_*',
    select: 'key,value,updated_at',
    order: 'key.asc',
    limit: '100',
  });
  return { rows: Array.isArray(rows) ? rows : [] };
}

export async function bookingSync(code, syncBookings = syncBookingsForAthlete, readBookings = bookingRead) {
  const sync = await syncBookings(code);
  const current = await readBookings(code);
  return { ...current, synced: sync.updated || [] };
}

// Full read snapshot for the primary portal screen. Each section settles
// independently: a library or nutrition problem must not hide an otherwise
// valid training plan, and the client can retry only the missing legacy read.
export async function trainingRead(code, body = {}, readers = {}) {
  const readPlanned = readers.plannedSessions || plannedSessions;
  const readSplits = readers.workoutSplits || workoutSplits;
  const readLibrary = readers.sessionLibrary || sessionLibrary;
  const includeLibrary = body.includeLibrary === true;
  const names = ['planned', 'splits'];
  const tasks = [readPlanned(code, body), readSplits(code)];
  if (includeLibrary) {
    names.push('library');
    tasks.push(readLibrary({ libraryRevision: body.libraryRevision || '' }));
  }
  const settled = await Promise.allSettled(tasks);
  const result = { planned: null, splits: null, library: null, errors: [] };
  settled.forEach((entry, index) => {
    const name = names[index];
    if (entry.status === 'fulfilled') result[name] = entry.value;
    else result.errors.push(name);
  });
  return result;
}

// Combine the read-only hydration calls that previously blocked portal entry
// behind three separate authenticated requests. Keep each result in its
// original response shape so the browser can run the existing hydration logic
// unchanged. Reader injection makes the orchestration independently testable
// without touching Supabase or weakening the request authentication boundary.
export async function bootstrapRead(code, readers = {}) {
  const readState = readers.stateRead || stateRead;
  const readBodyLogs = readers.bodyLogs || bodyLogs;
  const readSessionLogs = readers.sessionLogsRead || sessionLogsRead;
  const [state, bodyLogRows, sessionLogs] = await Promise.all([
    readState(code),
    readBodyLogs(code),
    readSessionLogs(code),
  ]);
  return { state, bodyLogs: bodyLogRows, sessionLogs };
}

async function dispatch(action, code, body) {
  if (action === 'bootstrap') return bootstrapRead(code);
  if (action === 'training-read') return trainingRead(code, body);
  if (action === 'booking-read') return bookingRead(code);
  if (action === 'booking-sync') return bookingSync(code);
  if (action === 'state-read') return stateRead(code);
  if (action === 'state-write') return stateWrite(code, body);
  if (action === 'planned-sessions') return plannedSessions(code, body);
  if (action === 'workout-splits') return workoutSplits(code);
  if (action === 'session-library') return sessionLibrary(body);
  if (action === 'nutrition-week') return nutritionWeek(code, body);
  if (action === 'programme-data') return programmeData(code);
  if (action === 'session-logs-read') return sessionLogsRead(code);
  if (action === 'session-log-write') return sessionLogWrite(code, body);
  if (action === 'strava-match-reject') return rejectStravaMatch(code, body);
  if (action === 'body-logs') return bodyLogs(code);

  const error = new Error('Unknown portal action');
  error.status = 400;
  throw error;
}

export default async function handler(req, res) {
  if (String(req.query?.mode || '') !== 'portal') {
    return send(res, 410, {
      ok: false,
      error: 'This legacy write endpoint has been retired. Update the client to /api/portal-data.',
    });
  }
  if (!allowPortalRequest(req, res, 'POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });

  try {
    const identity = await getRequestAthlete(req);
    if (!identity) return send(res, 401, { ok: false, error: 'invalid_session' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = text(body.action, 60);
    const data = await dispatch(action, String(identity.athlete.code).toUpperCase(), body);
    return send(res, 200, { ok: true, ...data });
  } catch (error) {
    console.error('[portal-data]', error && error.message);
    const safe = safeError(error);
    return send(res, safe.status, { ok: false, error: safe.message });
  }
}
