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

function allowedFields(input = {}) {
  const out = {};
  if ('name' in input) out.name = String(input.name || '').trim();
  if ('coach' in input) out.coach = String(input.coach || '').trim() || null;
  if ('start_date' in input) out.start_date = input.start_date ? String(input.start_date).slice(0, 10) : null;
  if ('race_target' in input) out.race_target = String(input.race_target || '').trim() || null;
  if ('active' in input) out.active = input.active === false ? false : Boolean(input.active);
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
  const code = nextAvailableCode(payload.name, roster.map(row => row.code));
  const now = new Date().toISOString();

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
      updated_at: now,
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
  clean.updated_at = new Date().toISOString();

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

async function archiveAthlete(code) {
  const rows = await sb(`athletes?code=eq.${encodeURIComponent(normaliseCode(code))}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      active: false,
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
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

    requireAdmin(req);

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
    const status = error.status || 500;
    return res.status(status).json({ ok: false, error: error.message || 'Request failed' });
  }
}
