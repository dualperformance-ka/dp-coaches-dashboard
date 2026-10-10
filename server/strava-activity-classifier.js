// Every Strava activity an athlete shared, classified against their programme.
//
// PURE. Rows in, classification out: no database, no clock, no network. The
// loader (server/coach-strava-activities.js) fetches; this decides. That split
// is what lets tests/strava-all-activities.test.js pin every rule below without
// a stub server.
//
// What it answers, per activity and per programmed session:
//
//   programmed     a Strava activity that completed a prescribed session
//   unprogrammed   a Strava activity nobody prescribed. Additional work, NOT a
//                  compliance failure: it never enters the compliance maths
//   needs_review   a plausible pairing the rules will not commit to on their own
//   missed         a prescribed session whose day has ended, with no matching
//                  activity and no other completion record, once sync is current
//   awaiting_sync  as missed, except Strava may simply not have delivered yet
//   upcoming       a prescribed session that is today or later
//
// MATCHING REUSES THE PORTAL. Runs, rides and swims go through the athlete
// portal's own matcher (public/js/strava-match.js, kept byte-identical to the
// portal's copy) with the portal's tolerances, claim rules and greedy order
// (refreshStravaSessionMatches in the portal's 09-logging.js). A coach must see
// the pairing the athlete saw. The only rules added here are coach-side and
// only ever make a match LESS certain, never more:
//   - a quality prescription met by an activity the athlete NAMED easy or
//     recovery is sent to review (distance alone cannot prove the workout)
//   - a quality prescription with no effort data is completed, but flagged
//     structure_unverified so the UI never implies the intervals were run
//   - strength sessions, which the portal does not match at all, pair with a
//     same-day weight-training activity, and anything ambiguous goes to review
//
// Order of authority for a session's activity:
//   1. coach confirmation (strava_activity_reviews)
//   2. the athlete's own recorded match (athlete_data.logs[key].__stravaMatch)
//   3. automatic matching
// A rejection by either the coach or the athlete removes that pair from every
// step, permanently, until someone clears it.

import {
  addDaysISO,
  classifySession,
  isRestSession,
  plannedKmFromRow,
  round,
  sessionKeyFor,
  sportForLogRow,
  toIsoDate,
} from './performance-summary-core.js';
import {
  activityEffort,
  classifyPrescribedIntensity,
  matchActivityToSession,
  matchRideActivityToSession,
  matchSwimActivityToSession,
  stravaActivityKey,
} from '../public/js/strava-match.js';

export const CLASSIFIER_VERSION = 1;

// ── SPORT FAMILIES ───────────────────────────────────────────────────────────
//
// Strava sport_type → the family the coach filters and totals by. Anything not
// listed is 'other' and still counts toward overall training time.

const FAMILY_BY_TYPE = {
  run: 'running', trailrun: 'running', virtualrun: 'running',
  ride: 'cycling', virtualride: 'cycling', mountainbikeride: 'cycling', gravelride: 'cycling',
  ebikeride: 'cycling', emountainbikeride: 'cycling', handcycle: 'cycling', velomobile: 'cycling',
  swim: 'swimming',
  weighttraining: 'strength', crossfit: 'strength',
  walk: 'walking', hike: 'walking',
};

export const SPORT_FAMILIES = ['running', 'cycling', 'swimming', 'strength', 'walking', 'other'];

export function sportFamily(sportType) {
  const key = String(sportType || '').toLowerCase().replace(/[^a-z]/g, '');
  if (FAMILY_BY_TYPE[key]) return FAMILY_BY_TYPE[key];
  if (key.includes('run')) return 'running';
  if (key.includes('ride') || key.includes('cycl') || key.includes('bike')) return 'cycling';
  if (key.includes('swim')) return 'swimming';
  return 'other';
}

// A same-day activity of one of these types can stand in for a programmed
// strength session. WeightTraining and Crossfit can auto-complete; a generic
// Workout or HIIT session is only ever proposed for review.
const STRENGTH_CONFIDENT = new Set(['weighttraining', 'crossfit']);
const STRENGTH_POSSIBLE = new Set(['workout', 'highintensityintervaltraining']);

function compactType(activity) {
  return String((activity && (activity.sport_type || activity.type)) || '').toLowerCase().replace(/[^a-z]/g, '');
}

// planned_sessions → the sport the portal's getType() would give it.
function sessionSport(row, context) {
  const type = classifySession(row, context);
  return type === 'other' ? null : type;
}

// ── ACTIVITY NORMALISATION ───────────────────────────────────────────────────

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * strava_activities row → the activity shape the portal matcher reads. Port of
 * rowToActivity (the portal's api/_lib/strava-client.js): the stored summary is
 * the source of truth, the promoted columns fill gaps, and a missing value
 * stays null rather than becoming a 0 that could claim a session.
 */
export function rowToMatcherActivity(row) {
  if (!row) return null;
  const summary = row.summary && typeof row.summary === 'object' ? row.summary : {};
  const id = num(row.strava_activity_id ?? summary.id);
  if (!id || id <= 0) return null;
  const start = String(summary.start_date_local || row.start_date_local || '');
  if (!toIsoDate(start)) return null;
  const effort = activityEffort({ suffer_score: row.suffer_score ?? summary.suffer_score });
  return {
    ...summary,
    id,
    name: summary.name ?? row.name ?? null,
    sport_type: summary.sport_type ?? row.sport_type ?? null,
    type: summary.type ?? row.sport_type ?? null,
    start_date_local: start,
    start_date: summary.start_date ?? start,
    distance: summary.distance ?? num(row.distance_m),
    moving_time: summary.moving_time ?? num(row.moving_time_s),
    elapsed_time: summary.elapsed_time ?? num(row.elapsed_time_s),
    suffer_score: effort,
    relative_effort: effort,
    _syncedAt: row.synced_at || null,
  };
}

const SOURCE_PREFIXES = [
  ['garmin', 'Garmin'], ['wahoo', 'Wahoo'], ['coros', 'COROS'], ['polar', 'Polar'],
  ['suunto', 'Suunto'], ['zwift', 'Zwift'], ['apple', 'Apple Watch'], ['fitbit', 'Fitbit'],
  ['whoop', 'WHOOP'], ['peloton', 'Peloton'],
];

export function activitySource(activity) {
  if (!activity) return 'Strava';
  if (activity.manual === true) return 'Manual entry';
  const device = String(activity.device_name || '').trim();
  if (device) return device.slice(0, 60);
  const external = String(activity.external_id || '').toLowerCase();
  const hit = SOURCE_PREFIXES.find(([prefix]) => external.startsWith(prefix));
  return hit ? hit[1] : 'Strava';
}

/**
 * The ONLY activity fields that leave the server for a coach. An allowlist on
 * purpose: Strava's summary carries the route polyline, start/end coordinates
 * and location strings, and a denylist would let the next new Strava field
 * through by default.
 */
export function coachActivitySummary(activity) {
  const family = sportFamily(activity.sport_type || activity.type);
  const distance = positive(activity.distance);
  const moving = positive(activity.moving_time);
  const speed = positive(activity.average_speed) ?? (distance && moving ? distance / moving : null);
  const start = String(activity.start_date_local || '');
  return {
    id: String(activity.id),
    name: activity.name ? String(activity.name).slice(0, 200) : null,
    sportType: activity.sport_type || activity.type || null,
    sport: family,
    date: toIsoDate(start),
    startTime: /T\d{2}:\d{2}/.test(start) ? start.slice(11, 16) : null,
    distanceM: distance,
    movingTimeS: moving,
    elapsedTimeS: positive(activity.elapsed_time),
    averageSpeedMps: speed ? round(speed, 3) : null,
    paceSecPerKm: family === 'running' && distance && moving ? Math.round(moving / (distance / 1000)) : null,
    averageHeartrate: positive(activity.average_heartrate),
    maxHeartrate: positive(activity.max_heartrate),
    elevationGainM: num(activity.total_elevation_gain),
    averageWatts: positive(activity.average_watts),
    relativeEffort: activityEffort(activity),
    indoor: activity.trainer === true,
    source: activitySource(activity),
    stravaUrl: `https://www.strava.com/activities/${encodeURIComponent(String(activity.id))}`,
  };
}

// ── COACH-SIDE INTENSITY CHECK ───────────────────────────────────────────────

const EASY_NAME = /\b(?:easy|recovery|shake\s?out|jog|z(?:one)?\s?2|aerobic)\b/i;
const QUALITY_NAME = /\b(?:tempo|threshold|intervals?|reps?|repeats?|fartlek|track|race|vo2|hills?)\b|\b\d+\s*[x×]\s*\d/i;

export function activityNameIntensity(activity) {
  const name = String((activity && activity.name) || '');
  if (QUALITY_NAME.test(name)) return 'quality';
  if (EASY_NAME.test(name)) return 'easy';
  return null;
}

function coachIntensityCheck(sessionLike, activity, match) {
  if (!match || !match.matched) return match;
  if (classifyPrescribedIntensity(sessionLike) !== 'quality') return match;
  const reasons = (match.reasons || []).slice();
  let confidence = match.confidence;
  if (activityNameIntensity(activity) === 'easy') {
    confidence = 'low';
    if (!reasons.includes('activity_named_easy')) reasons.push('activity_named_easy');
  } else if (confidence === 'high' && activityEffort(activity) === null) {
    reasons.push('structure_unverified');
  }
  return { ...match, confidence, reasons };
}

// ── STRENGTH (coach-side extension) ──────────────────────────────────────────

function matchStrengthActivity(session, activities, { claimed, rejected, sessionCount }) {
  const eligible = [];
  (activities || []).forEach(activity => {
    const type = compactType(activity);
    if (!STRENGTH_CONFIDENT.has(type) && !STRENGTH_POSSIBLE.has(type)) return;
    if (toIsoDate(activity.start_date_local) !== session.date) return;
    const key = stravaActivityKey(activity);
    if (claimed.has(key) || rejected.has(key)) return;
    eligible.push({ activity, key, confident: STRENGTH_CONFIDENT.has(type) });
  });
  if (!eligible.length) return { matched: false };
  eligible.sort((a, b) => (Number(b.confident) - Number(a.confident)) ||
    String(a.activity.start_date_local).localeCompare(String(b.activity.start_date_local)));
  const pick = eligible[0];
  const unambiguous = eligible.length === 1 && sessionCount === 1;
  const reasons = [];
  if (!pick.confident) reasons.push('generic_workout_type');
  if (!unambiguous) reasons.push('ambiguous_strength_match');
  return {
    matched: true,
    activity: pick.activity,
    activities: [pick.activity],
    activityKeys: [pick.key],
    confidence: pick.confident && unambiguous ? 'high' : 'low',
    reasons,
  };
}

// ── INPUT SHAPING ────────────────────────────────────────────────────────────

function keySet(values) {
  return new Set((values || []).map(String));
}

/** athlete rejections ({sessionKey: [activityKey]}) ∪ coach rejections. */
export function buildRejections(athleteRejections, reviews) {
  const out = {};
  const add = (sessionKey, activityKey) => {
    const k = String(sessionKey || '');
    if (!k || activityKey == null || activityKey === '') return;
    (out[k] = out[k] || new Set()).add(String(activityKey));
  };
  if (athleteRejections && typeof athleteRejections === 'object' && !Array.isArray(athleteRejections)) {
    Object.entries(athleteRejections).forEach(([sessionKey, list]) => {
      (Array.isArray(list) ? list : []).forEach(id => add(sessionKey, id));
    });
  }
  (reviews || []).forEach(review => {
    if (review && review.decision === 'rejected') add(review.session_key, review.strava_activity_id);
  });
  return out;
}

function plannedSession(row, context, reschedules, loggedKeys, library) {
  if (!row || isRestSession(row)) return null;
  const key = sessionKeyFor(row);
  if (!key) return null;
  const sport = sessionSport(row, context);
  if (!sport) return null;
  const override = reschedules && reschedules[key];
  const date = toIsoDate(override) || toIsoDate(row.planned_date);
  if (!date) return null;
  const libraryEntry = library && row.library_id ? library[row.library_id] : null;
  const planned = plannedKmFromRow(row, library);
  return {
    key: String(key),
    id: String(row.id),
    title: String(row.title || 'Session'),
    date,
    plannedDate: toIsoDate(row.planned_date),
    rescheduled: !!(override && toIsoDate(override) !== toIsoDate(row.planned_date)),
    sport,
    plannedKm: sport === 'running' || sport === 'cycling' || sport === 'swimming' ? (planned.km || null) : null,
    plannedKmSource: planned.source,
    plannedMinutes: positive(row.estimated_minutes),
    loggedComplete: loggedKeys.has(String(key)) || String(row.status || '') === 'Completed',
    // What the portal matcher reads to decide prescribed intensity.
    matcher: {
      id: String(key),
      date,
      plannedDate: toIsoDate(row.planned_date),
      name: row.title || '',
      title: row.title || '',
      sessionType: row.session_type || '',
      intensity: row.intensity || '',
      runDetails: row.run_details || '',
      resolvedName: libraryEntry && libraryEntry.name ? libraryEntry.name : '',
      resolvedDescription: libraryEntry && libraryEntry.description ? libraryEntry.description : '',
    },
  };
}

// ── CLASSIFICATION ───────────────────────────────────────────────────────────

/**
 * @param {object} input
 *  activities          strava_activities rows for the athlete (cache rows)
 *  plannedRows         published planned_sessions rows
 *  library             { [library_id]: { distance, name, description } } or null
 *  reschedules         athlete_data 'reschedules' value: { [sessionKey]: 'YYYY-MM-DD' }
 *  logs                athlete_data 'logs' value: { [sessionKey]: { __stravaMatch, ... } }
 *  loggedKeys          Set of bare session keys from session_logs
 *  athleteRejections   athlete_data 'strava_match_rejections' value
 *  reviews             strava_activity_reviews rows
 *  trainingLogs        training_session_logs rows (manual-only completion totals)
 *  structured, gymKeys classifySession context
 *  todayISO            Adelaide local date
 *  range               { startDate, endDate } inclusive local dates
 *  sync                { connected, pendingEvents, lastSyncedDate }
 */
export function classifyAthleteActivities(input = {}) {
  const {
    activities = [], plannedRows = [], library = null, reschedules = {}, logs = {},
    loggedKeys = new Set(), athleteRejections = {}, reviews = [], trainingLogs = [],
    structured = new Map(), gymKeys, todayISO, range, sync = {},
  } = input;
  const startDate = toIsoDate(range && range.startDate);
  const endDate = toIsoDate(range && range.endDate);
  if (!startDate || !endDate || startDate > endDate) throw new Error('A valid date range is required');
  if (!toIsoDate(todayISO)) throw new Error('todayISO is required');

  const inRange = date => !!date && date >= startDate && date <= endDate;
  const context = { structured, gymKeys };
  const logged = loggedKeys instanceof Set ? new Set([...loggedKeys].map(String)) : keySet(loggedKeys);

  // Repeated syncs, overlapping reads and a re-delivered webhook can all hand
  // the same activity over twice. The Strava id is the identity.
  const byId = new Map();
  (activities || []).map(rowToMatcherActivity).filter(Boolean).forEach(activity => {
    if (inRange(toIsoDate(activity.start_date_local))) byId.set(String(activity.id), activity);
  });
  const acts = [...byId.values()].sort((a, b) =>
    String(a.start_date_local).localeCompare(String(b.start_date_local)) || String(a.id).localeCompare(String(b.id)));
  const actByKey = new Map(acts.map(activity => [stravaActivityKey(activity), activity]));

  const seenSessions = new Set();
  const sessions = [];
  (plannedRows || []).forEach(row => {
    const session = plannedSession(row, context, reschedules || {}, logged, library);
    if (!session || seenSessions.has(session.key) || !inRange(session.date)) return;
    seenSessions.add(session.key);
    sessions.push(session);
  });
  sessions.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const sessionByKey = new Map(sessions.map(session => [session.key, session]));

  const rejections = buildRejections(athleteRejections, reviews);
  const rejectedFor = key => rejections[key] || new Set();
  const matcherRejections = Object.fromEntries(Object.entries(rejections).map(([k, set]) => [k, [...set]]));
  const claimed = new Set();
  const matches = new Map(); // sessionKey -> { activityKeys, via, confidence, reasons }

  const claim = (session, activityKeys, via, confidence, reasons) => {
    activityKeys.forEach(key => claimed.add(String(key)));
    matches.set(session.key, { activityKeys: activityKeys.map(String), via, confidence, reasons: reasons || [] });
  };
  const available = keys => keys.length > 0 && keys.every(key => actByKey.has(key) && !claimed.has(key));

  // 1. Coach confirmations.
  (reviews || []).forEach(review => {
    if (!review || review.decision !== 'confirmed') return;
    const session = sessionByKey.get(String(review.session_key));
    const key = String(review.strava_activity_id);
    if (!session || matches.has(session.key) || !available([key])) return;
    claim(session, [key], 'coach', 'confirmed', []);
  });

  // 2. The athlete's own recorded match. Same restore rule as the portal: every
  //    constituent activity must still exist, and a rejected pair is dropped.
  sessions.forEach(session => {
    if (matches.has(session.key)) return;
    const entry = logs && logs[session.key];
    const meta = entry && typeof entry === 'object' ? entry.__stravaMatch : null;
    if (!meta) return;
    const keys = (Array.isArray(meta.activityKeys) && meta.activityKeys.length
      ? meta.activityKeys
      : [meta.activityKey]).filter(k => k != null && k !== '').map(String);
    const rejected = rejectedFor(session.key);
    if (!available(keys) || keys.some(key => rejected.has(key))) return;
    const activity = actByKey.get(keys[0]);
    const checked = coachIntensityCheck(session.matcher, activity, {
      matched: true, confidence: meta.confidence || 'high', reasons: Array.isArray(meta.reasons) ? meta.reasons : [],
    });
    claim(session, keys, 'athlete', checked.confidence, checked.reasons);
  });

  // 3. Automatic matching, in the portal's order.
  const pending = sport => sessions.filter(s => s.sport === sport && !matches.has(s.key));

  let runs = pending('running');
  while (runs.length) {
    let best = null;
    runs.forEach(session => {
      const match = matchActivityToSession(session.matcher, acts, {
        plannedKm: session.plannedKm || 0, claimedActivityIds: claimed, rejections: matcherRejections,
      });
      if (!match.matched || match.confidence !== 'high') return;
      const delta = Math.abs(Number(match.activity.distance || 0) / 1000 - (session.plannedKm || 0));
      if (!best || delta < best.delta) best = { session, match, delta };
    });
    if (!best) break;
    const checked = coachIntensityCheck(best.session.matcher, best.match.activity, best.match);
    claim(best.session, best.match.activityKeys, 'auto', checked.confidence, checked.reasons);
    runs = runs.filter(s => s.key !== best.session.key);
  }
  runs.forEach(session => {
    const match = matchActivityToSession(session.matcher, acts, {
      plannedKm: session.plannedKm || 0, claimedActivityIds: claimed, rejections: matcherRejections,
    });
    if (!match.matched) return;
    const checked = coachIntensityCheck(session.matcher, match.activity, match);
    claim(session, match.activityKeys, 'auto', checked.confidence, checked.reasons);
  });

  const bySport = (sport, matcher) => {
    let remaining = pending(sport);
    while (remaining.length) {
      let best = null;
      remaining.forEach(session => {
        const count = remaining.filter(other => other.date === session.date).length;
        const match = matcher(session, count);
        if (!match.matched) return;
        if (!best || (match.confidence === 'high' && best.match.confidence !== 'high')) best = { session, match };
      });
      if (!best) break;
      claim(best.session, best.match.activityKeys, 'auto', best.match.confidence, best.match.reasons);
      remaining = remaining.filter(s => s.key !== best.session.key);
    }
  };
  bySport('swimming', (session, count) => matchSwimActivityToSession(session.matcher, acts, {
    claimedActivityIds: claimed, rejections: matcherRejections, sessionCount: count,
  }));
  bySport('cycling', (session, count) => matchRideActivityToSession(session.matcher, acts, {
    claimedActivityIds: claimed, rejections: matcherRejections, sessionCount: count,
  }));
  bySport('strength', (session, count) => matchStrengthActivity(session, acts, {
    claimed, rejected: rejectedFor(session.key), sessionCount: count,
  }));

  // ── Statuses ───────────────────────────────────────────────────────────────
  const activityStatus = new Map(); // activityKey -> { status, sessionKey, via, confidence, reasons }
  matches.forEach((match, sessionKey) => {
    const status = match.confidence === 'low' ? 'needs_review' : 'programmed';
    match.activityKeys.forEach(key => activityStatus.set(key, {
      status, sessionKey, via: match.via, confidence: match.confidence, reasons: match.reasons,
    }));
  });

  const lastSynced = toIsoDate(sync && sync.lastSyncedDate);
  const syncPending = Number(sync && sync.pendingEvents) > 0;
  const recentWindowStart = addDaysISO(todayISO, -2);
  const awaitingSync = date => !!(sync && sync.connected) &&
    (syncPending || (date >= recentWindowStart && (!lastSynced || lastSynced <= date)));

  const sessionResults = sessions.map(session => {
    const match = matches.get(session.key) || null;
    let status;
    let completion = null;
    if (match && match.confidence !== 'low') {
      status = 'completed';
      completion = session.loggedComplete ? 'portal_log_and_strava' : (match.via === 'coach' ? 'coach_confirmed' : 'strava');
    } else if (session.loggedComplete) {
      status = 'completed';
      completion = 'portal_log';
    } else if (match) {
      status = 'needs_review';
    } else if (session.date >= todayISO) {
      status = 'upcoming';
    } else if (awaitingSync(session.date)) {
      status = 'awaiting_sync';
    } else {
      status = 'missed';
    }
    return { ...session, status, completion, match };
  });
  const resultByKey = new Map(sessionResults.map(s => [s.key, s]));

  // ── Manual-only completions: totals from the athlete's own log row ─────────
  const usedLogRows = new Set();
  const manualActuals = new Map();
  const logRows = Array.isArray(trainingLogs) ? trainingLogs : [];
  sessionResults.forEach(session => {
    if (session.status !== 'completed' || session.match) return;
    const row = logRows.find(candidate => candidate && !usedLogRows.has(candidate) &&
      toIsoDate(candidate.session_date) === session.date &&
      !/^strava_/.test(String(candidate.client_write_id || '')) &&
      (session.sport === 'strength'
        ? String(candidate.session_category || '').toLowerCase() === 'strength'
        : sportForLogRow(candidate) === session.sport));
    if (row) usedLogRows.add(row);
    manualActuals.set(session.key, {
      distanceM: row && positive(row.distance_km) !== null && session.sport !== 'strength' ? positive(row.distance_km) * 1000 : null,
      movingTimeS: row && positive(row.duration_min) !== null ? positive(row.duration_min) * 60 : null,
    });
  });

  // ── Items for the All Activities list ──────────────────────────────────────
  const sessionBrief = session => session ? {
    key: session.key, id: session.id, title: session.title, date: session.date,
    sport: session.sport, plannedKm: session.plannedKm, plannedMinutes: session.plannedMinutes,
    rescheduled: session.rescheduled,
  } : null;

  const items = [];
  acts.forEach(activity => {
    const key = stravaActivityKey(activity);
    const state = activityStatus.get(key);
    const session = state ? resultByKey.get(state.sessionKey) : null;
    items.push({
      kind: 'activity',
      key: `activity:${key}`,
      status: state ? state.status : 'unprogrammed',
      activity: coachActivitySummary(activity),
      session: sessionBrief(session),
      match: state ? {
        via: state.via, confidence: state.confidence, reasons: state.reasons,
        groupSize: session && session.match ? session.match.activityKeys.length : 1,
        sessionCompletedInPortal: !!(session && session.loggedComplete),
      } : null,
    });
  });
  sessionResults.forEach(session => {
    // A session with an attached activity is already represented by that
    // activity's row; listing it again would show one workout twice.
    if (session.match) return;
    items.push({
      kind: 'session',
      key: `session:${session.key}`,
      status: session.status === 'completed' ? 'programmed' : session.status,
      completion: session.completion,
      activity: null,
      session: sessionBrief(session),
      manual: manualActuals.get(session.key) || null,
      match: null,
    });
  });
  const itemDate = item => (item.activity ? item.activity.date : item.session.date) || '';
  const itemTime = item => (item.activity && item.activity.startTime) || '99:99';
  items.sort((a, b) => itemDate(a).localeCompare(itemDate(b)) || itemTime(a).localeCompare(itemTime(b)) ||
    a.key.localeCompare(b.key));

  return {
    version: CLASSIFIER_VERSION,
    range: { startDate, endDate },
    items,
    sessions: sessionResults.map(session => ({
      ...sessionBrief(session),
      status: session.status,
      completion: session.completion,
      activityKeys: session.match ? session.match.activityKeys : [],
      matchConfidence: session.match ? session.match.confidence : null,
    })),
    weeks: weeklyTotals({ items, sessionResults, startDate, endDate, todayISO }),
  };
}

// ── WEEKLY TOTALS ────────────────────────────────────────────────────────────

export function mondayOf(iso) {
  const date = toIsoDate(iso);
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return addDaysISO(date, -((dow + 6) % 7));
}

function emptySport() {
  return { sessions: 0, distanceM: 0, movingTimeS: 0 };
}

function finishSport(entry) {
  return {
    sessions: entry.sessions,
    distanceKm: entry.distanceM > 0 ? round(entry.distanceM / 1000, 1) : null,
    distanceM: entry.distanceM > 0 ? Math.round(entry.distanceM) : null,
    durationMinutes: entry.movingTimeS > 0 ? Math.round(entry.movingTimeS / 60) : null,
  };
}

/**
 * Prescribed versus actual, per Monday-start week.
 *
 * ACTUAL = every shared Strava activity (programmed, unprogrammed and pending
 * review alike: all of it happened) + programmed sessions completed in the
 * portal with no Strava activity attached, counted once from the athlete's
 * log. An activity that completed a session is one activity: it is counted
 * from the activity, never again from the session.
 *
 * COMPLIANCE = completed / (completed + missed), over programmed sessions only.
 * Unprogrammed work is never in the denominator or the numerator, and a
 * session still upcoming, awaiting sync or under review is not yet a result.
 */
export function weeklyTotals({ items, sessionResults, startDate, endDate, todayISO }) {
  const weeks = new Map();
  const week = date => {
    const start = mondayOf(date);
    if (!weeks.has(start)) {
      const actual = {};
      const prescribed = {};
      const unprogrammed = {};
      SPORT_FAMILIES.forEach(sport => { actual[sport] = emptySport(); unprogrammed[sport] = 0; });
      ['running', 'cycling', 'swimming', 'strength'].forEach(sport => { prescribed[sport] = { sessions: 0, km: 0, minutes: 0, upcomingKm: 0 }; });
      weeks.set(start, {
        weekStart: start, weekEnd: addDaysISO(start, 6), actual, prescribed, unprogrammed,
        programme: { planned: 0, completed: 0, missed: 0, upcoming: 0, needsReview: 0, awaitingSync: 0 },
        effort: { total: 0, activitiesWithEffort: 0 }, activeDays: new Set(), totalMovingS: 0,
        activityCount: 0, unprogrammedCount: 0, pendingReviews: 0,
      });
    }
    return weeks.get(start);
  };

  for (let cursor = mondayOf(startDate); cursor && cursor <= endDate; cursor = addDaysISO(cursor, 7)) week(cursor);

  (sessionResults || []).forEach(session => {
    const w = week(session.date);
    w.programme.planned += 1;
    if (session.status === 'completed') w.programme.completed += 1;
    else if (session.status === 'missed') w.programme.missed += 1;
    else if (session.status === 'upcoming') w.programme.upcoming += 1;
    else if (session.status === 'needs_review') w.programme.needsReview += 1;
    else if (session.status === 'awaiting_sync') w.programme.awaitingSync += 1;
    if (session.match && session.match.confidence === 'low') w.pendingReviews += 1;
    const p = w.prescribed[session.sport];
    if (p) {
      p.sessions += 1;
      if (session.plannedKm) p.km += session.plannedKm;
      // Planned distance whose day has not come yet: the variance is read
      // against the whole week, so the UI has to say how much is still ahead.
      if (session.plannedKm && session.status === 'upcoming') p.upcomingKm += session.plannedKm;
      if (session.plannedMinutes) p.minutes += session.plannedMinutes;
    }
  });

  (items || []).forEach(item => {
    if (item.kind === 'activity') {
      const a = item.activity;
      const w = week(a.date);
      const entry = w.actual[a.sport] || w.actual.other;
      entry.sessions += 1;
      if (a.distanceM) entry.distanceM += a.distanceM;
      if (a.movingTimeS) { entry.movingTimeS += a.movingTimeS; w.totalMovingS += a.movingTimeS; }
      if (a.relativeEffort != null) { w.effort.total += a.relativeEffort; w.effort.activitiesWithEffort += 1; }
      w.activeDays.add(a.date);
      w.activityCount += 1;
      if (item.status === 'unprogrammed') { w.unprogrammed[a.sport] += 1; w.unprogrammedCount += 1; }
    } else if (item.kind === 'session' && item.status === 'programmed') {
      const s = item.session;
      const w = week(s.date);
      const entry = w.actual[s.sport] || w.actual.other;
      entry.sessions += 1;
      if (item.manual && item.manual.distanceM) entry.distanceM += item.manual.distanceM;
      if (item.manual && item.manual.movingTimeS) {
        entry.movingTimeS += item.manual.movingTimeS;
        w.totalMovingS += item.manual.movingTimeS;
      }
      w.activeDays.add(s.date);
    }
  });

  return [...weeks.values()]
    .filter(w => w.weekEnd >= startDate && w.weekStart <= endDate)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map(w => {
      const actual = {};
      SPORT_FAMILIES.forEach(sport => { actual[sport] = finishSport(w.actual[sport]); });
      const prescribed = {};
      Object.entries(w.prescribed).forEach(([sport, p]) => {
        prescribed[sport] = {
          sessions: p.sessions,
          km: p.km > 0 ? round(p.km, 1) : null,
          minutes: p.minutes > 0 ? p.minutes : null,
          upcomingKm: p.upcomingKm > 0 ? round(p.upcomingKm, 1) : null,
        };
      });
      const decided = w.programme.completed + w.programme.missed;
      const runKm = actual.running.distanceKm || 0;
      return {
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        state: todayISO > w.weekEnd ? 'past' : (todayISO < w.weekStart ? 'future' : 'current'),
        prescribed,
        actual,
        programme: {
          ...w.programme,
          compliancePercent: decided ? Math.round((w.programme.completed / decided) * 100) : null,
        },
        additional: w.unprogrammed,
        overall: {
          activities: w.activityCount,
          trainingMinutes: w.totalMovingS > 0 ? Math.round(w.totalMovingS / 60) : 0,
          activeDays: w.activeDays.size,
          programmedCompleted: w.programme.completed,
          unprogrammedCompleted: w.unprogrammedCount,
          missed: w.programme.missed,
          needsReview: w.pendingReviews,
          relativeEffort: w.effort.activitiesWithEffort ? Math.round(w.effort.total) : null,
          activitiesWithEffort: w.effort.activitiesWithEffort,
        },
        variance: {
          runningKm: prescribed.running.km != null ? round(runKm - prescribed.running.km, 1) : null,
          runningPercent: prescribed.running.km ? Math.round(((runKm - prescribed.running.km) / prescribed.running.km) * 100) : null,
        },
      };
    });
}
