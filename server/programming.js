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

  const [exercises, steps, split] = await Promise.all([
    sb(`session_exercises?planned_session_id=eq.${id}&select=*&order=position.asc&limit=200`),
    sb(`run_steps?planned_session_id=eq.${id}&select=*&order=step_order.asc&limit=200`),
    session.prescription_mode === 'structured' ? Promise.resolve(null) : findMatchingSplit(session, sb),
  ]);

  return {
    session,
    exercises: Array.isArray(exercises) ? exercises : [],
    runSteps: Array.isArray(steps) ? steps : [],
    // For a legacy session, show what it currently resolves to so the coach can
    // see what they are about to take control of.
    legacySplit: split ? { id: split.id, name: split.name, exercises: split.exercises || [] } : null,
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

// Run steps are saved whole. A structured run is a small ordered tree and
// diffing it field by field would be more code and more risk than replacing it.
export async function saveRunSteps(body, sb, coach) {
  const session = await loadSession(body.session_id, sb);
  await assertAthleteAllowed(coach, session.athlete_code, sb);
  if (session.locked_at) throw httpError('That session is completed and cannot be edited', 409);

  const steps = Array.isArray(body.steps) ? body.steps.slice(0, 100) : [];
  const id = encodeURIComponent(session.id);

  await sb(`run_steps?planned_session_id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });

  // Parents first so children can reference the ids the database assigns.
  const parents = steps.filter((step) => !step.parentRef);
  const parentIdByRef = new Map();

  for (let index = 0; index < parents.length; index += 1) {
    const step = parents[index];
    const row = toRunStepRow(step, index, session.id, null);
    const created = await sb('run_steps', {
      method: 'POST',
      body: [row],
      prefer: 'return=representation',
    });
    const createdId = Array.isArray(created) && created[0] ? created[0].id : null;
    if (step.ref && createdId) parentIdByRef.set(step.ref, createdId);
  }

  const children = steps.filter((step) => step.parentRef);
  for (let index = 0; index < children.length; index += 1) {
    const step = children[index];
    const parentId = parentIdByRef.get(step.parentRef);
    if (!parentId) continue;
    await sb('run_steps', {
      method: 'POST',
      body: [toRunStepRow(step, index, session.id, parentId)],
      prefer: 'return=minimal',
    });
  }

  if (steps.length && session.prescription_mode !== 'structured') {
    await sb(`planned_sessions?id=eq.${id}`, {
      method: 'PATCH',
      body: { prescription_mode: 'structured' },
      prefer: 'return=minimal',
    });
  }

  await logProgrammeChange(sb, {
    athleteCode: session.athlete_code,
    changedBy: coach.handle,
    entityType: 'run_steps',
    entityId: session.id,
    action: 'saved',
    scope: 'session',
    newValue: { steps: steps.length },
    summary: `Rebuilt the run structure for ${session.title} (${steps.length} steps)`,
  });

  return { ok: true, touched: [session.id], appliedScope: 'session', note: '' };
}

function toRunStepRow(step, order, sessionId, parentId) {
  const type = ['warmup', 'run', 'recovery', 'interval', 'rest', 'cooldown', 'repeat'].includes(step.type)
    ? step.type
    : 'run';
  return {
    planned_session_id: sessionId,
    parent_step_id: parentId,
    step_order: order,
    step_type: type,
    // The database check constraint enforces this pairing too; keeping it here
    // means the coach gets a clear 400 rather than a raw constraint violation.
    repeat_count: type === 'repeat' ? Math.max(1, int(step.repeat) || 1) : null,
    distance_km: num(step.distanceKm),
    duration_sec: int(step.durationSec),
    intensity_type: ['pace', 'pace_range', 'hr', 'hr_zone', 'rpe', 'effort', 'text'].includes(step.intensityType)
      ? step.intensityType
      : null,
    pace_min: text(step.paceMin, 20),
    pace_max: text(step.paceMax, 20),
    hr_zone: text(step.hrZone, 20),
    rpe: num(step.rpe),
    effort: text(step.effort, 60),
    instructions: text(step.instructions, 1000),
    coach_notes: text(step.coachNotes, 1000),
  };
}

// The picker browses by category rather than requiring a coach to type, so this
// returns the WHOLE library grouped, not a search page. 119 rows is small enough
// to send in one response and filter in the browser, which keeps category
// switching instant.
export async function searchExerciseLibrary(query, sb) {
  const term = String(query || '').trim().slice(0, 60);
  const filter = term
    ? `&name=ilike.*${encodeURIComponent(term.replace(/[*%]/g, ''))}*`
    : '';
  const rows = await sb(
    `exercise_library?archived=eq.false${filter}&select=id,name,category,muscle_group,equipment,thumbnail_url,cues&order=category.asc,name.asc&limit=400`
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
