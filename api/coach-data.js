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
const TRIAGE_TIMEZONE = 'Australia/Adelaide';
const PAIN_WINDOW_DAYS = 7;
const QUIET_AFTER_DAYS = 5;

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

async function selectRows(table, params = {}) {
  const baseUrl = cleanBaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  }

  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(name, String(value));
    }
  }

  const response = await fetch(`${baseUrl}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  const body = await response.text();
  let data;
  try { data = body ? JSON.parse(body) : []; }
  catch { throw new Error(`Invalid Supabase response for ${table}`); }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase returned ${response.status} for ${table}`);
  }
  return Array.isArray(data) ? data : [];
}

async function selectAthleteSettings() {
  const baseUrl = cleanBaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!baseUrl || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  }

  const keys = 'programme_weeks,start_date_override,programme_restart,call_notes,ack_alert,ticked,logs';
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

function isoDateInTimeZone(value, timeZone = TRIAGE_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('A valid triage timestamp is required');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDate(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDistance(fromDate, toDate) {
  return Math.round(
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000
  );
}

function whenCopy(dateText, today) {
  const days = dayDistance(dateText, today);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days > 1) return `${days} days ago`;
  if (days === -1) return 'tomorrow';
  return `in ${Math.abs(days)} days`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function painCandidateSort(left, right) {
  const alertDelta = Number(Boolean(right.coach_alert)) - Number(Boolean(left.coach_alert));
  if (alertDelta) return alertDelta;
  const painDelta = Number(right.pain || 0) - Number(left.pain || 0);
  if (painDelta) return painDelta;
  return String(right.submitted_at || right.log_date || '').localeCompare(
    String(left.submitted_at || left.log_date || '')
  );
}

function latestCompletedContext(rows, athleteCode, signalDate) {
  return (rows || [])
    .filter(row => normaliseCode(row.athlete_code) === athleteCode)
    .filter(row => row.session_date && row.session_date <= signalDate)
    .filter(row => dayDistance(row.session_date, signalDate) >= 0 && dayDistance(row.session_date, signalDate) <= 2)
    .sort((a, b) => String(b.session_date).localeCompare(String(a.session_date)))[0] || null;
}

function nextPlannedContext(rows, athleteCode, signalDate) {
  return (rows || [])
    .filter(row => normaliseCode(row.athlete_code) === athleteCode)
    .filter(row => row.planned_date && row.planned_date >= signalDate)
    .filter(row => !/^(done|completed?|complete|skipped|missed)$/i.test(String(row.status || '').trim()))
    .sort((a, b) => String(a.planned_date).localeCompare(String(b.planned_date)))[0] || null;
}

function painSignalCopy(signal, completed, planned, today, quietDays) {
  const pain = numberOrNull(signal.pain);
  const hasPain = pain !== null;
  const timing = whenCopy(String(signal.log_date), today);
  let sentence;

  if (signal.coach_alert && hasPain) sentence = `Coach alert with pain ${pain}/10 reported ${timing}`;
  else if (signal.coach_alert) sentence = `Coach alert raised ${timing}`;
  else sentence = `Pain ${pain}/10 reported ${timing}`;

  if (completed) {
    const session = completed.session_name || completed.session_category || 'a completed session';
    sentence += ` after ${session}`;
  } else if (planned) {
    const session = planned.title || planned.session_type || 'a planned session';
    sentence += ` with ${session} prescribed ${whenCopy(String(planned.planned_date), today)}`;
  }

  if (quietDays !== false) {
    sentence += quietDays === null
      ? '; there is also no body or completed-session activity on record'
      : `; there has also been no body or completed-session activity for at least ${quietDays} days`;
  }
  return `${sentence}.`;
}

export function buildTriageQueue({
  athletes = [],
  bodyRows = [],
  sessionRows = [],
  trainingRows = [],
  plannedRows = [],
  now = new Date(),
  timeZone = TRIAGE_TIMEZONE,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = isoDateInTimeZone(nowDate, timeZone);
  const painStart = shiftDate(today, -(PAIN_WINDOW_DAYS - 1));
  const quietBodyCutoff = shiftDate(today, -QUIET_AFTER_DAYS);
  const quietSessionCutoff = nowDate.getTime() - QUIET_AFTER_DAYS * 86400000;

  const active = (athletes || [])
    .filter(row => row && row.active === true && row.archived_at == null)
    .map(row => ({ ...row, code: normaliseCode(row.code) }))
    .filter(row => row.code);
  const activeCodes = new Set(active.map(row => row.code));
  const body = (bodyRows || []).filter(row => activeCodes.has(normaliseCode(row.athlete_code)));
  const sessions = (sessionRows || []).filter(row => activeCodes.has(normaliseCode(row.athlete_code)));
  const bodyRecentlyActive = new Set(
    body
      .filter(row => String(row.log_date || '') > quietBodyCutoff)
      .map(row => normaliseCode(row.athlete_code))
  );
  const sessionRecentlyActive = new Set(
    sessions
      .filter(row => Date.parse(row.logged_at || '') > quietSessionCutoff)
      .map(row => normaliseCode(row.athlete_code))
  );

  const painByAthlete = new Map();
  for (const row of body) {
    const code = normaliseCode(row.athlete_code);
    const pain = numberOrNull(row.pain);
    const qualifies = row.coach_alert === true || (pain !== null && pain >= 5);
    if (!qualifies || String(row.log_date || '') < painStart || String(row.log_date || '') > today) continue;
    const candidates = painByAthlete.get(code) || [];
    candidates.push(row);
    painByAthlete.set(code, candidates);
  }

  const queue = [];
  for (const athlete of active) {
    const code = athlete.code;
    const goneQuiet = !bodyRecentlyActive.has(code) && !sessionRecentlyActive.has(code);
    const quietDays = goneQuiet ? QUIET_AFTER_DAYS : false;
    const painSignal = (painByAthlete.get(code) || []).sort(painCandidateSort)[0] || null;
    if (!painSignal && !goneQuiet) continue;

    const painScore = painSignal ? numberOrNull(painSignal.pain) : null;
    const completed = painSignal
      ? latestCompletedContext(trainingRows, code, String(painSignal.log_date))
      : null;
    const planned = painSignal && !completed
      ? nextPlannedContext(plannedRows, code, String(painSignal.log_date))
      : null;
    const coachAlert = painSignal?.coach_alert === true;
    const priority = painSignal
      ? 10000 + (coachAlert ? 1000 : 0) + (painScore || 0) * 10
      : 5000;

    queue.push({
      athleteCode: code,
      athleteName: athlete.name || code,
      flag: painSignal ? 'pain' : 'gone_quiet',
      severity: painSignal ? 'critical' : 'high',
      priority,
      signal: painSignal
        ? painSignalCopy(painSignal, completed, planned, today, goneQuiet ? quietDays : false)
        : `No completed session and no body log for at least ${QUIET_AFTER_DAYS} days.`,
      action: {
        type: 'message',
        label: painSignal ? 'Message athlete' : 'Check in',
        athleteCode: code,
      },
      evidence: {
        pain: painSignal ? {
          date: painSignal.log_date,
          score: painScore,
          coachAlert,
        } : null,
        trainingContext: completed ? {
          source: 'training_session_logs',
          date: completed.session_date,
          label: completed.session_name || completed.session_category || null,
        } : planned ? {
          source: 'planned_sessions',
          date: planned.planned_date,
          label: planned.title || planned.session_type || null,
        } : null,
        goneQuiet: goneQuiet ? {
          days: quietDays,
          atLeast: true,
          noDailyBodyLogs: true,
          noSessionLogs: true,
        } : null,
      },
    });
  }

  queue.sort((left, right) =>
    right.priority - left.priority ||
    String(right.evidence.pain?.date || '').localeCompare(String(left.evidence.pain?.date || '')) ||
    left.athleteName.localeCompare(right.athleteName)
  );

  return {
    ok: true,
    source: 'portal_supabase',
    generatedAt: nowDate.toISOString(),
    timeZone,
    thresholds: { pain: 5, painWindowDays: PAIN_WINDOW_DAYS, quietDays: QUIET_AFTER_DAYS },
    counts: {
      active: active.length,
      flagged: queue.length,
      critical: queue.filter(row => row.severity === 'critical').length,
      high: queue.filter(row => row.severity === 'high').length,
      clear: Math.max(0, active.length - queue.length),
    },
    queue,
  };
}

function isMissingTriageColumn(error) {
  const message = String(error?.message || error || '');
  return /pain|coach_alert/i.test(message) && /column|schema cache|does not exist|could not find/i.test(message);
}

async function selectTriageBodyRows(painStart) {
  const query = {
    log_date: `gte.${painStart}`,
    order: 'log_date.desc,submitted_at.desc',
  };
  try {
    return await selectRows('daily_body_logs', {
      ...query,
      select: 'athlete_code,log_date,pain,coach_alert,submitted_at',
    });
  } catch (error) {
    if (!isMissingTriageColumn(error)) throw error;
    console.warn('[coach-data:triage] pain columns unavailable; continuing with gone-quiet only');
    return selectRows('daily_body_logs', {
      ...query,
      select: 'athlete_code,log_date,submitted_at',
    });
  }
}

async function loadTriage() {
  const now = new Date();
  const today = isoDateInTimeZone(now);
  const painStart = shiftDate(today, -(PAIN_WINDOW_DAYS - 1));
  const contextStart = shiftDate(painStart, -2);
  const planEnd = shiftDate(today, 7);
  const quietSessionCutoff = new Date(now.getTime() - QUIET_AFTER_DAYS * 86400000).toISOString();

  const [athletes, bodyRows, sessionRows, trainingRows, plannedRows] = await Promise.all([
    selectRows('athletes', {
      select: 'code,name,active,archived_at',
      active: 'eq.true',
      archived_at: 'is.null',
      order: 'name.asc',
    }),
    selectTriageBodyRows(painStart),
    selectRows('session_logs', {
      select: 'athlete_code,logged_at',
      logged_at: `gt.${quietSessionCutoff}`,
    }),
    selectRows('training_session_logs', {
      select: 'athlete_code,session_date,session_name,session_category',
      session_date: `gte.${contextStart}`,
      order: 'session_date.desc',
    }),
    selectRows('planned_sessions', {
      select: 'athlete_code,planned_date,title,session_type,status',
      planned_date: `gte.${today}`,
      and: `(planned_date.lte.${planEnd})`,
      order: 'planned_date.asc',
    }).catch(() => []),
  ]);

  return buildTriageQueue({ athletes, bodyRows, sessionRows, trainingRows, plannedRows, now });
}

export default async function handler(req, res) {
  setCoachCors(req, res, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try { requireCoach(req); } catch (error) { return coachError(res, error); }

  try {
    const mode = String(req.query?.mode || '').trim().toLowerCase();
    if (mode === 'triage') {
      return res.status(200).json(await loadTriage());
    }
    if (mode && mode !== 'full') {
      return res.status(400).json({ ok: false, error: `Unknown coach-data mode: ${mode}` });
    }

    const [body, nutrition, sessions, weeklyRaw, goals, nutritionPlans, athleteSettings, sessionLibrary, workoutSplits, applicationDecisions, plannedRows, athletes] = await Promise.all([
      selectAll(TABLES.body, 'log_date'),
      selectAll(TABLES.nutrition, 'log_date'),
      selectAll(TABLES.sessions, 'session_date'),
      selectAll(TABLES.weekly, 'week_ending'),
      selectAll(TABLES.goals, 'updated_at'),
      selectAll(TABLES.plans, 'athlete_code'),
      selectAthleteSettings(),
      selectAll('session_library', 'name').catch(() => []),
      selectAll('workout_splits', 'name').catch(() => []),
      selectAll('application_decisions', 'decided_at').catch(() => []),
      selectAll('planned_sessions', 'planned_date').catch(() => []),
      selectAll('athletes').catch(() => []),
    ]);
    const sessionState = athleteSettings.filter(row => row.key === 'ticked' || row.key === 'logs');
    const logsRows = sessionState.filter(row => row.key === 'logs');

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
        sessionLibrary: sessionLibrary.length,
        workoutSplits: workoutSplits.length,
        applicationDecisions: applicationDecisions.length,
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
      sessionState,
      sessionLibrary: sessionLibrary.filter(row => row.archived !== true),
      workoutSplits: workoutSplits.filter(row => row.archived !== true),
      applicationDecisions,
    });
  } catch (error) {
    console.error('[coach-data]', error);

    return res.status(502).json({
      ok: false,
      source: 'portal_supabase',
      generatedAt: new Date().toISOString(),
      error: error.message,
      counts: { body: 0, nutrition: 0, sessions: 0, weekly: 0, goals: 0, planning: 0, nutritionPlans: 0, athleteSettings: 0, sessionLibrary: 0, workoutSplits: 0, applicationDecisions: 0 },
      body: [],
      nutrition: [],
      sessions: [],
      weekly: [],
      goals: [],
      planning: [],
      nutritionPlans: [],
      athleteSettings: [],
      sessionState: [],
      sessionLibrary: [],
      workoutSplits: [],
      applicationDecisions: [],
    });
  }
}
