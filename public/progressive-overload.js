/**
 * progressive-overload.js
 * ---------------------------------------------------------------------------
 * The decision engine behind the Dual Performance strength card.
 *
 * Given a prescription (what the coach asked for) and the athlete's recent
 * history for that exercise, it decides the single next move and returns a
 * plain object the card renderer can paint without any further logic.
 *
 * Model: double progression.
 *   1. Hold the weight and add reps until every working set hits the top of
 *      the rep range.
 *   2. Then bump the load by an equipment-aware step and reset toward the
 *      bottom of the range.
 *   3. If the same load stalls for several sessions, prescribe a small deload
 *      so the athlete can rebuild with momentum instead of grinding.
 *
 * Unilateral lifts (single leg, single arm, split squat, lunge...) store reps
 * per side; the engine uses the weaker side so both sides earn the progression.
 *
 * House style: no em dashes anywhere in output copy.
 *
 * -------- Data shapes --------
 * prescription: {
 *   exercise:    string,            // "Back Squat", "Single Leg RDL"
 *   workingSets: number,            // target working sets (fallback: sets)
 *   repRange:    string,            // "8-12", "5", "8 to 12"
 *   rest:        number|string      // optional, not used by the engine
 * }
 *
 * sessions: [                       // history for THIS exercise only
 *   {
 *     date: string,                 // ISO date, optional but recommended
 *     sets: [
 *       { weightKg:number, reps:number, rpe?:number }              // bilateral
 *       { weightKg:number, repsLeft:number, repsRight:number }     // unilateral
 *     ]
 *   }
 * ]
 *
 * opts: { lastRpe?:number, config?:object }
 *
 * -------- Return shape (consumed by dp-strength-card.js) --------
 * {
 *   status: 'first_time' | 'hold' | 'progress_load' | 'stalled',
 *   target:      { weightKg:number|null, reps:number, sets:number },
 *   lastSummary: { weightKg:number|null, reps:number, sets:number } | null,
 *   coaching:    string
 * }
 */

/* Tunable defaults. Override per exercise via opts.config if needed. */
const DEFAULTS = {
  defaultLow: 8,
  defaultTop: 12,
  stallSessions: 3,     // identical-load sessions with no rep gain => stalled
  deloadPct: 0.10,      // 10% back-off on a stall
  bumpPct: 0.025,       // fallback proportional bump when equipment unknown
  highRpe: 9.5          // an all-out set; softens an otherwise "push" call
};

/* ---------------------------------------------------------------- helpers */

function parseRange(str, cfg) {
  const nums = String(str == null ? '' : str).match(/\d+/g);
  if (!nums || !nums.length) return { low: cfg.defaultLow, top: cfg.defaultTop };
  const ints = nums.map(function (n) { return parseInt(n, 10); });
  if (ints.length === 1) return { low: ints[0], top: ints[0] };
  return { low: ints[0], top: ints[ints.length - 1] };
}

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

/* Effective reps for a set: bilateral uses reps, unilateral uses the weaker side. */
function setReps(s) {
  if (s == null) return null;
  const l = num(s.repsLeft), r = num(s.repsRight);
  if (l != null || r != null) return Math.min(l == null ? Infinity : l, r == null ? Infinity : r);
  return num(s.reps);
}

/* Keep only sets that actually carry data, then take the last N as working sets. */
function workingSlice(sets, workingSets) {
  const clean = (sets || []).filter(function (s) {
    return s && (num(s.weight != null ? s.weight : s.weightKg) != null || setReps(s) != null);
  });
  const n = parseInt(workingSets, 10) || clean.length;
  if (!n || clean.length <= n) return clean;
  return clean.slice(clean.length - n);
}

/* Weight of a set, tolerant of either `weightKg` or `weight`. */
function setLoad(s) { return num(s.weightKg != null ? s.weightKg : s.weight); }

/* Order history newest first. Uses date when present, else assumes the array
 * is already chronological (oldest first) and reverses it. */
function newestFirst(sessions) {
  const arr = (sessions || []).filter(Boolean).slice();
  const dated = arr.every(function (s) { return s && s.date; });
  if (dated) return arr.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
  return arr.reverse();
}

/* Reduce one session to the numbers the engine reasons about. */
function summarise(session, prescription) {
  const work = workingSlice(session.sets, prescription.workingSets || prescription.sets);
  const loads = work.map(setLoad).filter(function (v) { return v != null && v > 0; });
  const reps = work.map(setReps).filter(function (v) { return v != null; });
  const maxLoad = loads.length ? Math.max.apply(null, loads) : null;
  const totalReps = reps.reduce(function (a, b) { return a + b; }, 0);
  const topSetReps = reps.length ? Math.max.apply(null, reps) : 0;
  return { maxLoad: maxLoad, reps: reps, totalReps: totalReps, topSetReps: topSetReps, sets: work.length || 0 };
}

/* Classify equipment from the exercise name. */
function equipment(name) {
  const n = String(name || '').toLowerCase();
  if (/bodyweight|push[- ]?up|pull[- ]?up|chin[- ]?up|\bdip\b|plank|hollow/.test(n)) return 'bodyweight';
  if (/lateral raise|face pull|rear delt|reverse fly|\bfly\b|\bcurl\b|tricep|pushdown|calf|cuff|rotator|band/.test(n)) return 'accessory';
  const barbell = /\bsquat\b|deadlift|\brdl\b|romanian|bench press|barbell|overhead press|\bohp\b|hip thrust|\bpress\b/.test(n);
  const notBar = /machine|cable|smith|dumbbell|\bdb\b|goblet|kettlebell|band|bodyweight|leg press/.test(n);
  if (barbell && !notBar) return 'barbell';
  if (/dumbbell|\bdb\b|goblet|kettlebell/.test(n)) return 'dumbbell';
  if (/machine|cable|smith|leg press|pulldown|pec deck|extension|hamstring curl|leg curl/.test(n)) return 'machine';
  return 'other';
}

/* Equipment-aware load increment. Returns kg to add on top of current load. */
function loadStep(name, load, cfg) {
  switch (equipment(name)) {
    case 'bodyweight': return 0;                 // progress reps, not load
    case 'accessory':  return 1;                 // light isolation work
    case 'barbell':    return 2.5;               // smallest sane plate pair
    case 'dumbbell':   return 2;                 // per hand, typical rack jump
    case 'machine':    return 2.5;
    default: {
      const pct = Math.round(load * cfg.bumpPct * 2) / 2;   // ~2.5%, to 0.5kg
      return Math.max(1, pct);
    }
  }
}

function roundHalf(kg) { return Math.round(kg * 2) / 2; }

/* ---------------------------------------------------------------- engine */

export function computeTarget(prescription, sessions, opts) {
  opts = opts || {};
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const range = parseRange(prescription.repRange || prescription.reps, cfg);
  const wantSets = parseInt(prescription.workingSets || prescription.sets, 10) || 3;
  const ordered = newestFirst(sessions);

  /* No usable history: set a base. (Bodyweight lifts have no load, so a
   * session still counts as history when it carries reps.) */
  const last = ordered.length ? summarise(ordered[0], prescription) : null;
  if (!last || (last.maxLoad == null && last.topSetReps === 0)) {
    return {
      status: 'first_time',
      target: { weightKg: null, reps: range.low, sets: wantSets },
      lastSummary: null,
      coaching: 'First working session. Pick a weight you control for ' + range.low +
        ' clean reps with 2 to 3 tough ones left in the tank. Numbers come later.'
    };
  }

  const lastSummary = { weightKg: last.maxLoad, reps: last.topSetReps, sets: last.sets };
  const allTop = last.reps.length >= Math.min(wantSets, last.reps.length) &&
    last.reps.length > 0 &&
    last.reps.every(function (v) { return v >= range.top; });
  const lastRpe = num(opts.lastRpe);

  /* 1) Every working set at the top of the range => add load. */
  if (allTop) {
    const step = loadStep(prescription.exercise, last.maxLoad, cfg);
    let next = step > 0 ? roundHalf(last.maxLoad + step) : last.maxLoad;
    if (step > 0 && next <= last.maxLoad) next = last.maxLoad + step;

    if (step === 0) {
      // Bodyweight: no load to add, push reps past the range instead.
      return {
        status: 'progress_load',
        target: { weightKg: last.maxLoad || null, reps: range.top + 1, sets: wantSets },
        lastSummary: lastSummary,
        coaching: 'You owned every set at the top of the range. Add reps beyond ' +
          range.top + ', or slow the tempo to keep it honest.'
      };
    }
    return {
      status: 'progress_load',
      target: { weightKg: next, reps: range.low, sets: wantSets },
      lastSummary: lastSummary,
      coaching: 'You maxed the rep range at ' + last.maxLoad + 'kg. Move to ' + next +
        'kg and rebuild from ' + range.low + ' reps. New weight, fresh climb.'
    };
  }

  /* 2) Stalled: same top load for several sessions with no rep progress. */
  if (ordered.length >= cfg.stallSessions) {
    const recent = ordered.slice(0, cfg.stallSessions).map(function (s) { return summarise(s, prescription); });
    const sameLoad = recent.every(function (r) { return r.maxLoad != null && r.maxLoad === last.maxLoad; });
    const noneTopped = recent.every(function (r) {
      return !(r.reps.length && r.reps.every(function (v) { return v >= range.top; }));
    });
    // newest is recent[0], oldest of the window is the last entry
    const noRepGain = recent[0].totalReps <= recent[recent.length - 1].totalReps;
    if (sameLoad && noneTopped && noRepGain) {
      const deload = roundHalf(last.maxLoad * (1 - cfg.deloadPct));
      return {
        status: 'stalled',
        target: { weightKg: deload, reps: range.low, sets: wantSets },
        lastSummary: lastSummary,
        coaching: cfg.stallSessions + ' sessions stuck at ' + last.maxLoad + 'kg. Drop to ' +
          deload + 'kg, sharpen your form, then climb again with momentum.'
      };
    }
  }

  /* 3) Otherwise hold the weight and chase one more rep. */
  const nextReps = Math.min(range.top, last.topSetReps + 1) || range.low;
  const softened = lastRpe != null && lastRpe >= cfg.highRpe;
  return {
    status: 'hold',
    target: { weightKg: last.maxLoad, reps: nextReps, sets: wantSets },
    lastSummary: lastSummary,
    coaching: softened
      ? 'That last set was near maximal at ' + last.maxLoad + 'kg. Stay here, keep the reps, and let it feel easier before you push.'
      : 'Same ' + last.maxLoad + 'kg today. Add one rep per set. Hit ' + range.top +
        ' on every working set to unlock the next load bump.'
  };
}

export default { computeTarget };
