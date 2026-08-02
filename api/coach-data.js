// /api/coach-data.js
// Server-side bridge from athlete portal Supabase tables to the coaches dashboard.
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the dashboard Vercel project.
import { coachError, requireCoach, setCoachCors } from '../server/coach-auth.js';

const TABLES = {
  body: 'daily_body_logs',
  nutrition: 'daily_nutrition_logs',
  sessions: 'training_session_logs',
  weekly: 'weekly_checkins',
  goals: 'athlete_goals',
  plans: 'nutrition_plans',
};

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function selectAll(table, orderColumn) {
  const baseUrl = cleanBaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!baseUrl || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  }

  const rows = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const order = orderColumn ? `&order=${encodeURIComponent(orderColumn)}.desc` : '';
    const url = `${baseUrl}/rest/v1/${table}?select=*${order}`;

    const response = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${to}`,
        Prefer: 'count=exact',
      },
    });

    const body = await response.text();
    let data;

    try {
      data = body ? JSON.parse(body) : [];
    } catch {
      throw new Error(`Invalid Supabase response for ${table}`);
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        `Supabase returned ${response.status} for ${table}`
      );
    }

    const pageRows = Array.isArray(data) ? data : [];
    rows.push(...pageRows);

    if (pageRows.length < PAGE_SIZE) break;
  }

  return rows;
}

async function selectAthleteSettings() {
  const baseUrl = cleanBaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  }

  const keys = 'programme_weeks,start_date_override,programme_restart';
  const url = `${baseUrl}/rest/v1/athlete_data?select=athlete_code,key,value&key=in.(${keys})`;
  const response = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status} for athlete settings`);
  try { return text ? JSON.parse(text) : []; } catch { throw new Error('Invalid Supabase response for athlete settings'); }
}

function mapBody(row) {
  return {
    AthleteID: row.athlete_code,
    AthleteName: row.athlete_name,
    'date:Date:start': row.log_date,
    Date: row.log_date,
    Weight: row.weight,
    'Sleep Score': row.sleep,
    Energy: row.energy,
    Stress: row.stress,
    Soreness: row.soreness,
    Notes: row.notes,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

function mapNutrition(row) {
  return {
    AthleteID: row.athlete_code,
    AthleteName: row.athlete_name,
    'date:Date:start': row.log_date,
    Date: row.log_date,
    Calories: row.calories,
    Protein: row.protein,
    Carbs: row.carbs,
    Fats: row.fat,
    Fibre: row.fibre,
    Notes: row.notes,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

function mapSession(row) {
  const code = row.athlete_code || '';

  return {
    'Athlete Code': code,
    AthleteID: code,
    AthleteName: row.athlete_name,
    Name: `${code} — ${row.session_name || ''} — ${row.session_date || ''}`,
    Session: row.session_name || '',
    'Session Category': row.session_category || '',
    'Exercise Log': row.exercise_log || '',
    Notes: row.notes || '',
    Date: row.session_date,
    'date:Date:start': row.session_date,
    _clientWriteId: row.client_write_id,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}


function normaliseCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normaliseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normaliseText(value) {
  return String(value || '').trim().toLowerCase();
}

function weeklyFingerprint(row) {
  return JSON.stringify([
    String(row.week_ending || '').slice(0, 10),
    normaliseNumber(row.run_completed),
    normaliseNumber(row.run_planned),
    normaliseNumber(row.run_km),
    normaliseNumber(row.run_feel),
    normaliseText(row.run_wins),
    normaliseText(row.run_niggles),
    normaliseNumber(row.lift_completed),
    normaliseNumber(row.lift_planned),
    normaliseNumber(row.lift_feel),
    normaliseText(row.lift_wins),
    normaliseText(row.lift_niggles),
    normaliseText(row.sleep),
    normaliseNumber(row.energy),
    normaliseNumber(row.soreness),
    normaliseNumber(row.nutrition),
    normaliseText(row.fuelling),
    normaliseText(row.social_eating),
    normaliseNumber(row.stress),
    normaliseNumber(row.motivation),
    normaliseText(row.upcoming_impact),
    normaliseText(row.testimonial),
  ]);
}

function cleanWeeklyRows(rows) {
  const byIdentityWeek = new Map();
  const fingerprintOwners = new Map();
  const conflicts = [];

  const ordered = [...rows].sort((a, b) => {
    const aTime = new Date(a.updated_at || a.submitted_at || 0).getTime();
    const bTime = new Date(b.updated_at || b.submitted_at || 0).getTime();
    return bTime - aTime;
  });

  for (const original of ordered) {
    const row = {
      ...original,
      athlete_code: normaliseCode(original.athlete_code),
      athlete_name: normaliseCode(original.athlete_code),
    };

    if (!row.athlete_code || !row.week_ending) continue;

    const identityWeek = `${row.athlete_code}|${String(row.week_ending).slice(0, 10)}`;
    if (byIdentityWeek.has(identityWeek)) continue;

    const fingerprint = weeklyFingerprint(row);
    const existingOwner = fingerprintOwners.get(fingerprint);

    if (existingOwner && existingOwner !== row.athlete_code) {
      conflicts.push({
        suppressedAthlete: row.athlete_code,
        authoritativeAthlete: existingOwner,
        weekEnding: row.week_ending,
      });
      continue;
    }

    fingerprintOwners.set(fingerprint, row.athlete_code);
    byIdentityWeek.set(identityWeek, row);
  }

  return {
    rows: [...byIdentityWeek.values()],
    conflicts,
  };
}

function mapWeekly(row) {
  return {
    Name: row.athlete_code,
    'Week Ending': row.week_ending || null,
    'Run Completed': row.run_completed,
    'Run Planned': row.run_planned,
    'Weekly Run KM': row.run_km,
    'Run Feel /10': row.run_feel,
    'Runs Wins': row.run_wins,
    'Run Niggles': row.run_niggles,
    'Lift Completed': row.lift_completed,
    'Lift Planned': row.lift_planned,
    'Lift Feel /10': row.lift_feel,
    'Lift Wins': row.lift_wins,
    'Lifts Niggles': row.lift_niggles,
    'Sleep hrs': row.sleep,
    'Energy /10': row.energy,
    'Soreness /10': row.soreness,
    'Nutrition Adherence /10': row.nutrition,
    Fuelling: row.fuelling,
    'Social Event Upcoming': row.social_eating,
    Stress: row.stress,
    Motivation: row.motivation,
    'Upcoming Impact': row.upcoming_impact,
    Testimonial: row.testimonial,
    _athleteCode: row.athlete_code,
    _weekKey: row.week_key,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

function mapGoal(row) {
  return {
    athlete_code: row.athlete_code,
    athlete_name: row.athlete_name,
    goal_race: row.goal_race,
    race_date: row.race_date,
    peak_week: row.peak_week,
    start_weight: row.start_weight,
    target_weight: row.target_weight,
    body_fat: row.body_fat,
    time_5k: row.time_5k,
    time_10k: row.time_10k,
    time_half: row.time_half,
    time_marathon: row.time_marathon,
    long_run_pace: row.long_run_pace,
    why: row.why,
    milestone_w4: row.milestone_w4,
    milestone_w8: row.milestone_w8,
    milestone_w12: row.milestone_w12,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

// ── Reconciler ──────────────────────────────────────────────────────────────
// The athlete portal writes each session log to TWO places: the legacy
// `athlete_data` key/value blob (key='logs', drives the dashboard "done" tick)
// and the structured `training_session_logs` table (drives coach-visible detail
// + counts). When the structured write fails but the blob write succeeds, a
// session shows as "done" with no data. This rebuilds the missing sessions at
// read time, mapped to the correct athlete, so they always appear. No portal
// change and no duplicate DB writes — synthesized rows exist only in the
// response and only when the structured feed is missing that session entirely.

// Fetch just the `logs` rows from athlete_data (small table, one row/athlete).
async function selectLogsBlobs() {
  const baseUrl = cleanBaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');

  const url = `${baseUrl}/rest/v1/athlete_data?select=athlete_code,value&key=eq.logs`;
  const response = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status} for athlete_data`);
  try { return text ? JSON.parse(text) : []; } catch { throw new Error('Invalid Supabase response for athlete_data'); }
}

function strengthSetsHaveData(sets) {
  return Array.isArray(sets) && sets.some(s => s && (s.reps || s.weight || s.rpe || s.done));
}

function runPayloadHasData(v) {
  return v && typeof v === 'object'
    && !Object.values(v).some(Array.isArray)
    && (v.distance || v.duration || v.pace || v.rpe || v.notes);
}

function formatSets(sets) {
  return sets.map((s, i) => {
    const w = (s.weight ?? '') === '' ? '—' : s.weight;
    const r = (s.reps ?? '') === '' ? '—' : s.reps;
    const rpe = (s.rpe ?? '') === '' ? '' : ` @ RPE ${s.rpe}`;
    return `Set ${i + 1}: ${w}kg × ${r}reps${rpe}`;
  }).join(' | ');
}

function reconSessionShape(o) {
  const label = o.exerciseName
    ? `${o.athleteName} — ${o.exerciseName} — ${o.date}`
    : `${o.athleteName} — ${o.title} — ${o.date}`;
  return {
    'Athlete Code': o.code,
    AthleteID: o.code,
    AthleteName: o.athleteName,
    Name: label,
    Session: o.title,
    'Session Category': o.category,
    'Exercise Log': o.exerciseLog || '',
    Notes: o.notes || '',
    Date: o.date,
    'date:Date:start': o.date,
    _clientWriteId: `recon_${o.code}_${o.planId}_${normaliseText(o.exerciseName || o.title)}`.slice(0, 200),
    _source: 'portal_supabase_recon',
    _reconciled: true,
    _submittedAt: o.submittedAt,
    _updatedAt: o.submittedAt,
  };
}

// structuredRows = raw training_session_logs rows (pre-map).
function reconcileMissingSessions({ logsRows, plannedRows, athletes, structuredRows }) {
  const planById = new Map();
  for (const p of plannedRows || []) {
    planById.set(String(p.id), {
      code: normaliseCode(p.athlete_code),
      title: p.title || '',
      date: p.planned_date ? String(p.planned_date).slice(0, 10) : '',
      type: p.session_type || '',
    });
  }

  const nameByCode = new Map();
  for (const a of athletes || []) nameByCode.set(normaliseCode(a.code), a.name || '');

  // Sessions already present in the structured feed: code|date|lower(name).
  const have = new Set();
  for (const s of structuredRows || []) {
    const code = normaliseCode(s.athlete_code);
    const date = s.session_date ? String(s.session_date).slice(0, 10) : '';
    have.add(`${code}|${date}|${normaliseText(s.session_name)}`);
  }

  const rows = [];
  const recovered = [];

  for (const r of logsRows || []) {
    const code = normaliseCode(r.athlete_code);
    const blob = r.value || {};

    for (const [planId, payload] of Object.entries(blob)) {
      if (planId === '__savedAt' || !payload || typeof payload !== 'object') continue;

      const plan = planById.get(planId);
      if (!plan || !plan.date) continue;                       // can't place on a date
      if (plan.code && plan.code !== code) continue;           // guard wrong-person

      if (have.has(`${code}|${plan.date}|${normaliseText(plan.title)}`)) continue; // structured write already landed

      const athleteName = nameByCode.get(code) || code;
      const submittedAt = payload.__submittedAt || null;

      if (runPayloadHasData(payload)) {
        const bits = [];
        if (payload.distance) bits.push(`${payload.distance} km`);
        if (payload.duration) bits.push(`${payload.duration} min`);
        if (payload.pace) bits.push(`${payload.pace}/km`);
        if (payload.rpe) bits.push(`RPE ${payload.rpe}`);
        rows.push(reconSessionShape({
          code, athleteName, title: plan.title, category: 'Run', date: plan.date,
          exerciseLog: bits.join(' · '), notes: payload.notes || '', submittedAt, planId,
        }));
        recovered.push({ athlete: code, session: plan.title, date: plan.date, kind: 'run' });
        continue;
      }

      let any = false;
      for (const [exName, sets] of Object.entries(payload)) {
        if (exName.startsWith('__') || !strengthSetsHaveData(sets)) continue;
        any = true;
        rows.push(reconSessionShape({
          code, athleteName, title: plan.title, category: 'Strength', date: plan.date,
          exerciseLog: `${exName}: ${formatSets(sets)}`, notes: payload.__notes || '',
          submittedAt, planId, exerciseName: exName,
        }));
      }
      if (any) recovered.push({ athlete: code, session: plan.title, date: plan.date, kind: 'strength' });
    }
  }

  return { rows, recovered };
}

export default async function handler(req, res) {
  setCoachCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try { requireCoach(req); } catch (error) { return coachError(res, error); }

  try {
    const [body, nutrition, sessions, weeklyRaw, goals, nutritionPlans, athleteSettings, logsRows, plannedRows, athletes] = await Promise.all([
      selectAll(TABLES.body, 'log_date'),
      selectAll(TABLES.nutrition, 'log_date'),
      selectAll(TABLES.sessions, 'session_date'),
      selectAll(TABLES.weekly, 'week_ending'),
      selectAll(TABLES.goals, 'updated_at'),
      selectAll(TABLES.plans, 'athlete_code'),
      selectAthleteSettings(),
      selectLogsBlobs().catch(() => []),
      selectAll('planned_sessions', 'planned_date').catch(() => []),
      selectAll('athletes').catch(() => []),
    ]);

    const weeklyIntegrity = cleanWeeklyRows(weeklyRaw);
    const weekly = weeklyIntegrity.rows;

    // Rebuild any session that reached the "done" blob but not the structured
    // table, so blob-only logs still surface against the correct athlete.
    const reconciled = reconcileMissingSessions({
      logsRows, plannedRows, athletes, structuredRows: sessions,
    });
    const sessionsOut = sessions.map(mapSession).concat(reconciled.rows);

    return res.status(200).json({
      ok: true,
      source: 'portal_supabase',
      generatedAt: new Date().toISOString(),
      counts: {
        body: body.length,
        nutrition: nutrition.length,
        sessions: sessionsOut.length,
        sessionsStructured: sessions.length,
        sessionsReconciled: reconciled.rows.length,
        weekly: weekly.length,
        goals: goals.length,
        planning: plannedRows.length,
        nutritionPlans: nutritionPlans.length,
        athleteSettings: athleteSettings.length,
      },
      integrity: {
        weeklyConflicts: weeklyIntegrity.conflicts,
        weeklySuppressed: weeklyIntegrity.conflicts.length,
        reconciledSessions: reconciled.recovered,
      },
      body: body.map(mapBody),
      nutrition: nutrition.map(mapNutrition),
      sessions: sessionsOut,
      weekly: weekly.map(mapWeekly),
      goals: goals.map(mapGoal),
      planning: plannedRows,
      nutritionPlans,
      athleteSettings,
    });
  } catch (error) {
    console.error('[coach-data]', error);

    return res.status(502).json({
      ok: false,
      source: 'portal_supabase',
      generatedAt: new Date().toISOString(),
      error: error.message,
      counts: { body: 0, nutrition: 0, sessions: 0, weekly: 0, goals: 0, planning: 0, nutritionPlans: 0, athleteSettings: 0 },
      body: [],
      nutrition: [],
      sessions: [],
      weekly: [],
      goals: [],
      planning: [],
      nutritionPlans: [],
      athleteSettings: [],
    });
  }
}
