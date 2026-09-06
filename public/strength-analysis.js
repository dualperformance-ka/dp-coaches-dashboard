/**
 * strength-analysis.js
 * ---------------------------------------------------------------------------
 * Turns the athlete portal's strength logs into the things a strength coach
 * actually asks: is this lift going up, which exercises get skipped, and has
 * anything stalled.
 *
 * Two input shapes exist and both are handled, because the dashboard has both:
 *
 *   1. The portal's `logs` blob (athlete_data key='logs'), which is structured:
 *        logs[sessionId][exerciseName] = [{ weight, reps, rpe, done }, ...]
 *      This is what progressive-overload.js was written against, so where it is
 *      present the existing engine runs unchanged.
 *
 *   2. training_session_logs.exercise_log, a free-text string:
 *        "Back squat: Set 1: 92.5kg x 5 @ RPE 8 | Set 2: ..."
 *      Parsed here as a fallback so an athlete whose blob is missing still gets
 *      history rather than an empty tab.
 *
 * progressive-overload.js and overload-adapter.js have been in the repository
 * since before this file and were never called by the dashboard. Nothing in
 * them changes; this module is the wiring.
 */

import { buildExerciseHistory } from './overload-adapter.js';
import { computeTarget } from './progressive-overload.js';

// ── Identity ─────────────────────────────────────────────────────────────────
// "Back Squat", "back squat" and "Back  Squat" are one exercise. Matching the
// portal's own key means a swap recorded there lines up here.
export function matchKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Free-text fallback ───────────────────────────────────────────────────────

export function parseExerciseLogText(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(': Set ');
    if (at === -1) continue;
    const exercise = trimmed.slice(0, at).trim();
    const sets = trimmed.slice(at + 2).split('|').map(chunk => {
      const value = (chunk.trim().match(/Set\s*\d+:\s*(.+)/) || [, chunk.trim()])[1] || '';
      const weight = value.match(/([\d.]+)\s*kg/i);
      const reps = value.match(/[×x]\s*([\d.]+)/i) || value.match(/([\d.]+)\s*reps?/i);
      const rpe = value.match(/@\s*RPE\s*([\d.]+)/i);
      return {
        weight: weight ? Number(weight[1]) : null,
        reps: reps ? Number(reps[1]) : null,
        rpe: rpe ? Number(rpe[1]) : null,
      };
    }).filter(set => set.weight != null || set.reps != null);
    if (sets.length) out.push({ exercise, sets });
  }
  return out;
}

// ── History ──────────────────────────────────────────────────────────────────

function normaliseSet(set) {
  const weight = set.weight ?? set.weightKg ?? null;
  // Unilateral work logs reps per side; the lower side is the honest number.
  const reps = set.reps ?? (set.repsLeft != null && set.repsRight != null
    ? Math.min(Number(set.repsLeft), Number(set.repsRight))
    : set.repsLeft ?? set.repsRight ?? null);
  const w = weight == null || weight === '' ? null : Number(weight);
  const r = reps == null || reps === '' ? null : Number(reps);
  return {
    weight: Number.isFinite(w) ? w : null,
    reps: Number.isFinite(r) ? r : null,
    rpe: set.rpe == null || set.rpe === '' ? null : Number(set.rpe),
  };
}

// Epley, the same estimator detectPRs already uses in the dashboard. Kept
// identical so a PR badge and a progression line never disagree.
export function estimate1RM(weight, reps) {
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) return null;
  return weight * (1 + reps / 30);
}

/**
 * Every logged instance of every exercise, oldest first.
 *
 * @param {object} logs        portal logs blob, keyed by session id
 * @param {object[]} sessions  [{ id, date }] from planned_sessions
 * @param {object[]} textLogs  [{ date, exerciseLog }] fallback rows
 */
export function collectExerciseHistory(logs, sessions, textLogs = []) {
  const byExercise = new Map();

  const add = (name, date, sets) => {
    const clean = sets.map(normaliseSet).filter(set => set.weight != null || set.reps != null);
    if (!clean.length) return;
    const key = matchKey(name);
    if (!key) return;
    const entry = byExercise.get(key) || { key, name: String(name).trim(), instances: [] };
    entry.instances.push({ date: date || null, sets: clean });
    byExercise.set(key, entry);
  };

  const dateById = new Map();
  for (const session of sessions || []) {
    if (session && session.id != null) dateById.set(String(session.id), session.date || null);
  }

  // 1. Structured blob.
  for (const [sessionId, entry] of Object.entries(logs || {})) {
    if (sessionId.startsWith('__')) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const [exercise, sets] of Object.entries(entry)) {
      if (exercise.startsWith('__') || !Array.isArray(sets)) continue;
      add(exercise, dateById.get(String(sessionId)), sets);
    }
  }

  // 2. Free-text fallback, skipping any date the blob already covered so a
  //    session logged in both places is not counted twice.
  const covered = new Set();
  for (const entry of byExercise.values()) {
    for (const instance of entry.instances) {
      if (instance.date) covered.add(instance.date);
    }
  }
  for (const row of textLogs || []) {
    if (!row?.date || covered.has(row.date)) continue;
    for (const parsed of parseExerciseLogText(row.exerciseLog)) {
      add(parsed.exercise, row.date, parsed.sets);
    }
  }

  for (const entry of byExercise.values()) {
    entry.instances.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  }
  return byExercise;
}

// ── Per-exercise summary ─────────────────────────────────────────────────────

// Trend-only reading, used when the coach's rep range is not known. It is
// deliberately conservative: a stall needs three sessions of no movement at a
// genuinely hard effort, and progress needs a real load increase, not noise.
function observedStatus(series) {
  if (!series.length) return { status: 'first_time' };
  if (series.length < 2) return { status: 'first_time' };

  const recent = series.slice(-3);
  const change = series[series.length - 1].e1rm - series[0].e1rm;
  const flat = recent.length >= 3
    && Math.abs(recent[recent.length - 1].e1rm - recent[0].e1rm) < 1;
  const hard = recent.every(point => point.rpe == null || point.rpe >= 8.5);

  if (flat && hard) return { status: 'stalled' };
  if (change >= 2) return { status: 'progress_load' };
  if (change <= -2) return { status: 'stalled' };
  return { status: 'hold' };
}

function bestSet(sets) {
  let best = null;
  for (const set of sets) {
    const e1rm = estimate1RM(set.weight, set.reps);
    if (e1rm == null) continue;
    if (!best || e1rm > best.e1rm) best = { ...set, e1rm };
  }
  return best;
}

function tonnage(sets) {
  return sets.reduce((sum, set) =>
    sum + ((Number.isFinite(set.weight) && Number.isFinite(set.reps)) ? set.weight * set.reps : 0), 0);
}

/**
 * One row per exercise: how often it was done, the current best set, the e1RM
 * series, and the engine's verdict on whether load should move.
 *
 * `prescribedCounts` maps a match key to how many times the exercise was
 * programmed in the window, which is what turns "did it 3 times" into
 * "did it 3 of 8 times" — the number that reveals a consistently skipped lift.
 */
export function summariseExercises(history, options = {}) {
  const {
    prescribedCounts = new Map(),
    // matchKey -> { workingSets, repRange } from the coach's own split. Without
    // it the engine cannot judge progression, because "own the rep range then
    // add load" needs to know what the rep range is.
    prescriptions = new Map(),
    since = null,
    config = null,
  } = options;
  const rows = [];

  for (const entry of history.values()) {
    const instances = since
      ? entry.instances.filter(i => !i.date || i.date >= since)
      : entry.instances;
    if (!instances.length) continue;

    const series = instances.map(instance => {
      const best = bestSet(instance.sets);
      return {
        date: instance.date,
        e1rm: best ? Math.round(best.e1rm * 10) / 10 : null,
        topWeight: best ? best.weight : null,
        topReps: best ? best.reps : null,
        rpe: instance.sets.map(s => s.rpe).filter(Number.isFinite).slice(-1)[0] ?? null,
        volume: Math.round(tonnage(instance.sets)),
        sets: instance.sets.length,
      };
    });

    const withLoad = series.filter(point => point.e1rm != null);
    const latest = withLoad[withLoad.length - 1] || null;
    const first = withLoad[0] || null;

    // The engine reads history oldest-first as [{ date, sets }], which is what
    // collectExerciseHistory already produces. It only runs where the coach's
    // prescription is known: guessing a rep range made every 5-rep lift read as
    // "hold" because it never owned an assumed 8-12.
    const prescription = prescriptions.get(entry.key) || null;
    let verdict = null;
    if (prescription?.repRange) {
      try {
        verdict = computeTarget(
          {
            exercise: entry.name,
            workingSets: prescription.workingSets || latest?.sets || 3,
            repRange: prescription.repRange,
          },
          instances,
          config ? { config } : undefined
        );
      } catch (error) {
        // A malformed log must not take the whole tab down.
        console.warn('[strength] overload engine failed for', entry.name, error);
      }
    }

    // No prescription: report what the numbers did rather than what the athlete
    // should do next. Marked `inferred` so the UI never presents an observation
    // as the engine's coaching decision.
    const observed = observedStatus(withLoad);

    const prescribed = prescribedCounts.get(entry.key) ?? null;

    rows.push({
      key: entry.key,
      name: entry.name,
      done: instances.length,
      prescribed,
      adherencePct: prescribed ? Math.round((instances.length / prescribed) * 100) : null,
      // A lift programmed eight times and done three is the signal; the
      // threshold is deliberately generous so it only fires on real avoidance.
      isSkipped: prescribed != null && prescribed >= 3 && instances.length / prescribed < 0.6,
      series,
      latest,
      changeKg: latest && first && withLoad.length >= 2
        ? Math.round((latest.e1rm - first.e1rm) * 10) / 10
        : null,
      status: verdict?.status || observed.status,
      inferred: !verdict,
      // The engine returns `coaching` (a full sentence) and `target`
      // ({ weightKg, reps, sets }); it has no separate headline, so the row's
      // own status chip carries the short form.
      coaching: verdict?.coaching || null,
      target: verdict?.target
        ? { weight: verdict.target.weightKg ?? null, reps: verdict.target.reps ?? null, sets: verdict.target.sets ?? null }
        : null,
      isStalled: (verdict?.status || observed.status) === 'stalled',
      lastRpe: latest?.rpe ?? null,
      lastDate: latest?.date || instances[instances.length - 1].date,
    });
  }

  // Worst adherence first, then stalls, then everything else by name: the two
  // things a coach is scanning for sit at the top.
  return rows.sort((a, b) => {
    if (a.isSkipped !== b.isSkipped) return a.isSkipped ? -1 : 1;
    if (a.isStalled !== b.isStalled) return a.isStalled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ── Weekly strength volume ───────────────────────────────────────────────────
// Tonnage per week, so strength load can be put on the same axis as run volume.
// That comparison is the point of a concurrent programme and the dashboard had
// no way to make it.
export function weeklyStrengthVolume(history, mondayOf) {
  const byWeek = new Map();
  for (const entry of history.values()) {
    for (const instance of entry.instances) {
      if (!instance.date) continue;
      const week = mondayOf(instance.date);
      const bucket = byWeek.get(week) || { week, volume: 0, sets: 0, sessions: new Set() };
      bucket.volume += tonnage(instance.sets);
      bucket.sets += instance.sets.length;
      bucket.sessions.add(instance.date);
      byWeek.set(week, bucket);
    }
  }
  return [...byWeek.values()]
    .map(bucket => ({
      week: bucket.week,
      volume: Math.round(bucket.volume),
      sets: bucket.sets,
      sessions: bucket.sessions.size,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

const api = {
  matchKey,
  parseExerciseLogText,
  estimate1RM,
  collectExerciseHistory,
  summariseExercises,
  weeklyStrengthVolume,
  buildExerciseHistory,
  computeTarget,
};

if (typeof window !== 'undefined') window.DP_STRENGTH = api;
export default api;
