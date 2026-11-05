// Coach-only programming operations.
//
// Every export here assumes authorisation has ALREADY happened — api/athletes.js
// resolves the coach, checks the athlete, and only then calls in. Nothing in
// this file trusts a request body for identity or for which sessions an edit
// reaches.
//
// The central idea is lazy materialisation. A session starts life 'legacy',
// meaning the portal resolves its strength work by matching the session title
// against a shared workout_splits row. The first time a coach edits that
// session's prescription it is expanded into session_exercises rows belonging
// to that session alone, and flipped to 'structured'. Past sessions are never
// touched, and no bulk backfill ever runs.

import { randomUUID } from 'node:crypto';
// Shared with the browser builder; sets globalThis.DPRunWorkout.
import '../public/run-workout.js';
import {
  assertAthleteAllowed,
  loadSession,
  logProgrammeChange,
  resolveScope,
} from './coach-scope.js';

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const RULES = globalThis.DPRunWorkout;

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const int = (value) => {
  const parsed = num(value);
  return parsed === null ? null : Math.round(parsed);
};

const text = (value, max = 2000) => {
  const out = String(value === null || value === undefined ? '' : value).trim();
  return out ? out.slice(0, max) : null;
};

// "8-12" → {min:8,max:12}; "8" → {min:8,max:8}; "" → {min:null,max:null}
export function parseRepRange(value) {
  const raw = String(value || '').trim();
  if (!raw) return { min: null, max: null };
  const match = raw.match(/(\d+)\s*[-–—to]+\s*(\d+)/i);
  if (match) return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  const single = raw.match(/(\d+)/);
  return single ? { min: parseInt(single[1], 10), max: parseInt(single[1], 10) } : { min: null, max: null };
}

// "90s" → 90; "2 min" → 120; "180" → 180
export function parseRestSeconds(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const minutes = raw.match(/^([\d.]+)\s*m/);
  if (minutes) return Math.round(parseFloat(minutes[1]) * 60);
  const seconds = raw.match(/([\d.]+)/);
  return seconds ? Math.round(parseFloat(seconds[1])) : null;
}

// One workout_splits exercise entry → one session_exercises row.
export function splitEntryToExercise(entry, index, sessionId, splitId) {
  const reps = parseRepRange(entry.repRange || entry.reps);
  const working = int(entry.workingSets);
  const sets = int(entry.sets);
  return {
    planned_session_id: sessionId,
    exercise_name: text(entry.exercise, 200) || 'Exercise',
    position: index,
    sets: sets !== null ? sets : working,
    warmup_sets: int(entry.warmupSets) || 0,
    working_sets: working !== null ? working : sets,
    rep_min: reps.min,
    rep_max: reps.max,
    rep_mode: entry.repMode === 'left_right' || entry.repMode === 'time' ? entry.repMode : 'reps',
    rest_seconds: parseRestSeconds(entry.rest),
    // The split's free-text note is athlete-facing today — it is rendered in the
    // portal's exercise card. Migrating it to coach_notes would silently hide
    // guidance athletes currently rely on.
    athlete_notes: text(entry.notes, 1000),
    alternatives: Array.isArray(entry.alts) ? entry.alts : [],
    left_right_exercises: Array.isArray(entry.leftRightExercises) ? entry.leftRightExercises : [],
    source_split_id: splitId || null,
  };
}

async function findMatchingSplit(session, sb) {
  const code = encodeURIComponent(session.athlete_code);
  const rows = await sb(
    `workout_splits?archived=eq.false&or=(athlete_code.is.null,athlete_code.eq.${code})&select=id,name,athlete_code,exercises&limit=200`
  );
  const splits = Array.isArray(rows) ? rows : [];
  const title = String(session.title || '').toLowerCase();

  // Longest name first, so "DP S2 Lower C" wins over "Lower C". This mirrors the
  // portal's GYM_KEYS ordering exactly.
  const candidates = splits
    .filter((split) => title.includes(String(split.name || '').toLowerCase()))
    .sort((a, b) => String(b.name).length - String(a.name).length);

  // An athlete-specific split of the same name overrides the global one, again
  // matching the portal's resolution order.
  const named = candidates[0];
  if (!named) return null;
  const specific = candidates.find(
    (split) => split.name === named.name && split.athlete_code === session.athlete_code
  );
  return specific || named;
}

// Expand a legacy session into its own prescription. Idempotent: a session that
// is already structured is returned untouched.
export async function materialiseSession(sessionId, sb, coach) {
  const session = await loadSession(sessionId, sb);
  if (session.locked_at) throw httpError('That session is completed and cannot be edited', 409);

  if (session.prescription_mode === 'structured') {
    return { session, created: 0, source: null };
  }

  const split = await findMatchingSplit(session, sb);
  const entries = split && Array.isArray(split.exercises) ? split.exercises : [];

  if (entries.length) {
    const rows = entries.map((entry, index) =>
      splitEntryToExercise(entry, index, session.id, split.id)
    );
    await sb('session_exercises', { method: 'POST', body: rows, prefer: 'return=minimal' });
  }

  await sb(`planned_sessions?id=eq.${encodeURIComponent(session.id)}`, {
    method: 'PATCH',
    body: { prescription_mode: 'structured', updated_at: new Date().toISOString() },
    prefer: 'return=minimal',
  });

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'session',
    entityId: session.id,
    action: 'materialised',
    summary: split
      ? `Took "${session.title}" off the shared "${split.name}" split (${entries.length} exercises)`
      : `Started a blank prescription for "${session.title}"`,
  });

  return {
    session: { ...session, prescription_mode: 'structured' },
    created: entries.length,
    source: split ? split.name : null,
  };
}

// Coach-facing read. Unlike the portal's serialiser this DOES include
// coach_notes — that is the whole point of the coach view.
export async function readPrescription(sessionId, sb) {
  const session = await loadSession(sessionId, sb);
  const id = encodeURIComponent(session.id);

  const [exercises, steps, split, detail, receipts, moves] = await Promise.all([
    sb(`session_exercises?planned_session_id=eq.${id}&select=*&order=position.asc&limit=200`),
    sb(`run_steps?planned_session_id=eq.${id}&select=*&order=step_order.asc&limit=200`),
    session.prescription_mode === 'structured' ? Promise.resolve(null) : findMatchingSplit(session, sb),
    // The text prescription the session already carries. Shown beside the
    // structured builder for reference; never parsed into steps.
    sb(`planned_sessions?id=eq.${id}&select=run_details,distance_km,target_pace,warm_up,intervals,working_pace,rest,cool_down,notes,updated_at,notion_page_id&limit=1`)
      .catch(() => null),
    readGarminReceipts(session.id, sb),
    readAthleteReschedules(session.athlete_code, sb),
  ]);

  const legacy = Array.isArray(detail) ? detail[0] || null : null;
  const runSteps = Array.isArray(steps) ? steps : [];
  // The portal schedules Garmin on the athlete's own move when there is one
  // (athlete_data.reschedules, keyed by notion_page_id or id), exactly as
  // loadWorkoutPrescription() in garmin-workout-service.js does.
  const movedTo = athleteMove(moves, legacy && legacy.notion_page_id, session.id);

  return {
    session: legacy ? { ...session, updated_at: legacy.updated_at } : session,
    exercises: Array.isArray(exercises) ? exercises : [],
    runSteps,
    // For a legacy session, show what it currently resolves to so the coach can
    // see what they are about to take control of.
    legacySplit: split ? { id: split.id, name: split.name, exercises: split.exercises || [] } : null,
    legacyRun: legacy ? legacyRunText(legacy) : null,
    garmin: garminDeliveryStatus(receipts, session, legacy, runSteps, movedTo),
  };
}

async function readAthleteReschedules(code, sb) {
  try {
    const rows = await sb(
      `athlete_data?athlete_code=eq.${encodeURIComponent(String(code || ''))}&key=eq.reschedules&select=value&limit=1`
    );
    const value = Array.isArray(rows) && rows[0] ? rows[0].value : null;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function athleteMove(moves, notionPageId, sessionId) {
  const value = moves && moves[notionPageId || sessionId];
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

const LEGACY_RUN_FIELDS = [
  ['run_details', 'Details'], ['distance_km', 'Distance (km)'], ['target_pace', 'Target pace'],
  ['warm_up', 'Warm up'], ['intervals', 'Intervals / sets'], ['working_pace', 'Working pace'],
  ['rest', 'Rest between sets'], ['cool_down', 'Cool down'],
];

export function legacyRunText(row) {
  return LEGACY_RUN_FIELDS
    .filter(([key]) => row[key] !== null && row[key] !== undefined && String(row[key]).trim() !== '')
    .map(([key, label]) => ({ key, label, value: String(row[key]) }));
}

// DP's own delivery receipts, written by the portal when the ATHLETE taps
// Send to Garmin. Read-only here and limited to state and dates: no Garmin
// measurements, no ids, no tokens. A missing table or failed read just means
// "no receipt", never a broken builder.
async function readGarminReceipts(sessionId, sb) {
  try {
    const rows = await sb(
      `garmin_workout_deliveries?planned_session_id=eq.${encodeURIComponent(sessionId)}&select=state,scheduled_date,sent_at,updated_at&limit=5`
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function garminDeliveryStatus(receipts, session, detail, runSteps, movedTo = null) {
  const rows = Array.isArray(receipts) ? receipts : [];
  // The date Send to Garmin would use today: the athlete's move, else the plan.
  const effectiveDate = movedTo || session.planned_date || null;
  const athleteMovedTo = movedTo && movedTo !== session.planned_date ? movedTo : null;
  if (!rows.length) return { delivery: 'none', ...(athleteMovedTo ? { athleteMovedTo } : {}) };
  const latest = rows.slice().sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))[0];
  if (latest.state === 'creating' || latest.state === 'scheduling') {
    return { delivery: 'uncertain', updatedAt: latest.updated_at || null, ...(athleteMovedTo ? { athleteMovedTo } : {}) };
  }
  if (latest.state !== 'sent' || !latest.sent_at) return { delivery: 'not_sent', updatedAt: latest.updated_at || null, ...(athleteMovedTo ? { athleteMovedTo } : {}) };
  // Compared as instants: PostgREST returns "+00:00", the portal writes "Z".
  const time = (value) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : 0; };
  const changedAt = Math.max(0, time(detail && detail.updated_at),
    ...(runSteps || []).flatMap((row) => [time(row.updated_at), time(row.created_at)]));
  return {
    delivery: 'sent',
    sentAt: latest.sent_at,
    scheduledDate: latest.scheduled_date || null,
    // The coach changed the session or its steps after the athlete last sent
    // it. Garmin is not updated automatically; the athlete must send again.
    changedSince: changedAt > time(latest.sent_at),
    // Compared with the date the portal would send now, so an athlete's own
    // move that is already on Garmin does not read as a problem.
    plannedDateDiffers: Boolean(latest.scheduled_date && effectiveDate && latest.scheduled_date !== effectiveDate),
    ...(athleteMovedTo ? { athleteMovedTo } : {}),
  };
}

const EXERCISE_FIELDS = [
  'exercise_name', 'position', 'superset_group', 'circuit_group', 'sets',
  'warmup_sets', 'working_sets', 'rep_min', 'rep_max', 'rep_mode',
  'target_load', 'load_type', 'percent_1rm', 'rpe', 'rir', 'tempo',
  'rest_seconds', 'progression_rule', 'regression', 'alternatives',
  'left_right_exercises', 'coach_notes', 'athlete_notes', 'technique_cues',
  'exercise_id',
];

export function cleanExerciseFields(input = {}) {
  const out = {};
  for (const key of EXERCISE_FIELDS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === 'alternatives' || key === 'left_right_exercises') {
      out[key] = Array.isArray(value) ? value.slice(0, 20).map((v) => String(v).slice(0, 200)) : [];
    } else if (['sets', 'warmup_sets', 'working_sets', 'rep_min', 'rep_max', 'rest_seconds', 'position'].includes(key)) {
      out[key] = int(value);
    } else if (['target_load', 'percent_1rm', 'rpe', 'rir'].includes(key)) {
      out[key] = num(value);
    } else if (key === 'rep_mode') {
      out[key] = ['reps', 'left_right', 'time'].includes(value) ? value : 'reps';
    } else if (key === 'exercise_id') {
      out[key] = value ? String(value) : null;
    } else {
      out[key] = text(value, key === 'exercise_name' ? 200 : 2000);
    }
  }
  if ('warmup_sets' in out && out.warmup_sets === null) out.warmup_sets = 0;
  return out;
}

// Apply an operation across an edit scope.
//
// Every target session is materialised first: applying "Bench Press 4×6 → 4×5"
// to future sessions is meaningless if those sessions are still sharing a global
// split. Materialising them is what makes the change land on this athlete only.
async function applyAcrossScope(session, scopeRequest, sb, coach, operation) {
  const { sessions, appliedScope, note } = await resolveScope(session, scopeRequest, sb);
  const touched = [];

  for (const target of sessions) {
    if (target.locked_at) continue;
    if (target.prescription_mode !== 'structured') {
      await materialiseSession(target.id, sb, coach);
    }
    const rows = await sb(
      `session_exercises?planned_session_id=eq.${encodeURIComponent(target.id)}&select=*&order=position.asc&limit=200`
    );
    await operation(target, Array.isArray(rows) ? rows : []);
    touched.push(target.id);
  }

  return { touched, appliedScope, note };
}

export async function addExercise(body, sb, coach) {
  const session = await loadSession(body.session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);

  const fields = cleanExerciseFields(body.fields || {});
  if (!fields.exercise_name) throw httpError('An exercise name is required', 400);

  const result = await applyAcrossScope(session, body.scope, sb, coach, async (target, rows) => {
    const position = fields.position !== null && fields.position !== undefined
      ? fields.position
      : rows.length;
    await sb('session_exercises', {
      method: 'POST',
      body: [{ ...fields, position, planned_session_id: target.id }],
      prefer: 'return=minimal',
    });
  });

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'exercise',
    entityId: session.id,
    action: 'added',
    scope: result.appliedScope,
    newValue: fields,
    summary: `Added ${fields.exercise_name} to ${session.title}`,
  });

  return { ok: true, ...result };
}

export async function updateExercise(body, sb, coach) {
  const id = String(body.exercise_id || '').trim();
  if (!id) throw httpError('Exercise id is required', 400);

  const existingRows = await sb(`session_exercises?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (!existing) throw httpError('Exercise not found', 404);

  const session = await loadSession(existing.planned_session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);

  const fields = cleanExerciseFields(body.fields || {});
  if (!Object.keys(fields).length) throw httpError('No editable fields supplied', 400);

  const result = await applyAcrossScope(session, body.scope, sb, coach, async (target, rows) => {
    // Match by name within each target session. Position alone is unreliable
    // once a coach has reordered a later week.
    const match = rows.find((row) => row.exercise_name === existing.exercise_name);
    if (!match) return;
    await sb(`session_exercises?id=eq.${encodeURIComponent(match.id)}`, {
      method: 'PATCH',
      body: fields,
      prefer: 'return=minimal',
    });
  });

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'exercise',
    entityId: existing.id,
    action: 'updated',
    scope: result.appliedScope,
    oldValue: existing,
    newValue: fields,
    summary: `Changed ${existing.exercise_name} in ${session.title}`,
  });

  return { ok: true, ...result };
}

export async function replaceExercise(body, sb, coach) {
  const id = String(body.exercise_id || '').trim();
  const replacement = text(body.exercise_name, 200);
  if (!id) throw httpError('Exercise id is required', 400);
  if (!replacement) throw httpError('A replacement exercise name is required', 400);

  const existingRows = await sb(`session_exercises?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (!existing) throw httpError('Exercise not found', 404);

  const session = await loadSession(existing.planned_session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);

  const patch = { exercise_name: replacement, exercise_id: body.exercise_library_id || null };

  const result = await applyAcrossScope(session, body.scope, sb, coach, async (target, rows) => {
    const match = rows.find((row) => row.exercise_name === existing.exercise_name);
    if (!match) return;
    await sb(`session_exercises?id=eq.${encodeURIComponent(match.id)}`, {
      method: 'PATCH',
      body: patch,
      prefer: 'return=minimal',
    });
  });

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'exercise',
    entityId: existing.id,
    action: 'replaced',
    scope: result.appliedScope,
    oldValue: { exercise_name: existing.exercise_name },
    newValue: { exercise_name: replacement },
    summary: `Replaced ${existing.exercise_name} with ${replacement} in ${session.title}`,
  });

  return { ok: true, ...result };
}

export async function removeExercise(body, sb, coach) {
  const id = String(body.exercise_id || '').trim();
  if (!id) throw httpError('Exercise id is required', 400);

  const existingRows = await sb(`session_exercises?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (!existing) throw httpError('Exercise not found', 404);

  const session = await loadSession(existing.planned_session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);

  const result = await applyAcrossScope(session, body.scope, sb, coach, async (target, rows) => {
    const match = rows.find((row) => row.exercise_name === existing.exercise_name);
    if (!match) return;
    await sb(`session_exercises?id=eq.${encodeURIComponent(match.id)}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    });
  });

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'exercise',
    entityId: existing.id,
    action: 'removed',
    scope: result.appliedScope,
    oldValue: existing,
    summary: `Removed ${existing.exercise_name} from ${session.title}`,
  });

  return { ok: true, ...result };
}

// Reorder and superset grouping are always session-scoped: ordering is a
// property of one day's session, not of a whole block.
export async function reorderExercises(body, sb, coach) {
  const session = await loadSession(body.session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);
  if (session.locked_at) throw httpError('That session is completed and cannot be edited', 409);

  const order = Array.isArray(body.order) ? body.order : [];
  if (!order.length) throw httpError('An order is required', 400);

  for (let index = 0; index < order.length; index += 1) {
    const item = order[index];
    const id = String(typeof item === 'string' ? item : item.id || '').trim();
    if (!id) continue;
    const patch = { position: index };
    if (typeof item === 'object' && 'superset_group' in item) {
      patch.superset_group = text(item.superset_group, 10);
    }
    await sb(`session_exercises?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
      prefer: 'return=minimal',
    });
  }

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'session',
    entityId: session.id,
    action: 'reordered',
    scope: 'session',
    summary: `Reordered ${session.title}`,
  });

  return { ok: true, touched: [session.id], appliedScope: 'session', note: '' };
}

// ── Structured runs (Garmin-compatible) ─────────────────────────────────────
//
// A structured run is a small ordered tree, saved whole. The rules live in
// public/run-workout.js so the builder and this server share one copy, and
// they mirror the athlete portal's Garmin converter (garmin-workouts.js),
// which is what actually turns these rows into a watch workout.
//
// The write is ONE database call: replace_run_steps() deletes the old rows,
// inserts the new tree and (optionally) publishes, inside a single
// transaction. The previous version deleted every step and then inserted them
// one request at a time, so for a published session the portal could read an
// empty or half-built workout, and a failure part-way left it that way.
//
// Nothing is saved that the portal converter would refuse. The client
// validates first; this is the backstop, and a crafted request gets the same
// plain-language answer.

function runValidationError(report) {
  const [first, ...rest] = report.errors;
  const error = httpError(
    `${first.message}${rest.length ? ` (and ${rest.length} more issue${rest.length === 1 ? '' : 's'})` : ''}`,
    422
  );
  error.issues = report.errors.map((issue) => issue.message);
  return error;
}

// Builder steps → run_steps rows with server-assigned ids. Client references
// never reach the database: a forged id cannot collide with another
// session's row, and parents are remapped to the ids generated here.
export function buildRunStepRows(steps, sessionId, uuid = randomUUID) {
  const ids = new Map(steps.map((step) => [step.id, uuid()]));
  const rows = [];
  const walk = (parentRef) => {
    RULES.childrenOf(steps, parentRef).forEach((step, index) => {
      rows.push(RULES.toRow(step, sessionId, ids.get(step.id), parentRef ? ids.get(parentRef) : null, index));
      if (step.step_type === 'repeat') walk(step.id);
    });
  };
  walk(null);
  return rows;
}

export async function saveRunSteps(body, sb, coach, { uuid = randomUUID } = {}) {
  const session = await loadSession(body.session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);
  // Same two guards as every other programming write (resolveScope): sessions
  // completed before locking existed still carry a status with a null
  // locked_at, and replace_run_steps() only checks locked_at.
  if (session.locked_at || (session.status && session.status !== 'Planned')) {
    throw httpError(`That session is marked ${session.status || 'completed'} and cannot be edited`, 409);
  }

  const input = Array.isArray(body.steps) ? body.steps : [];
  // Refuse rather than truncate. The old code sliced to 100 and saved the
  // rest of the workout silently missing.
  if (input.length > RULES.LIMITS.rows) {
    throw httpError(`A run workout can hold at most ${RULES.LIMITS.rows} steps; this one has ${input.length}.`, 422);
  }

  const steps = input.map(RULES.fromInput);
  const report = RULES.validate(session, steps);
  if (!report.valid) throw runValidationError(report);

  const rows = buildRunStepRows(steps, session.id, uuid);
  if (rows.length !== steps.length) {
    // Only possible for a tree validate() already rejected; never write a
    // partial workout because of it.
    throw httpError('Some steps are not connected to the workout. Reload and try again.', 422);
  }

  const publish = body.publish === true ? 'published' : null;
  try {
    await sb('rpc/replace_run_steps', {
      method: 'POST',
      body: { p_session_id: session.id, p_steps: rows, p_publish_state: publish },
    });
  } catch (error) {
    // PGRST202: the function is not in PostgREST's schema yet, i.e. the
    // migration has not been applied. Fail closed with the fix, rather than
    // falling back to the old delete-then-insert path this replaces. Nothing
    // was written: the call never started.
    if (error && (error.upstreamCode === 'PGRST202' || /Could not find the function[\s\S]*replace_run_steps/.test(String(error.message || '')))) {
      throw httpError('Run steps can’t be saved until the database update replace_run_steps (migration 20261105000001) is applied. Nothing was changed.', 409);
    }
    throw error;
  }

  const publishState = publish || session.publish_state;
  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'run_steps',
    entityId: session.id,
    action: publish && session.publish_state !== 'published' ? 'published' : 'saved',
    scope: 'session',
    newValue: { steps: rows.length, garmin_steps: report.expandedSteps, publish_state: publishState },
    summary: `${publish && session.publish_state !== 'published' ? 'Saved and published' : 'Saved'} the run structure for ${session.title} (${rows.length} step${rows.length === 1 ? '' : 's'})`,
  });

  return {
    ok: true,
    touched: [session.id],
    appliedScope: 'session',
    note: '',
    publish_state: publishState,
    prescription_mode: rows.length ? 'structured' : session.prescription_mode,
    runSteps: rows,
    validation: {
      garminReady: report.garminReady,
      blockers: report.blockers,
      expandedSteps: report.expandedSteps,
    },
  };
}

const RUN_STEP_COLUMNS = 'id,planned_session_id,parent_step_id,step_order,step_type,repeat_count,distance_km,duration_sec,intensity_type,pace_min,pace_max,hr_zone,rpe,effort,instructions,coach_notes,created_at,updated_at';

// Publishing exposes a structured run to the portal, and from there to the
// athlete's Send to Garmin button. Refuse to publish one the converter would
// reject, so "published" never means "broken on the watch".
async function assertRunPublishable(session, sb) {
  if (session.prescription_mode !== 'structured') return;
  const rows = await sb(
    `run_steps?planned_session_id=eq.${encodeURIComponent(session.id)}&select=${RUN_STEP_COLUMNS}&order=step_order.asc&limit=200`
  );
  const steps = (Array.isArray(rows) ? rows : []).map(RULES.fromRow);
  if (!steps.length) return;
  const report = RULES.validate(session, steps);
  if (!report.valid) {
    const error = runValidationError(report);
    error.message = `“${session.title}” can’t be published yet. ${error.message}`;
    throw error;
  }
}

// The picker browses by category rather than requiring a coach to type, so this
// returns the WHOLE library grouped, not a search page. 119 rows is small enough
// to send in one response and filter in the browser, which keeps category
// switching instant.
// ── Save a session's prescription as a reusable split (spec §39) ────────────
//
// The inverse of splitEntryToExercise(). A coach shapes a session on one
// athlete, then promotes it to a named split they can assign anywhere.
//
// coach_notes is deliberately NOT carried across. workout_splits.exercises[].notes
// is rendered to athletes by the portal, so copying a private note into it would
// publish it to everyone who ever trains this split.
export function exerciseToSplitEntry(row) {
  const working = row.working_sets != null ? row.working_sets : row.sets;
  const warmup = row.warmup_sets || 0;
  const reps = row.rep_min != null && row.rep_max != null && row.rep_max !== row.rep_min
    ? `${row.rep_min}-${row.rep_max}`
    : String(row.rep_min != null ? row.rep_min : (row.rep_max != null ? row.rep_max : ''));

  const entry = {
    exercise: row.exercise_name,
    // The split editor's own convention: `sets` is the TOTAL, warm-up included.
    // _collectSplitExercises() in index.html computes it the same way.
    sets: String((parseInt(warmup, 10) || 0) + (parseInt(working, 10) || 0)),
    warmupSets: String(warmup),
    workingSets: working != null ? String(working) : '',
    reps: row.rep_min != null ? String(row.rep_min) : '',
    repRange: reps,
    rest: row.rest_seconds != null ? `${row.rest_seconds}s` : '',
    notes: row.athlete_notes || '',
    alts: Array.isArray(row.alternatives) ? row.alternatives : [],
  };

  // Only carry unilateral metadata when it is actually set, so a plain
  // bilateral exercise round-trips to exactly the shape it started as.
  if (row.rep_mode && row.rep_mode !== 'reps') entry.repMode = row.rep_mode;
  if (Array.isArray(row.left_right_exercises) && row.left_right_exercises.length) {
    entry.leftRightExercises = row.left_right_exercises;
  }
  return entry;
}

export async function saveSessionAsSplit(body, sb, coach) {
  const session = await loadSession(body.session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);

  const name = text(body.name, 120);
  if (!name) throw httpError('A split name is required', 400);

  // Blank means every athlete, matching the New Split editor's own wording.
  const athleteCode = body.athlete_code
    ? String(body.athlete_code).trim().toUpperCase()
    : null;
  if (athleteCode) await assertAthleteAllowed(coach, athleteCode, sb);

  const rows = await sb(
    `session_exercises?planned_session_id=eq.${encodeURIComponent(session.id)}&select=*&order=position.asc&limit=200`
  );
  const exercises = (Array.isArray(rows) ? rows : []).map(exerciseToSplitEntry);
  if (!exercises.length) {
    throw httpError('This session has no exercises to save', 400);
  }

  // The unique index is (name, athlete_code), and Postgres treats NULLs as
  // distinct — so two GLOBAL splits with the same name would both insert and
  // the portal would silently resolve to whichever came back first. Check by
  // hand rather than relying on the constraint.
  const clash = await sb(
    `workout_splits?name=eq.${encodeURIComponent(name)}` +
    `&athlete_code=${athleteCode ? `eq.${encodeURIComponent(athleteCode)}` : 'is.null'}` +
    `&archived=eq.false&select=id&limit=1`
  );
  if (Array.isArray(clash) && clash.length) {
    throw httpError(
      athleteCode
        ? `${athleteCode} already has a split called "${name}"`
        : `A shared split called "${name}" already exists`,
      409
    );
  }

  const created = await sb('workout_splits', {
    method: 'POST',
    body: [{ name, athlete_code: athleteCode, exercises, archived: false }],
    prefer: 'return=representation',
  });
  const split = Array.isArray(created) && created[0] ? created[0] : null;

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'split',
    entityId: split ? split.id : null,
    action: 'created',
    newValue: { name, athlete_code: athleteCode, exercises: exercises.length },
    summary: `Saved "${session.title}" as ${athleteCode ? `${athleteCode}'s` : 'a shared'} split "${name}"`,
  });

  return {
    ok: true,
    split: split ? { id: split.id, name: split.name, athlete_code: split.athlete_code } : null,
    exercises: exercises.length,
    scope: athleteCode || 'all athletes',
  };
}

export async function searchExerciseLibrary(query, sb) {
  const term = String(query || '').trim().slice(0, 60);
  const filter = term
    ? `&name=ilike.*${encodeURIComponent(term.replace(/[*%]/g, ''))}*`
    : '';
  const rows = await sb(
    `exercise_library?archived=eq.false${filter}&select=id,name,category,muscle_group,equipment,thumbnail_url,cues&order=category.asc,name.asc&limit=1000`
  );
  const results = Array.isArray(rows) ? rows : [];

  // Category order is coaching order, not alphabetical: upper push/pull first,
  // then arms, then lower, then the accessory groups.
  const RANK = [
    'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps',
    'Quads', 'Hamstrings', 'Glutes', 'Calves',
    'Core', 'Running Strength', 'General',
  ];
  const categories = [...new Set(results.map((row) => row.category || 'General'))]
    .sort((a, b) => {
      const ai = RANK.indexOf(a); const bi = RANK.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    });

  return { ok: true, results, categories };
}

export async function setPublishState(body, sb, coach) {
  const state = body.publish_state === 'draft' ? 'draft' : 'published';
  const ids = Array.isArray(body.session_ids) ? body.session_ids.filter(Boolean) : [];
  if (!ids.length) throw httpError('At least one session is required', 400);

  // Authorise every session individually. A coach must not be able to publish
  // someone else's draft by including its id in the list.
  const sessions = [];
  for (const id of ids) {
    const session = await loadSession(id, sb);
    await assertAthleteAllowed(coach, session.athlete_code, sb);
    if (state === 'published') await assertRunPublishable(session, sb);
    sessions.push(session);
  }

  for (const session of sessions) {
    await sb(`planned_sessions?id=eq.${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      body: { publish_state: state, updated_at: new Date().toISOString() },
      prefer: 'return=minimal',
    });
  }

  await logProgrammeChange(sb, {
    athleteCode: sessions[0].athlete_code,
    changedBy: coach.handle,
    entityType: 'session',
    entityId: sessions[0].id,
    action: state === 'draft' ? 'unpublished' : 'published',
    newValue: { publish_state: state, count: sessions.length },
    summary: `${state === 'draft' ? 'Moved to draft' : 'Published'} ${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
  });

  return { ok: true, updated: sessions.length, publish_state: state };
}

export async function programmeHistory(code, sb) {
  const athlete = encodeURIComponent(String(code || '').trim().toUpperCase());
  const rows = await sb(
    `programme_change_log?athlete_code=eq.${athlete}&select=*&order=changed_at.desc&limit=100`
  );
  return { ok: true, entries: Array.isArray(rows) ? rows : [] };
}

// ── Duplicate a session's prescription ───────────────────────────────────────
//
// planned_sessions carries only the legacy free-text prescription columns. The
// prescription a coach actually builds lives in session_exercises (strength) and
// run_steps (structured running), and duplicating the parent row alone produced
// a session with neither: an empty prescription for the athlete, and nothing for
// Phase 3's prescribed-vs-actual to match against, while the coach was told the
// session had been copied.
//
// Runs server-side and after the parent insert so a copy cannot half-succeed in
// the browser. Failure here is reported rather than swallowed: a duplicate that
// silently loses its prescription is the bug this exists to fix.
// Source run_steps → rows for replace_run_steps() on the copy. Values travel
// exactly as saved (including coach_notes, which stays coach-only on the
// copy too); every id is new and every parent is remapped at any depth. A row
// whose parent is not in the source set is refused, never dropped quietly.
const RUN_STEP_COPY_FIELDS = [
  'step_order', 'step_type', 'repeat_count', 'distance_km', 'duration_sec',
  'intensity_type', 'pace_min', 'pace_max', 'hr_zone', 'rpe', 'effort',
  'instructions', 'coach_notes',
];

export function remapRunStepCopy(stepRows, targetSessionId, uuid = randomUUID) {
  const ids = new Map(stepRows.map((row) => [String(row.id), uuid()]));
  const orphaned = stepRows.filter((row) => row.parent_step_id && !ids.has(String(row.parent_step_id)));
  if (orphaned.length) {
    throw httpError(
      `Couldn’t copy the run steps: ${orphaned.length} of ${stepRows.length} had no parent to attach to. Nothing was copied.`,
      422
    );
  }
  return stepRows.map((row) => {
    const out = { id: ids.get(String(row.id)), planned_session_id: targetSessionId,
      parent_step_id: row.parent_step_id ? ids.get(String(row.parent_step_id)) : null };
    for (const key of RUN_STEP_COPY_FIELDS) out[key] = row[key] === undefined ? null : row[key];
    return out;
  });
}

export async function copyPrescription(sourceSessionId, targetSessionId, sb) {
  const source = encodeURIComponent(String(sourceSessionId));
  const [exercises, steps] = await Promise.all([
    sb(`session_exercises?planned_session_id=eq.${source}&select=*&order=position.asc&limit=200`),
    sb(`run_steps?planned_session_id=eq.${source}&select=*&order=step_order.asc&limit=200`),
  ]);

  const exerciseRows = Array.isArray(exercises) ? exercises : [];
  const stepRows = Array.isArray(steps) ? steps : [];
  let copiedExercises = 0;
  let copiedSteps = 0;
  // Check the run tree before writing anything, so a bad source copies nothing.
  if (stepRows.length) remapRunStepCopy(stepRows, targetSessionId);

  if (exerciseRows.length) {
    const rows = exerciseRows.map((row) => {
      const { id, planned_session_id, created_at, updated_at, ...rest } = row;
      return { ...rest, planned_session_id: targetSessionId };
    });
    await sb('session_exercises', { method: 'POST', body: rows, prefer: 'return=minimal' });
    copiedExercises = rows.length;
  }

  if (stepRows.length) {
    // One call, the same atomic path the builder saves through. Rows were
    // copied one request at a time before, parents first and then every other
    // row; a repeat nested inside a repeat therefore had no new parent id and
    // the copy failed with half the steps written.
    const rows = remapRunStepCopy(stepRows, targetSessionId);
    try {
      await sb('rpc/replace_run_steps', {
        method: 'POST',
        body: { p_session_id: targetSessionId, p_steps: rows, p_publish_state: null },
      });
    } catch (error) {
      if (error && (error.upstreamCode === 'PGRST202' || /Could not find the function[\s\S]*replace_run_steps/.test(String(error.message || '')))) {
        throw httpError('Run steps can’t be copied until the database update replace_run_steps (migration 20261105000001) is applied.', 409);
      }
      throw error;
    }
    copiedSteps = rows.length;
  }

  return { copiedExercises, copiedSteps };
}
