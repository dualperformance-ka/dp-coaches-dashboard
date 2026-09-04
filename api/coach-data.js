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
  activityUploads: 'athlete_activity_uploads',
};

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const TRIAGE_TIMEZONE = 'Australia/Adelaide';
const PAIN_WINDOW_DAYS = 7;
const QUIET_AFTER_DAYS = 5;

// Compliance drift (triage row 4). The week is Monday-anchored in
// TRIAGE_TIMEZONE, matching the Monday week starts already used by
// api/strava.js. Half of seven days is 3.5, so the row is only eligible from
// day 4 (Thursday) onward — a 0-of-4 Tuesday is not yet information.
const COMPLIANCE_MIN_RATIO = 0.6;
const COMPLIANCE_MIN_DAY_INDEX = 4;

// planned_sessions.status is free text: nothing in this repo constrains it, and
// the table itself belongs to the athlete portal. Only an explicit completion
// counts here. Note that the unrelated regex in nextPlannedContext deliberately
// also matches skipped/missed because it is looking for the next *upcoming*
// session; reusing it to count completions would be wrong.
const COMPLIANCE_DONE_STATUS = /^(done|complete|completed)$/i;

const ELAPSED_DAY_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

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

  // ex_picks is the athlete's current exercise substitution map (programmed →
  // performed). It is the fallback that lets the dashboard resolve a swap back
  // to the slot it filled while training_session_logs.programmed_exercise is
  // still arriving null from older portal builds.
  const keys = 'programme_weeks,start_date_override,programme_restart,call_notes,ack_alert,ticked,logs,ex_picks';
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

export function sessionWasStravaConfirmed(row) {
  const payload = row?.raw_payload;
  const sourceId = payload && typeof payload === 'object'
    ? (payload.stravaActivityId ?? payload.strava_activity_id)
    : null;
  const log = String(row?.exercise_log || '');
  return sourceId !== null && sourceId !== undefined && String(sourceId).trim() !== '' ||
    /^\s*matched from strava\b/i.test(log);
}

export function submittedStravaSummary(row) {
  if (!sessionWasStravaConfirmed(row)) return null;

  const log = String(row?.exercise_log || '');
  const payload = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
  const fields = {};
  log.split('|').slice(1).forEach(part => {
    const value = String(part || '').trim();
    const separator = value.indexOf(':');
    if (separator > 0) {
      fields[value.slice(0, separator).trim().toLowerCase()] = value.slice(separator + 1).trim();
    } else if (value) {
      fields[value.toLowerCase()] = true;
    }
  });

  return {
    type: row.session_category || 'Run',
    name: row.session_name || 'Strava activity',
    distance: row.distance_km != null ? `${row.distance_km}km` : (fields.distance || ''),
    movingTime: row.duration_min != null ? `${row.duration_min}min` : (fields['moving time'] || ''),
    pace: row.pace || fields.pace || '',
    rpe: row.rpe != null ? `${row.rpe}/10` : (fields.rpe || ''),
    feel: row.feel != null ? String(row.feel) : '',
    painFlagged: payload.painFlag === true || fields['pain flagged'] === true,
    notes: row.notes || '',
    submittedAt: row.submitted_at || '',
  };
}

export function mapSession(row) {
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
    // Swap tracking. Athletes can substitute any exercise for a same-muscle
    // alternative in the portal; sets are logged under what they actually did,
    // so without the programmed slot a swapped session reads as though it was
    // written that way. Rows predating this are null and simply render as normal.
    'Exercise Name': row.exercise_name || '',
    'Programmed Exercise': row.programmed_exercise || '',
    'Muscle Group': row.muscle_group || '',
    'Is Swap': row.is_swap === true,
    'Rep Mode': row.rep_mode || '',
    // Safe coach-facing provenance only. Raw Strava payloads, activity ids,
    // tokens, routes and activity detail remain server-side/athlete-only.
    _stravaConfirmed: sessionWasStravaConfirmed(row),
    _stravaSummary: submittedStravaSummary(row),
    _clientWriteId: row.client_write_id,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

export function mapActivityUpload(row) {
  const summary = row?.summary && typeof row.summary === 'object' && !Array.isArray(row.summary)
    ? row.summary : {};
  return {
    AthleteID: row.athlete_code || '',
    AthleteName: row.athlete_name || '',
    Date: row.activity_date || '',
    'date:Date:start': row.activity_date || '',
    activityName: row.activity_name || 'Uploaded activity',
    sportType: row.sport_type || 'Activity',
    startTime: row.start_time || '',
    deviceName: row.device_name || '',
    sourceFormat: row.source_format || '',
    summary,
    laps: Array.isArray(row.laps) ? row.laps.slice(0, 500) : [],
    splits: Array.isArray(row.splits) ? row.splits.slice(0, 500) : [],
    // Left empty on the bulk load — see the select above. The client fetches an
    // individual activity's streams when the coach opens it.
    streams: Array.isArray(row.streams) ? row.streams.slice(0, 2400) : [],
    hasStreams: row.streams === undefined ? undefined : Array.isArray(row.streams) && row.streams.length > 0,
    warnings: Array.isArray(row.parse_warnings) ? row.parse_warnings.slice(0, 20) : [],
    notes: row.athlete_notes || '',
    coachAccessGrantedAt: row.coach_access_granted_at || '',
    submittedAt: row.submitted_at || '',
    _source: 'athlete_activity_upload',
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

function mondayOnOrBefore(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const weekday = date.getUTCDay();
  return shiftDate(dateText, -(weekday === 0 ? 6 : weekday - 1));
}

// Distinct completed sessions, keyed on (date, name). Strength logs write one
// row per exercise — see reconSessionShape — so counting raw rows would turn a
// single five-exercise session into five completions and mask real drift.
function loggedSessionKeysByDate(trainingRows, athleteCode, weekStart, today) {
  const byDate = new Map();
  for (const row of trainingRows || []) {
    if (normaliseCode(row.athlete_code) !== athleteCode) continue;
    const date = String(row.session_date || '');
    if (!date || date < weekStart || date > today) continue;
    const keys = byDate.get(date) || new Set();
    keys.add(normaliseText(row.session_name || row.session_category || ''));
    byDate.set(date, keys);
  }
  return byDate;
}

// Hybrid completion: an explicit done status counts, otherwise a distinct log on
// that date counts. Logged sessions are consumed per date so one log can never
// satisfy two prescriptions. Both halves fail toward "completed", so the queue
// under-reports drift rather than crying wolf — the right bias for a screen
// whose credibility depends on every row being real.
function complianceSignal({ plannedRows, trainingRows, athleteCode, weekStart, today }) {
  const planned = (plannedRows || []).filter(row =>
    normaliseCode(row.athlete_code) === athleteCode &&
    row.planned_date &&
    String(row.planned_date) >= weekStart &&
    String(row.planned_date) <= today
  );
  // No prescription is a programming gap, not athlete drift. Flagging it would
  // put the whole roster in the queue and divide by zero doing it.
  if (!planned.length) return null;

  const loggedByDate = loggedSessionKeysByDate(trainingRows, athleteCode, weekStart, today);
  const plannedByDate = new Map();
  for (const row of planned) {
    const date = String(row.planned_date);
    plannedByDate.set(date, (plannedByDate.get(date) || []).concat(row));
  }

  let completed = 0;
  for (const [date, rows] of plannedByDate) {
    const explicit = rows.filter(row => COMPLIANCE_DONE_STATUS.test(String(row.status || '').trim())).length;
    const remaining = rows.length - explicit;
    const loggedHere = loggedByDate.get(date)?.size || 0;
    completed += explicit + Math.min(remaining, Math.max(0, loggedHere - explicit));
  }

  const ratio = completed / planned.length;
  if (ratio >= COMPLIANCE_MIN_RATIO) return null;
  return { planned: planned.length, completed, ratio };
}

function complianceSignalCopy(compliance, dayIndex) {
  const elapsed = ELAPSED_DAY_WORDS[dayIndex] || String(dayIndex);
  return `Completed ${compliance.completed} of ${compliance.planned} sessions planned so far this week, with ${elapsed} days elapsed.`;
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
  const weekStart = mondayOnOrBefore(today);
  const dayIndex = dayDistance(weekStart, today) + 1;
  const weekHalfElapsed = dayIndex >= COMPLIANCE_MIN_DAY_INDEX;
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

    // Compliance drift is only interesting for an athlete who is logging and
    // still isn't completing the work. Someone gone quiet has 0% compliance by
    // definition, so emitting both would list the same person twice and make
    // counts.flagged lie.
    const compliance = (!painSignal && !goneQuiet && weekHalfElapsed)
      ? complianceSignal({ plannedRows, trainingRows, athleteCode: code, weekStart, today })
      : null;

    if (!painSignal && !goneQuiet && !compliance) continue;

    const painScore = painSignal ? numberOrNull(painSignal.pain) : null;
    const completed = painSignal
      ? latestCompletedContext(trainingRows, code, String(painSignal.log_date))
      : null;
    const planned = painSignal && !completed
      ? nextPlannedContext(plannedRows, code, String(painSignal.log_date))
      : null;
    const coachAlert = painSignal?.coach_alert === true;

    // Priority bands, highest first: pain 10000, load divergence 7000 (row 2,
    // not built), gone quiet 5000, compliance drift 3000, pace mismatch 1000
    // (row 5, not built). Pain and gone-quiet keep their original values so the
    // shipped rows and their tests do not move. The compliance shortfall term is
    // capped by the band width, so a drift row can never outrank a quiet one.
    let priority;
    if (painSignal) priority = 10000 + (coachAlert ? 1000 : 0) + (painScore || 0) * 10;
    else if (goneQuiet) priority = 5000;
    else priority = 3000 + Math.round((COMPLIANCE_MIN_RATIO - compliance.ratio) * 1000);

    let flag = 'compliance_drift';
    if (painSignal) flag = 'pain';
    else if (goneQuiet) flag = 'gone_quiet';

    let severity = 'medium';
    if (painSignal) severity = 'critical';
    else if (goneQuiet) severity = 'high';

    let signal;
    if (painSignal) signal = painSignalCopy(painSignal, completed, planned, today, goneQuiet ? quietDays : false);
    else if (goneQuiet) signal = `No completed session and no body log for at least ${QUIET_AFTER_DAYS} days.`;
    else signal = complianceSignalCopy(compliance, dayIndex);

    queue.push({
      athleteCode: code,
      athleteName: athlete.name || code,
      flag,
      severity,
      priority,
      signal,
      action: compliance
        ? { type: 'review', label: 'Review', athleteCode: code }
        : {
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
        compliance: compliance ? {
          weekStart,
          dayIndex,
          planned: compliance.planned,
          completed: compliance.completed,
          ratio: Math.round(compliance.ratio * 100) / 100,
          threshold: COMPLIANCE_MIN_RATIO,
          sources: ['planned_sessions', 'training_session_logs'],
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
    thresholds: {
      pain: 5,
      painWindowDays: PAIN_WINDOW_DAYS,
      quietDays: QUIET_AFTER_DAYS,
      complianceRatio: COMPLIANCE_MIN_RATIO,
      complianceFromDayIndex: COMPLIANCE_MIN_DAY_INDEX,
    },
    week: { start: weekStart, dayIndex, halfElapsed: weekHalfElapsed },
    counts: {
      active: active.length,
      flagged: queue.length,
      critical: queue.filter(row => row.severity === 'critical').length,
      high: queue.filter(row => row.severity === 'high').length,
      medium: queue.filter(row => row.severity === 'medium').length,
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
  // Compliance drift needs the whole current week, so the planned-session window
  // reaches back to Monday instead of starting at today. The training-log window
  // (contextStart, 9 days back) already covers Monday, so it is unchanged.
  const planStart = mondayOnOrBefore(today);
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
      planned_date: `gte.${planStart}`,
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

    const activityCutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const [body, nutrition, sessions, weeklyRaw, goals, nutritionPlans, athleteSettings, sessionLibrary, workoutSplits, applicationDecisions, plannedRows, athletes, activityUploads] = await Promise.all([
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
      selectRows(TABLES.activityUploads, {
        // `streams` is up to 2400 sample objects per activity — 200-290KB each.
        // Selecting it for up to 500 activities on every dashboard load could
        // exceed Vercel's 4.5MB response cap, and the client then rendered the
        // whole squad as having logged nothing. The client only needs streams
        // when a coach expands one activity, so it is fetched on demand.
        select: 'id,athlete_code,athlete_name,activity_name,sport_type,activity_date,start_time,device_name,source_format,summary,laps,splits,parse_warnings,athlete_notes,coach_access_granted_at,submitted_at',
        activity_date: `gte.${activityCutoff}`,
        order: 'activity_date.desc,start_time.desc',
        limit: 500,
      }).catch(error => {
        console.warn('[coach-data] athlete activity uploads unavailable:', error.message);
        return [];
      }),
    ]);
    const sessionState = athleteSettings.filter(
      row => row.key === 'ticked' || row.key === 'logs' || row.key === 'ex_picks'
    );
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
        activityUploads: activityUploads.length,
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
      activityUploads: activityUploads.map(mapActivityUpload),
    });
  } catch (error) {
    console.error('[coach-data]', error);

    return res.status(502).json({
      ok: false,
      source: 'portal_supabase',
      generatedAt: new Date().toISOString(),
      error: error.message,
      counts: { body: 0, nutrition: 0, sessions: 0, weekly: 0, goals: 0, planning: 0, nutritionPlans: 0, athleteSettings: 0, sessionLibrary: 0, workoutSplits: 0, applicationDecisions: 0, activityUploads: 0 },
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
      activityUploads: [],
    });
  }
}
