/**
 * overload-adapter.js
 * ---------------------------------------------------------------------------
 * Bridges the athlete portal's stored data into the shape the progressive
 * overload engine expects. This is the "backlog" layer: it walks the athlete's
 * existing logs so progression continues from real history instead of resetting.
 *
 * The portal stores strength work as:
 *   logs = {
 *     <sessionId>: {
 *       "<exercise name>": [ { weight, reps, rpe, done }, ... ],   // bilateral
 *       "<exercise name>": [ { weight, repsLeft, repsRight, done } ], // unilateral
 *       __notes, __submittedAt                                     // metadata (ignored)
 *     },
 *     __savedAt: <ts>                                              // metadata (ignored)
 *   }
 * Dates live on the session objects (allSessions), keyed by id: { id, date, ... }.
 *
 * The engine wants one exercise's history as:
 *   [ { date, sets:[...] }, ... ]   // oldest first is fine; engine orders it
 *
 * Usage (once wired into the app):
 *   import { computeForExercise } from './overload-adapter.js';
 *   const resolved = exPicks[ex.exercise] || ex.exercise;
 *   const card = computeForExercise(
 *     { exercise: resolved, workingSets: ex.workingSets || ex.sets, repRange: ex.repRange || ex.reps },
 *     logs, allSessions,
 *     { excludeSessionId: s.id }   // don't fold today's in-progress entry into "previous"
 *   );
 *
 * House style: no em dashes anywhere in output copy.
 */

import { computeTarget } from './progressive-overload.js';

/* A set carries real data if any weight/reps field is non-empty. */
function hasSetData(x) {
  if (!x) return false;
  return (x.weight != null && String(x.weight).trim() !== '') ||
    (x.weightKg != null && String(x.weightKg).trim() !== '') ||
    (x.reps != null && String(x.reps).trim() !== '') ||
    (x.repsLeft != null && String(x.repsLeft).trim() !== '') ||
    (x.repsRight != null && String(x.repsRight).trim() !== '');
}

/**
 * Collect one exercise's history across every logged session.
 *
 * @param {string} exerciseName  resolved exercise name (after exPicks)
 * @param {object} logs          the portal's logs object
 * @param {object[]} allSessions session list carrying { id, date }
 * @param {object} [opts]        { excludeSessionId }
 * @returns {{date:(string|null), sets:object[], sessionId:string}[]} oldest first
 */
export function buildExerciseHistory(exerciseName, logs, allSessions, opts) {
  opts = opts || {};
  const exclude = opts.excludeSessionId != null ? String(opts.excludeSessionId) : null;

  const dateById = {};
  (allSessions || []).forEach(function (s) {
    if (s && s.id != null) dateById[String(s.id)] = s.date || null;
  });

  const out = [];
  Object.keys(logs || {}).forEach(function (sid) {
    if (sid.indexOf('__') === 0) return;          // __savedAt and friends
    if (exclude != null && sid === exclude) return;
    const entry = logs[sid];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return; // run logs / notes-only
    const sets = entry[exerciseName];
    if (!Array.isArray(sets) || !sets.length) return;
    const clean = sets.filter(hasSetData);
    if (!clean.length) return;
    out.push({ date: dateById[sid] || null, sets: clean, sessionId: sid });
  });

  // Sort oldest first so array order is chronological even when a date is
  // missing (deleted plan sessions). The engine prefers explicit dates but
  // falls back to array order, so a clean pre-sort keeps it robust either way.
  out.sort(function (a, b) {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    if (a.date && !b.date) return 1;   // undated entries sink to the front (treated as oldest)
    if (!a.date && b.date) return -1;
    return 0;
  });
  return out;
}

/**
 * Convenience: build the history for an exercise and run the engine in one call.
 * `prescription.exercise` should already be the resolved (exPicks) name.
 *
 * @param {object} prescription  { exercise, workingSets, repRange }
 * @param {object} logs
 * @param {object[]} allSessions
 * @param {object} [opts]        { excludeSessionId, lastRpe, config }
 * @returns {object} the engine's card object
 */
export function computeForExercise(prescription, logs, allSessions, opts) {
  opts = opts || {};
  const history = buildExerciseHistory(prescription.exercise, logs, allSessions, {
    excludeSessionId: opts.excludeSessionId
  });
  return computeTarget(prescription, history, { lastRpe: opts.lastRpe, config: opts.config });
}

export default { buildExerciseHistory, computeForExercise };
