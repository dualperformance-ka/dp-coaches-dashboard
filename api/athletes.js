import { coachError, requireCoach, setCoachCors } from '../server/coach-auth.js';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();
const ATHLETE_PORTAL_URL = String(process.env.ATHLETE_PORTAL_URL || 'https://dp-athlete-portal.vercel.app').replace(/\/+$/, '');

const HISTORY_TABLES = [
  'daily_body_logs',
  'daily_nutrition_logs',
  'training_session_logs',
  'weekly_checkins',
  'athlete_goals',
  'athlete_data',
  'planned_sessions',
  'nutrition_plans',
];

function ensureConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  }
}

function athletePortalLink(code) {
  return `${ATHLETE_PORTAL_URL}/?code=${encodeURIComponent(String(code || '').trim().toUpperCase())}`;
}

async function sb(path, { method = 'GET', body, prefer } = {}) {
  ensureConfig();

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase returned ${response.status}`);
  }

  return data;
}

function normaliseCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function isIsoCalendarDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

export function shiftIsoDate(value, days) {
  if (!isIsoCalendarDate(value)) throw new Error('A valid effective date is required');
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

export function programmeRestartDates(effectiveDate, startWeek) {
  if (!isIsoCalendarDate(effectiveDate)) throw new Error('A valid effective date is required');
  const week = Number(startWeek);
  if (week !== 0 && week !== 1) throw new Error('Programme must restart at Week 0 or Week 1');

  const effective = new Date(`${effectiveDate}T00:00:00Z`);
  if (effective.getUTCDay() !== 1) throw new Error('Programme restarts must begin on a Monday');

  return {
    effectiveDate,
    startWeek: week,
    // Existing week maths treats the first seven days after the anchor as
    // Week 0. Move the anchor back seven days when Week 1 should start now.
    anchorDate: shiftIsoDate(effectiveDate, week === 1 ? -7 : 0),
    weekEndDate: shiftIsoDate(effectiveDate, 6),
  };
}

export function programmeWeekForDate(effectiveDate, startWeek, programmeDate) {
  const restart = programmeRestartDates(effectiveDate, startWeek);
  if (!isIsoCalendarDate(programmeDate)) throw new Error('A valid programme date is required');
  const elapsedDays = Math.floor(
    (new Date(`${programmeDate}T00:00:00Z`) - new Date(`${restart.effectiveDate}T00:00:00Z`)) /
    86400000
  );
  if (elapsedDays < 0) throw new Error('Programme date cannot be before the restart date');
  return restart.startWeek + Math.floor(elapsedDays / 7);
}

function sanitiseCustomCode(value) {
  return normaliseCode(value).replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

function toProfileRow(athlete, goal) {
  const value = (primary, fallback = null) =>
    primary !== undefined && primary !== null && String(primary).trim() !== ''
      ? primary
      : fallback;

  return {
    Code: athlete.code,
    Athlete: athlete.code,
    Name: athlete.name,
    Coach: athlete.coach || '',
    Active: athlete.active !== false,
    'Start Date': athlete.start_date || null,
    'date:Start Date:start': athlete.start_date || null,
    'Goal Race': value(goal?.goal_race, athlete.race_target || null),
    'Race Date': value(goal?.race_date),
    'Weekly KM Target': value(goal?.peak_week),
    'Body Weight (kg)': value(goal?.start_weight),
    'Target Weight': value(goal?.target_weight),
    'Body Fat %': value(goal?.body_fat),
    '5km Time': value(goal?.time_5k),
    '10km Time': value(goal?.time_10k),
    'Half Marathon Time': value(goal?.time_half),
    'Marathon Time': value(goal?.time_marathon),
    'Long Run Pace': value(goal?.long_run_pace),
    'Your Why': value(goal?.why),
    'Milestone W4': value(goal?.milestone_w4),
    'Milestone W8': value(goal?.milestone_w8),
    'Milestone W12': value(goal?.milestone_w12),
    _source: 'roster_supabase',
  };
}

async function loadRosterRows({ includeArchived = false } = {}) {
  const filters = ['select=*', 'order=name.asc'];
  if (!includeArchived) filters.push('archived_at=is.null');
  const rows = await sb(`athletes?${filters.join('&')}`);

  return (Array.isArray(rows) ? rows : []).map(row => ({
    ...row,
    code: normaliseCode(row.code),
    portalLink: athletePortalLink(row.code),
  }));
}

async function loadGoalRows() {
  const rows = await sb('athlete_goals?select=*');
  return Array.isArray(rows) ? rows : [];
}

function makeCodeBase(name) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toUpperCase();

  return (base || 'ATHLETE').slice(0, 12);
}

function nextAvailableCode(name, existingCodes) {
  const used = new Set((existingCodes || []).map(normaliseCode));
  const base = makeCodeBase(name);

  if (!used.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, Math.max(1, 12 - String(suffix).length))}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }

  throw new Error('Unable to generate a unique athlete code');
}

function requireAdmin(req) {
  if (!ADMIN_KEY) throw new Error('ADMIN_KEY is not configured');
  const supplied = String(req.headers['x-admin-key'] || '').trim();
  if (!supplied || supplied !== ADMIN_KEY) {
    const error = new Error('Admin key rejected');
    error.status = 401;
    throw error;
  }
}

const AUTH_MODES = ['code', 'both', 'email'];

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email address is not valid');
  return email;
}

function allowedFields(input = {}) {
  const out = {};
  if ('name' in input) out.name = String(input.name || '').trim();
  if ('coach' in input) out.coach = String(input.coach || '').trim() || null;
  if ('start_date' in input) out.start_date = input.start_date ? String(input.start_date).slice(0, 10) : null;
  if ('race_target' in input) out.race_target = String(input.race_target || '').trim() || null;
  if ('active' in input) out.active = input.active === false ? false : Boolean(input.active);
  // Email-auth enrolment: setting an email stamps invited_at and defaults
  // auth_mode to 'both' (email sign-in enabled, legacy code still works).
  // The auth_user_id link happens automatically on the athlete's first OTP
  // sign-in via the portal. Clearing the email un-enrols; the code and all
  // history are never touched.
  if ('email' in input) {
    const email = cleanEmail(input.email);
    out.email = email;
    out.invited_at = email ? new Date().toISOString() : null;
    if (!('auth_mode' in input)) out.auth_mode = email ? 'both' : 'code';
    if (!email) out.auth_user_id = null; // un-enrol severs the auth link too
  }
  if ('auth_mode' in input) {
    const mode = String(input.auth_mode || '').trim().toLowerCase();
    if (!AUTH_MODES.includes(mode)) throw new Error(`auth_mode must be one of: ${AUTH_MODES.join(', ')}`);
    out.auth_mode = mode;
  }
  return out;
}

async function hasHistory(code) {
  const athleteCode = normaliseCode(code);

  for (const table of HISTORY_TABLES) {
    const rows = await sb(`${table}?select=athlete_code&athlete_code=eq.${encodeURIComponent(athleteCode)}&limit=1`);
    if (Array.isArray(rows) && rows.length) return table;
  }

  return null;
}

async function addAthlete(payload) {
  const roster = await loadRosterRows({ includeArchived: true });
  const existingCodes = roster.map(row => row.code);
  const requestedCode = sanitiseCustomCode(payload.code);
  const code = requestedCode || nextAvailableCode(payload.name, existingCodes);

  if (requestedCode && requestedCode !== normaliseCode(payload.code)) {
    throw new Error('Athlete code can only use letters and numbers');
  }
  if (!code) throw new Error('Athlete code is required');
  if (existingCodes.map(normaliseCode).includes(code)) {
    throw new Error(`Athlete code ${code} is already in use`);
  }

  // Optional email at creation = enrolled for email sign-in from day one.
  const email = cleanEmail(payload.email);

  const [created] = await sb('athletes', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      code,
      name: String(payload.name || '').trim(),
      coach: String(payload.coach || '').trim() || null,
      active: true,
      start_date: payload.start_date ? String(payload.start_date).slice(0, 10) : null,
      race_target: String(payload.race_target || '').trim() || null,
      archived_at: null,
      email,
      auth_mode: email ? 'both' : 'code',
      invited_at: email ? new Date().toISOString() : null,
    },
  });

  return {
    ok: true,
    athlete: {
      ...created,
      code: normaliseCode(created.code),
      portalLink: athletePortalLink(created.code),
    },
    code,
    portalLink: athletePortalLink(code),
  };
}

async function updateAthlete(code, fields) {
  const clean = allowedFields(fields);
  if (!Object.keys(clean).length) throw new Error('No editable fields supplied');

  const rows = await sb(`athletes?code=eq.${encodeURIComponent(normaliseCode(code))}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: clean,
  });

  const updated = Array.isArray(rows) ? rows[0] : null;
  if (!updated) throw new Error(`Athlete ${code} not found`);

  return {
    ok: true,
    athlete: {
      ...updated,
      code: normaliseCode(updated.code),
      portalLink: athletePortalLink(updated.code),
    },
  };
}

export async function restartProgramme(code, effectiveDate, startWeek, request = sb) {
  const athleteCode = normaliseCode(code);
  if (!athleteCode) throw new Error('Athlete code is required');

  const dates = programmeRestartDates(effectiveDate, startWeek);
  const settings = await request(
    `athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    '&key=eq.start_date_override&select=value&limit=1'
  );
  const roster = await request(
    `athletes?code=eq.${encodeURIComponent(athleteCode)}&select=start_date&limit=1`
  );
  const previousStartDate = settings?.[0]?.value || roster?.[0]?.start_date || null;
  const restartedAt = new Date().toISOString();
  const restart = {
    effective_date: dates.effectiveDate,
    start_week: dates.startWeek,
    anchor_date: dates.anchorDate,
    previous_start_date: previousStartDate,
    restarted_at: restartedAt,
  };

  // Both rows use the existing athlete_data key/value store. The restart
  // metadata lets the UI retain the old anchor until a scheduled reset begins.
  await request('athlete_data?on_conflict=athlete_code,key', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [
      {
        athlete_code: athleteCode,
        key: 'start_date_override',
        value: dates.anchorDate,
        updated_at: restartedAt,
      },
      {
        athlete_code: athleteCode,
        key: 'programme_restart',
        value: restart,
        updated_at: restartedAt,
      },
    ],
  });

  // The athlete portal and dashboard prefer dated plan labels, so renumber all
  // already-scheduled sessions from the restart onward. Their dates and session
  // content stay unchanged; only Week 8/9/... becomes Week 1/2/... (or 0/1/...).
  const plannedSessions = await request(
    `planned_sessions?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    `&planned_date=gte.${dates.effectiveDate}&select=id,planned_date`
  );
  const sessionsByLabel = new Map();
  (plannedSessions || []).forEach(session => {
    const week = programmeWeekForDate(dates.effectiveDate, dates.startWeek, session.planned_date);
    const label = `Week ${week}`;
    if (!sessionsByLabel.has(label)) sessionsByLabel.set(label, []);
    sessionsByLabel.get(label).push(session.id);
  });
  for (const [weekLabel, ids] of sessionsByLabel) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100).map(encodeURIComponent).join(',');
      await request(`planned_sessions?id=in.(${chunk})`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: { week_label: weekLabel },
      });
    }
  }

  return {
    ok: true,
    athleteCode,
    effectiveDate: dates.effectiveDate,
    startWeek: dates.startWeek,
    anchorDate: dates.anchorDate,
    updatedSessions: Array.isArray(plannedSessions) ? plannedSessions.length : 0,
    restart,
  };
}

const PLANNED_SESSION_FIELDS = new Set([
  'athlete_code', 'title', 'session_type', 'planned_date', 'week_label', 'status',
  'library_id', 'run_details', 'intensity', 'distance_km', 'target_pace',
  'warm_up', 'intervals', 'working_pace', 'rest', 'cool_down', 'notes',
  'updated_at', 'notion_page_id',
]);

export function cleanPlannedSessionFields(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => PLANNED_SESSION_FIELDS.has(key))
  );
}

export async function insertPlannedSessions(input, request = sb) {
  const source = Array.isArray(input) ? input : [input];
  const rows = source.map(cleanPlannedSessionFields);
  if (!rows.length || rows.some(row => !row.athlete_code || !row.planned_date)) {
    throw new Error('Each planned session needs an athlete and planned date');
  }

  const created = await request('planned_sessions', {
    method: 'POST',
    prefer: 'return=representation',
    body: Array.isArray(input) ? rows : rows[0],
  });
  return { ok: true, rows: Array.isArray(created) ? created : [] };
}

export async function updatePlannedSession(matchId, fields, request = sb) {
  const id = String(matchId || '').trim();
  if (!id) throw new Error('Planned session ID is required');
  const patch = cleanPlannedSessionFields(fields);
  if (!Object.keys(patch).length) throw new Error('No planned-session fields supplied');

  const rows = await request(
    `planned_sessions?or=(notion_page_id.eq.${encodeURIComponent(id)},id.eq.${encodeURIComponent(id)})`,
    { method: 'PATCH', prefer: 'return=representation', body: patch }
  );
  if (!Array.isArray(rows) || !rows.length) throw new Error('Planned session not found');
  return { ok: true, rows };
}

export async function deletePlannedSession(matchId, request = sb) {
  const id = String(matchId || '').trim();
  if (!id) throw new Error('Planned session ID is required');
  const rows = await request(
    `planned_sessions?or=(notion_page_id.eq.${encodeURIComponent(id)},id.eq.${encodeURIComponent(id)})`,
    { method: 'DELETE', prefer: 'return=representation' }
  );
  if (!Array.isArray(rows) || !rows.length) throw new Error('Planned session not found');
  return { ok: true, rows };
}

const NUTRITION_PLAN_FIELDS = new Set([
  'athlete_code', 'week_label', 'calories', 'protein', 'carbs', 'fats', 'fibre',
  'weekly_km_target', 'notes', 'updated_at',
]);

export function cleanNutritionPlanFields(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => NUTRITION_PLAN_FIELDS.has(key))
  );
}

export async function upsertNutritionPlan(input, request = sb) {
  const row = cleanNutritionPlanFields(input);
  row.athlete_code = normaliseCode(row.athlete_code);
  row.week_label = String(row.week_label || '').trim();
  if (!row.athlete_code || !row.week_label) {
    throw new Error('Nutrition plan needs an athlete and week');
  }
  const rows = await request('nutrition_plans?on_conflict=athlete_code,week_label', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: row,
  });
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

export async function deleteNutritionPlan(code, weekLabel, request = sb) {
  const athleteCode = normaliseCode(code);
  const week = String(weekLabel || '').trim();
  if (!athleteCode || !week) throw new Error('Nutrition plan athlete and week are required');
  const rows = await request(
    `nutrition_plans?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    `&week_label=eq.${encodeURIComponent(week)}`,
    { method: 'DELETE', prefer: 'return=representation' }
  );
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

const EDITABLE_SETTING_KEYS = new Set([
  'programme_weeks', 'start_date_override', 'call_notes', 'ack_alert',
]);

export async function upsertAthleteSetting(code, key, value, request = sb) {
  const athleteCode = normaliseCode(code);
  const settingKey = String(key || '').trim();
  if (!athleteCode || !EDITABLE_SETTING_KEYS.has(settingKey)) {
    throw new Error('Unsupported athlete setting');
  }
  const rows = await request('athlete_data?on_conflict=athlete_code,key', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: {
      athlete_code: athleteCode,
      key: settingKey,
      value,
      updated_at: new Date().toISOString(),
    },
  });
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

export async function deleteAthleteSetting(code, key, request = sb) {
  const athleteCode = normaliseCode(code);
  const settingKey = String(key || '').trim();
  if (!athleteCode || !EDITABLE_SETTING_KEYS.has(settingKey)) {
    throw new Error('Unsupported athlete setting');
  }
  const rows = await request(
    `athlete_data?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    `&key=eq.${encodeURIComponent(settingKey)}`,
    { method: 'DELETE', prefer: 'return=representation' }
  );
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

const LIBRARY_CONFIG = {
  session: {
    table: 'session_library',
    fields: new Set([
      'name', 'session_type', 'intensity', 'distance', 'duration', 'target_pace',
      'rpe', 'warm_up', 'cool_down', 'goal', 'description', 'archived', 'updated_at',
    ]),
  },
  split: {
    table: 'workout_splits',
    fields: new Set(['name', 'athlete_code', 'exercises', 'archived', 'updated_at']),
  },
};

export function cleanLibraryFields(kind, input = {}) {
  const config = LIBRARY_CONFIG[String(kind || '').trim().toLowerCase()];
  if (!config) throw new Error('Unsupported library type');
  return Object.fromEntries(Object.entries(input).filter(([key]) => config.fields.has(key)));
}

export async function saveLibraryRecord(kind, id, input, request = sb) {
  const libraryKind = String(kind || '').trim().toLowerCase();
  const config = LIBRARY_CONFIG[libraryKind];
  if (!config) throw new Error('Unsupported library type');
  const fields = cleanLibraryFields(kind, input);
  if (!String(fields.name || '').trim()) throw new Error('Library record needs a name');
  if (libraryKind === 'split' && fields.athlete_code) fields.athlete_code = normaliseCode(fields.athlete_code);
  const matchId = String(id || '').trim();
  const rows = matchId
    ? await request(`${config.table}?id=eq.${encodeURIComponent(matchId)}`, {
        method: 'PATCH', prefer: 'return=representation', body: fields,
      })
    : await request(config.table, {
        method: 'POST', prefer: 'return=representation', body: fields,
      });
  if (!Array.isArray(rows) || !rows.length) throw new Error('Library record was not saved');
  return { ok: true, rows };
}

export async function archiveLibraryRecord(kind, id, request = sb) {
  const config = LIBRARY_CONFIG[String(kind || '').trim().toLowerCase()];
  const matchId = String(id || '').trim();
  if (!config || !matchId) throw new Error('Library type and record ID are required');
  const rows = await request(`${config.table}?id=eq.${encodeURIComponent(matchId)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { archived: true, updated_at: new Date().toISOString() },
  });
  if (!Array.isArray(rows) || !rows.length) throw new Error('Library record was not found');
  return { ok: true, rows };
}

export async function upsertApplicationDecision(input, request = sb) {
  const notionId = String(input?.notion_id || '').trim();
  const decision = String(input?.decision || '').trim();
  if (!notionId || !['accepted', 'rejected'].includes(decision)) {
    throw new Error('Application decision is invalid');
  }
  const row = {
    notion_id: notionId,
    decision,
    decided_by: normaliseCode(input?.decided_by || 'COACH'),
    decided_at: input?.decided_at || new Date().toISOString(),
  };
  const rows = await request('application_decisions?on_conflict=notion_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: row,
  });
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

// Change an athlete's code (portal password) atomically across every table
// that references it, via the rename_athlete_code() Postgres function.
// The function suspends the coach-change triggers during the rename so
// athletes don't get spurious "Coach update" pushes, and rolls everything
// back if anything fails.
async function recodeAthlete(oldCode, newCode) {
  const from = normaliseCode(oldCode);
  const to = sanitiseCustomCode(newCode);
  if (!from) throw new Error('Current athlete code is required');
  if (!to || to.length < 2) throw new Error('New code must be at least 2 letters/numbers');

  const result = await sb('rpc/rename_athlete_code', {
    method: 'POST',
    body: { old_code: from, new_code: to },
  });

  return {
    ok: true,
    ...(result && typeof result === 'object' ? result : {}),
    portalLink: athletePortalLink(to),
  };
}

async function archiveAthlete(code) {
  const rows = await sb(`athletes?code=eq.${encodeURIComponent(normaliseCode(code))}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      active: false,
      archived_at: new Date().toISOString(),
    },
  });

  const updated = Array.isArray(rows) ? rows[0] : null;
  if (!updated) throw new Error(`Athlete ${code} not found`);

  return {
    ok: true,
    athlete: {
      ...updated,
      code: normaliseCode(updated.code),
      portalLink: athletePortalLink(updated.code),
    },
  };
}

async function deleteAthlete(code) {
  const conflict = await hasHistory(code);
  if (conflict) {
    throw new Error(`Cannot delete ${normaliseCode(code)} because history exists in ${conflict}; remove/archive them instead`);
  }

  const rows = await sb(`athletes?code=eq.${encodeURIComponent(normaliseCode(code))}`, {
    method: 'DELETE',
    prefer: 'return=representation',
  });

  if (!Array.isArray(rows) || !rows.length) throw new Error(`Athlete ${code} not found`);
  return { ok: true, deleted: normaliseCode(code) };
}

export default async function handler(req, res) {
  setCoachCors(req, res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    requireCoach(req);
    if (req.method === 'GET') {
      const action = String(req.query.action || 'roster').trim().toLowerCase();

      if (action === 'profiles') {
        const [athletes, goals] = await Promise.all([
          loadRosterRows(),
          loadGoalRows(),
        ]);

        const goalMap = new Map(goals.map(row => [normaliseCode(row.athlete_code), row]));
        const results = athletes.map(row => toProfileRow(row, goalMap.get(row.code)));
        return res.status(200).json({ ok: true, results, total: results.length, source: 'roster_supabase' });
      }

      const athletes = await loadRosterRows();
      return res.status(200).json({ ok: true, athletes, total: athletes.length, source: 'roster_supabase' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const action = String(req.body?.action || '').trim().toLowerCase();

    if (action === 'add') {
      if (!String(req.body?.name || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Athlete name is required' });
      }
      return res.status(200).json(await addAthlete(req.body));
    }

    if (action === 'update') {
      if (!req.body?.code) return res.status(400).json({ ok: false, error: 'Athlete code is required' });
      return res.status(200).json(await updateAthlete(req.body.code, req.body.fields || {}));
    }

    if (action === 'reset_programme') {
      if (!req.body?.code) return res.status(400).json({ ok: false, error: 'Athlete code is required' });
      return res.status(200).json(await restartProgramme(
        req.body.code,
        req.body.effective_date,
        req.body.start_week
      ));
    }

    if (action === 'plan_insert') {
      return res.status(200).json(await insertPlannedSessions(req.body?.rows ?? req.body?.row));
    }

    if (action === 'plan_update') {
      return res.status(200).json(await updatePlannedSession(req.body?.id, req.body?.fields || {}));
    }

    if (action === 'plan_delete') {
      return res.status(200).json(await deletePlannedSession(req.body?.id));
    }

    if (action === 'nutrition_upsert') {
      return res.status(200).json(await upsertNutritionPlan(req.body?.row || {}));
    }

    if (action === 'nutrition_delete') {
      return res.status(200).json(await deleteNutritionPlan(req.body?.code, req.body?.week_label));
    }

    if (action === 'setting_upsert') {
      return res.status(200).json(await upsertAthleteSetting(req.body?.code, req.body?.key, req.body?.value));
    }

    if (action === 'setting_delete') {
      return res.status(200).json(await deleteAthleteSetting(req.body?.code, req.body?.key));
    }

    if (action === 'library_save') {
      return res.status(200).json(await saveLibraryRecord(
        req.body?.kind, req.body?.id, req.body?.fields || {}
      ));
    }

    if (action === 'library_archive') {
      return res.status(200).json(await archiveLibraryRecord(req.body?.kind, req.body?.id));
    }

    if (action === 'application_decision') {
      return res.status(200).json(await upsertApplicationDecision(req.body?.decision || {}));
    }

    if (action === 'recode') {
      if (!req.body?.code) return res.status(400).json({ ok: false, error: 'Athlete code is required' });
      if (!req.body?.new_code) return res.status(400).json({ ok: false, error: 'New code is required' });
      return res.status(200).json(await recodeAthlete(req.body.code, req.body.new_code));
    }

    if (action === 'archive' || action === 'remove') {
      if (!req.body?.code) return res.status(400).json({ ok: false, error: 'Athlete code is required' });
      return res.status(200).json(await archiveAthlete(req.body.code));
    }

    if (action === 'delete') {
      if (!req.body?.code) return res.status(400).json({ ok: false, error: 'Athlete code is required' });
      return res.status(200).json(await deleteAthlete(req.body.code));
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (error) {
    return coachError(res, error);
  }
}
