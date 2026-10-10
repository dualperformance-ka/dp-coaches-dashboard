function activityKey(activity) {
  if (activity && activity.id !== undefined && activity.id !== null) return String(activity.id);
  return [
    String(activity && (activity.start_date_local || activity.start_date) || '').slice(0, 19),
    String(activity && activity.distance || ''),
    String(activity && (activity.moving_time || activity.elapsed_time) || ''),
    String(activity && activity.name || ''),
  ].join('|');
}

function numericKm(value) {
  var n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 200 ? n : 0;
}

function plannedDistance(session, opts) {
  if (opts && typeof opts.plannedRunKm === 'function') return numericKm(opts.plannedRunKm(session));
  if (opts && opts.plannedKm !== undefined) return numericKm(opts.plannedKm);
  return numericKm(session && (session.plannedKm ?? session.distance_km ?? session.distanceKm));
}

function toKeySet(value) {
  if (value instanceof Set) return new Set(Array.from(value, String));
  if (Array.isArray(value)) return new Set(value.map(String));
  if (value && typeof value === 'object') {
    return new Set(Object.keys(value).filter(function (key) { return value[key]; }).map(String));
  }
  return new Set();
}

function rejectedKeys(session, opts) {
  var direct = toKeySet(opts && opts.rejectedActivityIds);
  var all = opts && opts.rejections;
  var sessionId = session && session.id !== undefined ? String(session.id) : '';
  if (!all || !sessionId) return direct;
  var stored = all[sessionId];
  toKeySet(stored).forEach(function (key) { direct.add(key); });
  return direct;
}

// Seed only. A future per-athlete calibration can replace this through
// opts.relativeEffortPerKmThreshold without changing the matching rules.
export const DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD = 3.0;
export const UNDERRUN_TOLERANCE_PERCENT = 0.15;
export const MIN_DISTANCE_TOLERANCE_KM = 1.5;
export const MULTI_RUN_MAX_GAP_MINUTES = 45;

function activityStartMs(activity) {
  var raw = activity && (activity.start_date_local || activity.start_date);
  var parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function activityEndMs(activity) {
  var start = activityStartMs(activity);
  if (start === null) return null;
  var seconds = Number(activity && (activity.elapsed_time || activity.moving_time));
  return start + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0);
}

/**
 * Build the single activity-shaped value consumed by the existing log/UI code.
 * The source ids stay attached so every constituent run can be claimed and the
 * group can be reconstructed from fresh Strava data on the next portal load.
 */
export function combineStravaActivities(activities) {
  var source = (Array.isArray(activities) ? activities : []).filter(Boolean).slice();
  if (!source.length) return null;
  if (source.length === 1) return source[0];
  source.sort(function (a, b) {
    var aStart = activityStartMs(a), bStart = activityStartMs(b);
    if (aStart !== null && bStart !== null && aStart !== bStart) return aStart - bStart;
    return activityKey(a).localeCompare(activityKey(b));
  });
  var keys = source.map(activityKey);
  var distance = 0, moving = 0, elapsed = 0, effort = 0, allEffortKnown = true;
  source.forEach(function (activity) {
    var distanceM = Number(activity && activity.distance);
    var movingSeconds = Number(activity && activity.moving_time);
    var elapsedSeconds = Number(activity && activity.elapsed_time);
    if (Number.isFinite(distanceM) && distanceM > 0) distance += distanceM;
    if (Number.isFinite(movingSeconds) && movingSeconds > 0) moving += movingSeconds;
    if (Number.isFinite(elapsedSeconds) && elapsedSeconds > 0) elapsed += elapsedSeconds;
    var value = activityEffort(activity);
    if (value === null) allEffortKnown = false;
    else effort += value;
  });
  return {
    id: 'group:' + keys.join('+'),
    name: source.length + ' linked Strava runs',
    type: 'Run',
    sport_type: 'Run',
    start_date: source[0].start_date,
    start_date_local: source[0].start_date_local || source[0].start_date,
    distance: distance,
    moving_time: moving,
    elapsed_time: elapsed || moving,
    suffer_score: allEffortKnown ? effort : null,
    source_activity_ids: keys,
    source_activity_count: source.length,
    // Used only during this in-memory match. slimStravaActivity deliberately
    // drops it so detailed payloads are never copied into the saved log blob.
    _sourceActivities: source,
  };
}

export function stravaMatchActivityKeys(match) {
  var explicit = match && match.activityKeys;
  if (Array.isArray(explicit) && explicit.length) return explicit.map(String);
  var source = match && match.activity && match.activity.source_activity_ids;
  if (Array.isArray(source) && source.length) return source.map(String);
  return match && match.activity ? [activityKey(match.activity)] : [];
}

function addPrescriptionValue(parts, value) {
  if (typeof value === 'string' && value.trim()) parts.push(value.trim());
}

function addPrescriptionObject(parts, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.values(value).forEach(function (item) { addPrescriptionValue(parts, item); });
}

export function classifyPrescribedIntensity(session) {
  session = session || {};
  var parts = [];
  [
    session.name, session.title, session.type, session.sessionType, session.intensity,
    session.runningSession, session.runDetails, session.resolvedName,
    session.resolvedType, session.resolvedIntensity, session.resolvedDescription,
  ].forEach(function (value) { addPrescriptionValue(parts, value); });
  addPrescriptionObject(parts, session.coachOverride || session.override);
  addPrescriptionObject(parts, session.resolvedMeta || session.meta);
  var text = parts.join(' ').toLowerCase();
  // Strides are not intervals. They are the standard finish to an easy run, and
  // the coach note that prescribes them ("finish with 4-6 × 20s strides") looks
  // exactly like rep notation to the regex below — which flagged every easy run
  // carrying that note as an under-run quality session. A 10 km easy run with
  // strides came back at 1.55 effort/km against a 3.0 threshold, so the flag was
  // guaranteed, not marginal.
  //
  // Remove the stride phrase and any rep count attached to it before
  // classifying. Genuine work in the same note still counts: strip only the
  // strides, never the whole sentence.
  var STRIDE_PHRASE = /(?:\b\d+\s*(?:[-–—]\s*\d+)?\s*[x×]\s*\d+\s*(?:s|sec|secs|seconds|m|min|mins)?\s*)?(?:\bhill\s+)?\bstrides?\b/gi;
  var classifiable = text.replace(STRIDE_PHRASE, ' ');
  var repNotation = /\b\d+\s*[x×]\s*\d+(?:\.\d+)?\s*(?:km|m|s|sec|secs|seconds|min|mins|minutes)?\b/i;
  var quality = /\b(?:tempo|threshold|intervals?|reps?|repeats?|hill|fartlek|track|race)\b|\btime[ -]?trial\b/i;
  var easy = /\b(?:easy|recovery|steady|shakeout)\b|\blong\s+run\b/i;
  if (repNotation.test(classifiable) || quality.test(classifiable)) return 'quality';
  if (easy.test(text)) return 'easy';
  return 'unknown';
}

/**
 * Strava's REST field for what the UI calls "Relative Effort" is `suffer_score`.
 * `relative_effort` has never been a field on the REST SummaryActivity — it is
 * what Strava's own MCP returns — so reading only that name yielded undefined on
 * every activity, which silently disabled every check built on top of it:
 * intensity_below_prescription and ran_above_prescription were both dead code.
 * Read the REST name first and keep the other as a fallback, so a payload from
 * either source works.
 *
 * Exported because "which field carries effort" is exactly the kind of thing
 * that breaks silently, and a test should be able to pin it.
 */
export function activityEffort(activity) {
  var raw = activity && (activity.suffer_score != null ? activity.suffer_score : activity.relative_effort);
  var effort = Number(raw);
  return Number.isFinite(effort) && effort > 0 ? effort : null;
}

/**
 * Returns null for "cannot tell", which is NOT the same as "easy".
 *
 * suffer_score is heart-rate derived, so it is legitimately absent for any
 * athlete who runs without a strap. Treating that absence as 'easy' would flag
 * every one of their quality sessions as under-run, so an unknown effort leaves
 * the match confidence untouched.
 */
function classifyExecutedIntensity(activity, threshold) {
  // Bracket access is intentional: this is transient matcher state, not a
  // field that slimStravaActivity should preserve in the saved log payload.
  var source = activity && activity['_sourceActivities'];
  if (Array.isArray(source) && source.length > 1) {
    var classifications = source.map(function (item) {
      return classifyExecutedIntensity(item, threshold);
    });
    // A warm-up and cool-down should not dilute the quality block until the
    // portal calls the whole prescribed session "easy". If any constituent
    // run clearly contains quality work, the grouped execution contains it.
    if (classifications.indexOf('quality') >= 0) return 'quality';
    if (classifications.indexOf('easy') >= 0) return 'easy';
    return null;
  }
  var effort = activityEffort(activity);
  var distanceKm = Number(activity && activity.distance) / 1000;
  if (effort === null || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  return effort / distanceKm >= threshold ? 'quality' : 'easy';
}

export function matchSwimActivityToSession(session, activities, opts = {}) {
  return matchActivityBySportToSession(session, activities, opts, 'swim');
}

export function matchRideActivityToSession(session, activities, opts = {}) {
  return matchActivityBySportToSession(session, activities, opts, 'ride');
}

/**
 * Match one planned run to the closest eligible Strava activity or linked
 * group of activities. Consecutive same-day runs may be combined when the next
 * one starts no more than 45 minutes after the previous one ends. This covers
 * the common warm-up / quality block / cool-down recording pattern.
 *
 * Pure in/pure out: callers supply the planned distance plus already-claimed
 * and rejected activity ids through opts. No inputs are mutated.
 */
export function matchActivityToSession(session, activities, opts = {}) {
  var reasons = [];
  var sessionDate = String(session && (session.date || session.plannedDate) || '').slice(0, 10);
  if (!sessionDate) return { matched: false, reasons: ['missing_session_date'] };

  var plannedKm = plannedDistance(session, opts);
  var confidence = plannedKm ? 'high' : 'low';
  var underToleranceKm = plannedKm ? Math.max(plannedKm * UNDERRUN_TOLERANCE_PERCENT, MIN_DISTANCE_TOLERANCE_KM) : null;
  var claimed = toKeySet(opts.claimedActivityIds || opts.claimedActivities);
  var rejected = rejectedKeys(session, opts);
  var eligible = [];

  (Array.isArray(activities) ? activities : []).forEach(function (activity) {
    var type = String(activity && (activity.sport_type || activity.type) || '');
    if (type.toLowerCase().indexOf('run') < 0) { reasons.push('not_run'); return; }

    var activityDate = String(activity && (activity.start_date_local || activity.start_date) || '').slice(0, 10);
    if (activityDate !== sessionDate) { reasons.push('date_mismatch'); return; }

    var key = activityKey(activity);
    if (claimed.has(key)) { reasons.push('already_claimed'); return; }
    if (rejected.has(key)) { reasons.push('rejected'); return; }
    eligible.push({ activity: activity, key: key, startMs: activityStartMs(activity), endMs: activityEndMs(activity) });
  });

  eligible.sort(function (a, b) {
    if (a.startMs !== null && b.startMs !== null && a.startMs !== b.startMs) return a.startMs - b.startMs;
    return a.key.localeCompare(b.key);
  });

  var candidates = [];
  function addCandidate(source) {
    var activity = combineStravaActivities(source.map(function (item) { return item.activity; }));
    if (!activity) return;
    var key = activityKey(activity);
    if (rejected.has(key)) { reasons.push('rejected'); return; }
    var distanceKm = Number(activity.distance) / 1000;
    var distanceDeltaKm = distanceKm - plannedKm;
    // A run may exceed the prescription by any amount and still complete it.
    // Keep the lower bound so short runs and commutes do not claim the session.
    if (plannedKm && (!Number.isFinite(distanceKm) || distanceKm < 0 || distanceDeltaKm < -underToleranceKm - 1e-9)) {
      reasons.push('distance_outside_tolerance');
      return;
    }
    candidates.push({
      activity: activity,
      activities: source.map(function (item) { return item.activity; }),
      activityKeys: source.map(function (item) { return item.key; }),
      key: key,
      distanceKm: distanceKm,
    });
  }

  eligible.forEach(function (item) { addCandidate([item]); });

  // Only a distance-bearing prescription needs aggregation. Open runs keep the
  // old, conservative one-activity behaviour instead of swallowing every run
  // an athlete happened to record that day.
  if (plannedKm) {
    var configuredGap = Number(opts.multiRunMaxGapMinutes);
    var gapMinutes = Number.isFinite(configuredGap) && configuredGap >= 0
      ? configuredGap
      : MULTI_RUN_MAX_GAP_MINUTES;
    var gapMs = gapMinutes * 60 * 1000;
    for (var start = 0; start < eligible.length; start += 1) {
      var group = [eligible[start]];
      for (var next = start + 1; next < eligible.length; next += 1) {
        var previous = eligible[next - 1];
        var current = eligible[next];
        if (previous.endMs === null || current.startMs === null || current.startMs - previous.endMs > gapMs) break;
        group.push(current);
        addCandidate(group);
      }
    }
  }

  if (!candidates.length) return { matched: false, reasons: Array.from(new Set(reasons)) };
  candidates.sort(function (a, b) {
    if (plannedKm) {
      var delta = Math.abs(a.distanceKm - plannedKm) - Math.abs(b.distanceKm - plannedKm);
      if (delta) return delta;
    }
    // On an exact tie, the smaller claim is safer: this preserves two genuine
    // same-day sessions instead of needlessly consuming both activities.
    if (a.activityKeys.length !== b.activityKeys.length) return a.activityKeys.length - b.activityKeys.length;
    return a.key.localeCompare(b.key);
  });
  var selectedCandidate = candidates[0];
  var selected = selectedCandidate.activity;
  var threshold = Number(opts.relativeEffortPerKmThreshold);
  if (!Number.isFinite(threshold) || threshold <= 0) threshold = DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD;
  var prescribed = opts.prescribedIntensity || classifyPrescribedIntensity(session);
  var executed = classifyExecutedIntensity(selected, threshold);
  var matchReasons = [];
  if (prescribed === 'quality' && executed === 'easy') {
    confidence = 'low';
    matchReasons.push('intensity_below_prescription');
  } else if (prescribed === 'easy' && executed === 'quality') {
    matchReasons.push('ran_above_prescription');
  }
  return {
    matched: true,
    activity: selected,
    activities: selectedCandidate.activities,
    activityKeys: selectedCandidate.activityKeys,
    confidence: confidence,
    reasons: matchReasons,
  };
}

/**
 * Match a same-day Strava swim to a scheduled swim session. Swim plans in this
 * portal often prescribe technique rather than a fixed distance, so sport and
 * date are the reliable signals. Auto-complete only when there is one eligible
 * swim and one pending swim session that day; ambiguous cases require a tap.
 */
function matchActivityBySportToSession(session, activities, opts, sport) {
  var sessionDate = String(session && (session.date || session.plannedDate) || '').slice(0, 10);
  if (!sessionDate) return { matched: false, reasons: ['missing_session_date'] };
  var claimed = toKeySet(opts.claimedActivityIds || opts.claimedActivities);
  var rejected = rejectedKeys(session, opts);
  var eligible = [];
  var reasons = [];
  (Array.isArray(activities) ? activities : []).forEach(function (activity) {
    var type = String(activity && (activity.sport_type || activity.type) || '').toLowerCase();
    var isSport = sport === 'swim' ? type.indexOf('swim') >= 0 : /ride|bike|cycl/.test(type);
    if (!isSport) { reasons.push('not_' + sport); return; }
    var activityDate = String(activity && (activity.start_date_local || activity.start_date) || '').slice(0, 10);
    if (activityDate !== sessionDate) { reasons.push('date_mismatch'); return; }
    var key = activityKey(activity);
    if (claimed.has(key)) { reasons.push('already_claimed'); return; }
    if (rejected.has(key)) { reasons.push('rejected'); return; }
    eligible.push({ activity: activity, key: key });
  });
  if (!eligible.length) return { matched: false, reasons: Array.from(new Set(reasons)) };
  eligible.sort(function (a, b) {
    return String(a.activity.start_date_local || a.activity.start_date || '').localeCompare(
      String(b.activity.start_date_local || b.activity.start_date || '')
    );
  });
  var selected = eligible[0];
  return {
    matched: true,
    activity: selected.activity,
    activities: [selected.activity],
    activityKeys: [selected.key],
    confidence: eligible.length === 1 && Number(opts.sessionCount || 1) === 1 ? 'high' : 'low',
    reasons: eligible.length > 1 || Number(opts.sessionCount || 1) > 1 ? ['ambiguous_' + sport + '_match'] : [],
  };
}

export { activityKey as stravaActivityKey };

if (typeof window !== 'undefined') {
  window.matchActivityToSession = matchActivityToSession;
  window.matchSwimActivityToSession = matchSwimActivityToSession;
  window.matchRideActivityToSession = matchRideActivityToSession;
  window.stravaActivityKey = activityKey;
  window.stravaMatchActivityKeys = stravaMatchActivityKeys;
  window.combineStravaActivities = combineStravaActivities;
  window.classifyPrescribedIntensity = classifyPrescribedIntensity;
}
