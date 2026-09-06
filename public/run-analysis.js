/**
 * run-analysis.js
 * ---------------------------------------------------------------------------
 * Endurance analysis the dashboard could not previously do. Every function here
 * is pure and derives from data the product already stores:
 *
 *   run_steps                    coach's prescribed interval structure
 *   athlete_activity_uploads     the athlete's own FIT/TCX/GPX laps and splits
 *   training_session_logs        the portal's free-text run log
 *   planned_sessions             distance, target pace and session type
 *
 * Nothing here reads strava_activities: the coaches dashboard is not permitted
 * to display Strava API data, and everything below works from athlete-consented
 * uploads and submitted portal logs instead.
 *
 * Loaded as a module so it can be imported directly by tests; it also publishes
 * itself on window for the dashboard's classic-script render code.
 */

// ── Pace ─────────────────────────────────────────────────────────────────────
// Coaches write paces as free text ("4:00", "4:00 /km", "4:00-4:10", "sub 4").
// Anything that does not contain a m:ss is not a pace and must not become one.

export function paceToSeconds(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/(\d{1,2}):([0-5]\d)/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function secondsToPace(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// A target may be a single pace or a band. A band is what a coach usually means
// even when they write one number, so `tolerance` widens a single value.
export function paceTarget(step, tolerance = 0) {
  const min = paceToSeconds(step?.pace_min ?? step?.paceMin);
  const max = paceToSeconds(step?.pace_max ?? step?.paceMax);
  if (min == null && max == null) return null;
  const low = min ?? max;
  const high = max ?? min;
  return {
    low: Math.min(low, high) - tolerance,
    high: Math.max(low, high) + tolerance,
    nominal: (Math.min(low, high) + Math.max(low, high)) / 2,
    isBand: min != null && max != null && min !== max,
  };
}

// ── Run log parsing ──────────────────────────────────────────────────────────
// The portal writes run logs as flat "Key: value | Key: value" text. This is the
// only structured data the dashboard has for a portal-logged (as opposed to
// file-uploaded) run.

export function parseRunLog(text) {
  const source = String(text ?? '');
  if (!source.trim()) return null;

  const fields = {};
  for (const part of source.split('|')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    // "Time: 41:12" — split on the FIRST colon only, or the clock is lost.
    fields[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }

  const num = key => {
    const raw = fields[key];
    if (raw == null) return null;
    const value = parseFloat(String(raw).replace(/[^\d.]/g, ''));
    return Number.isFinite(value) ? value : null;
  };

  const distanceKm = num('distance');
  const durationSec = (() => {
    const raw = fields.time || fields.duration || '';
    const hms = String(raw).match(/(?:(\d+):)?(\d{1,2}):([0-5]\d)/);
    if (!hms) {
      const mins = num('time') ?? num('duration');
      return mins != null ? Math.round(mins * 60) : null;
    }
    const [, h, m, s] = hms;
    return (Number(h || 0) * 3600) + (Number(m) * 60) + Number(s);
  })();

  // Prefer the athlete's own pace; fall back to distance over time so a log with
  // both halves still yields one.
  const paceSecPerKm = paceToSeconds(fields.pace)
    ?? (distanceKm > 0 && durationSec > 0 ? Math.round(durationSec / distanceKm) : null);

  return {
    distanceKm,
    durationSec,
    paceSecPerKm,
    rpe: num('rpe'),
    feel: num('feel'),
    fields,
  };
}

// ── Prescribed vs actual ─────────────────────────────────────────────────────

// run_steps is a tree: a `repeat` block carries repeat_count and children.
// Flattening expands it into the sequence the athlete actually ran, which is
// what a lap list can be compared against.
export function flattenRunSteps(steps) {
  const rows = Array.isArray(steps) ? [...steps] : [];
  const byParent = new Map();
  for (const step of rows) {
    const parent = step.parent_step_id || null;
    byParent.set(parent, (byParent.get(parent) || []).concat(step));
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));
  }

  const out = [];
  const walk = (parentId, repeatIndex, depth) => {
    if (depth > 4) return;  // the schema allows one level; this is a cycle guard
    for (const step of byParent.get(parentId) || []) {
      if (step.step_type === 'repeat') {
        const count = Math.max(1, Number(step.repeat_count) || 1);
        for (let i = 1; i <= count; i += 1) walk(step.id, i, depth + 1);
        continue;
      }
      out.push({
        id: step.id,
        type: step.step_type,
        repeatIndex,
        distanceKm: step.distance_km != null ? Number(step.distance_km) : null,
        durationSec: step.duration_sec != null ? Number(step.duration_sec) : null,
        target: paceTarget(step),
        rpe: step.rpe != null ? Number(step.rpe) : null,
        instructions: step.instructions || null,
        label: stepLabel(step, repeatIndex),
      });
    }
  };
  walk(null, null, 0);
  return out;
}

function stepLabel(step, repeatIndex) {
  const kind = String(step.step_type || 'run');
  const name = kind === 'warmup' ? 'Warm up'
    : kind === 'cooldown' ? 'Cool down'
    : kind === 'recovery' ? 'Recovery'
    : kind === 'rest' ? 'Rest'
    : kind === 'interval' ? 'Interval'
    : 'Run';
  const distance = step.distance_km != null ? `${step.distance_km}km` : null;
  const parts = [name, distance].filter(Boolean);
  return repeatIndex ? `${parts.join(' ')} · rep ${repeatIndex}` : parts.join(' ');
}

// Work steps are what a coach is actually judging. Recoveries and rests are
// context: an athlete jogging a recovery slowly is not a missed target.
const WORK_STEPS = new Set(['run', 'interval']);

export function isWorkStep(step) {
  return WORK_STEPS.has(step.type);
}

// Devices auto-lap every kilometre unless the athlete presses lap. A list of
// near-identical 1km laps is a distance readout, not a record of the session's
// structure, and matching prescribed intervals onto it would invent precision.
export function lapsAreStructured(laps) {
  const list = (laps || []).filter(lap => Number(lap?.distanceM) > 0);
  if (list.length < 2) return false;
  const full = list.slice(0, -1);  // the last lap is usually a partial remainder
  return full.some(lap => Math.abs(Number(lap.distanceM) - 1000) > 120);
}

function lapPaceSec(lap) {
  const speed = Number(lap?.avgSpeedMps);
  if (Number.isFinite(speed) && speed > 0) return Math.round(1000 / speed);
  const distance = Number(lap?.distanceM);
  const time = Number(lap?.movingTimeS ?? lap?.elapsedTimeS);
  if (distance > 0 && time > 0) return Math.round(time / (distance / 1000));
  return null;
}

/**
 * Line the coach's prescription up against the athlete's laps.
 *
 * Returns a `mode` rather than pretending every session can be matched:
 *   steps    every work step has a lap; the per-interval table is trustworthy
 *   session  a comparison exists but not per interval; show session totals
 *   none     nothing to compare
 *
 * `confidence` is reported so the UI can say how the match was made instead of
 * presenting an inferred pairing as fact.
 */
export function matchLapsToSteps(steps, laps, options = {}) {
  const flat = flattenRunSteps(steps);
  const work = flat.filter(isWorkStep);
  const usable = (laps || []).filter(lap => Number(lap?.distanceM) > 0);

  if (!work.length || !usable.length) {
    return { mode: 'none', confidence: 'none', rows: [], work, unmatchedLaps: usable.length };
  }
  if (!lapsAreStructured(usable)) {
    return {
      mode: 'session',
      confidence: 'auto-lap',
      reason: 'The device auto-lapped every kilometre, so the laps do not carry the session structure.',
      rows: [],
      work,
      unmatchedLaps: usable.length,
    };
  }

  // Work laps are those close in distance to a prescribed work step. Matching on
  // distance rather than position survives an extra warm-up or cool-down lap.
  const tolerance = Number(options.distanceToleranceKm ?? 0.25);
  const targets = work.map(step => step.distanceKm).filter(km => km > 0);
  const nominal = targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null;

  const workLaps = nominal
    ? usable.filter(lap => Math.abs(Number(lap.distanceM) / 1000 - nominal) <= tolerance)
    : usable;

  if (workLaps.length !== work.length) {
    return {
      mode: 'session',
      confidence: 'lap-count-mismatch',
      reason: `Prescribed ${work.length} work step${work.length === 1 ? '' : 's'} but found ${workLaps.length} matching lap${workLaps.length === 1 ? '' : 's'}.`,
      rows: [],
      work,
      unmatchedLaps: usable.length - workLaps.length,
    };
  }

  const rows = work.map((step, index) => {
    const lap = workLaps[index];
    const actual = lapPaceSec(lap);
    const target = step.target;
    let delta = null;
    let status = 'unknown';
    if (actual != null && target) {
      // Inside the band is on target; outside is signed against the near edge so
      // "+4s" always means four seconds slower than the coach asked for.
      if (actual < target.low) { delta = actual - target.low; status = 'faster'; }
      else if (actual > target.high) { delta = actual - target.high; status = 'slower'; }
      else { delta = 0; status = 'on'; }
    }
    return {
      step,
      lap,
      distanceKm: Number(lap.distanceM) / 1000,
      actualPaceSec: actual,
      targetPaceSec: target ? target.nominal : null,
      target,
      deltaSec: delta,
      status,
      avgHr: lap.avgHr ?? null,
      avgCadence: lap.avgCadence ?? null,
    };
  });

  const compared = rows.filter(row => row.deltaSec != null);
  const drift = compared.length >= 2
    ? compared[compared.length - 1].actualPaceSec - compared[0].actualPaceSec
    : null;

  return {
    mode: 'steps',
    confidence: 'matched',
    rows,
    work,
    unmatchedLaps: usable.length - workLaps.length,
    summary: {
      onTarget: rows.filter(row => row.status === 'on').length,
      total: rows.length,
      avgDeltaSec: compared.length
        ? Math.round(compared.reduce((sum, row) => sum + row.deltaSec, 0) / compared.length)
        : null,
      // Positive drift means the athlete faded across the set.
      driftSec: drift,
    },
  };
}

// ── Weekly load ──────────────────────────────────────────────────────────────

/**
 * Adds a rolling baseline to the programme volume weeks the dashboard already
 * builds. The 4-week average is the number a coach compares this week against,
 * and the one that turns "68km" into "68km, 34% above her baseline".
 *
 * Only completed weeks feed the baseline: including the current partial week
 * would drag it down every Monday and fire a spike on every Friday.
 */
export function weeklyLoad(weeks, options = {}) {
  const window = Math.max(1, Number(options.window ?? 4));
  const spikeThreshold = Number(options.spikeThreshold ?? 0.25);
  const list = Array.isArray(weeks) ? weeks : [];

  return list.map((week, index) => {
    const history = list
      .slice(Math.max(0, index - window), index)
      .filter(w => w.actual != null && w.actual > 0)
      .map(w => w.actual);

    const rolling = history.length
      ? Math.round((history.reduce((a, b) => a + b, 0) / history.length) * 10) / 10
      : null;

    const deltaPct = rolling && week.actual != null
      ? Math.round(((week.actual - rolling) / rolling) * 100)
      : null;

    const adherencePct = week.planned > 0 && week.actual != null
      ? Math.round((week.actual / week.planned) * 100)
      : null;

    return {
      ...week,
      rolling,
      rollingWeeks: history.length,
      deltaPct,
      adherencePct,
      // A spike needs a real baseline behind it, so a second training week can
      // never "spike" against a single prior week.
      isSpike: deltaPct != null && history.length >= 2 && deltaPct >= spikeThreshold * 100,
      isDrop: deltaPct != null && history.length >= 2 && deltaPct <= -spikeThreshold * 100,
    };
  });
}

// ── Session type ─────────────────────────────────────────────────────────────
// Which work an athlete skips matters more than how much: three easy runs missed
// is a different conversation from three threshold sessions missed.

const TYPE_GROUPS = [
  { key: 'long', label: 'Long run', match: /long/i },
  { key: 'quality', label: 'Threshold / intervals', match: /tempo|threshold|interval|speed|race/i },
  { key: 'easy', label: 'Easy / recovery', match: /easy|recovery|steady|run$/i },
  { key: 'strength', label: 'Strength', match: /strength|lift|gym|upper|lower|push|pull/i },
];

export function classifySession(name, type) {
  const text = `${type || ''} ${name || ''}`.trim();
  if (!text) return 'other';
  for (const group of TYPE_GROUPS) {
    if (group.match.test(text)) return group.key;
  }
  return 'other';
}

export function typeLabel(key) {
  return TYPE_GROUPS.find(group => group.key === key)?.label || 'Other';
}

/**
 * Adherence broken down by what the session was for.
 * `planned` rows need { date, name, type }; `isDone` decides completion so the
 * caller keeps ownership of the completed-vs-submitted distinction.
 */
export function adherenceByType(planned, isDone) {
  const buckets = new Map();
  for (const row of planned || []) {
    const key = classifySession(row.name, row.type);
    const bucket = buckets.get(key) || { key, label: typeLabel(key), planned: 0, done: 0, missed: [] };
    bucket.planned += 1;
    if (isDone(row)) bucket.done += 1;
    else bucket.missed.push(row.date);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map(bucket => ({
      ...bucket,
      pct: bucket.planned ? Math.round((bucket.done / bucket.planned) * 100) : null,
    }))
    .sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));
}

// ── Progression ──────────────────────────────────────────────────────────────

/**
 * One point per week for a given session group — the longest long run, or the
 * average working pace across that week's quality sessions. This is where
 * fitness change actually shows, and neither view existed before.
 */
export function progressionSeries(sessions, group, options = {}) {
  const metric = options.metric || (group === 'long' ? 'distance' : 'pace');
  const byWeek = new Map();

  for (const session of sessions || []) {
    if (classifySession(session.name, session.type) !== group) continue;
    if (!session.date) continue;
    const monday = mondayOf(session.date);
    const bucket = byWeek.get(monday) || { week: monday, values: [], sessions: 0 };
    const value = metric === 'distance' ? session.distanceKm : session.paceSecPerKm;
    if (value != null && Number.isFinite(value) && value > 0) bucket.values.push(value);
    bucket.sessions += 1;
    byWeek.set(monday, bucket);
  }

  return [...byWeek.values()]
    .filter(bucket => bucket.values.length)
    .map(bucket => ({
      week: bucket.week,
      sessions: bucket.sessions,
      // The longest run is the point for distance; the mean is the point for
      // pace, because one hard rep should not define the week.
      value: metric === 'distance'
        ? Math.max(...bucket.values)
        : Math.round(bucket.values.reduce((a, b) => a + b, 0) / bucket.values.length),
      metric,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

export function mondayOf(dateText) {
  const date = new Date(`${String(dateText).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(dateText).slice(0, 10);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return date.toISOString().slice(0, 10);
}

// Simple linear trend, used to say "getting faster" or "holding" without
// implying more precision than a handful of weekly points can support.
export function trendOf(series) {
  const points = (series || []).filter(p => Number.isFinite(p.value));
  if (points.length < 3) return { direction: 'flat', changePerWeek: null, confident: false };
  const n = points.length;
  const meanX = (n - 1) / 2;
  const meanY = points.reduce((sum, p) => sum + p.value, 0) / n;
  let num = 0;
  let den = 0;
  points.forEach((p, i) => {
    num += (i - meanX) * (p.value - meanY);
    den += (i - meanX) ** 2;
  });
  const slope = den ? num / den : 0;
  const magnitude = Math.abs(slope);
  return {
    direction: magnitude < 0.5 ? 'flat' : slope > 0 ? 'up' : 'down',
    changePerWeek: Math.round(slope * 10) / 10,
    confident: n >= 5,
  };
}

const api = {
  paceToSeconds, secondsToPace, paceTarget,
  parseRunLog,
  flattenRunSteps, isWorkStep, lapsAreStructured, matchLapsToSteps,
  weeklyLoad,
  classifySession, typeLabel, adherenceByType,
  progressionSeries, mondayOf, trendOf,
};

if (typeof window !== 'undefined') window.DP_RUN = api;
export default api;
