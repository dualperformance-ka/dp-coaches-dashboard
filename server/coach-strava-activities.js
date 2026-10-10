// Coach read and review of an athlete's Strava activities.
//
// Connecting Strava in the athlete portal is all it takes: from that moment
// the portal syncs every activity into strava_activities, and this module shows
// all of them to the athlete's coaches, labelled programmed or unprogrammed.
// Disconnecting (or revoking the app on strava.com) purges the cache in the
// portal, so a disconnected athlete shows nothing.
//
// Checked on every request:
//   1. Coach identity and athlete scope. The handler resolves a registered,
//      enabled coach and asserts they may see this athlete
//      (server/coach-scope.js) before calling anything here.
//   2. The athlete has Strava connected (a strava_tokens row).
//   3. Kill switch: STRAVA_COACH_SHARING=off hides the view with no code
//      change. Unset means on.
//
// What a coach receives is a SUMMARY per activity, built field by field in
// coachActivitySummary (server/strava-activity-classifier.js). Never tokens:
// the token row is projected to strava_athlete_id and connected_at inside
// PostgREST, so the tokens never leave the database. Never streams, laps, the
// route polyline or coordinates.
//
// This module never calls Strava. It reads the cache the athlete portal keeps
// current, so a Strava rate limit, an outage or a dead token on Strava's side
// cannot remove anything a coach could already see.

import { addDaysISO, adelaideToday, isUuid, toIsoDate } from './performance-summary-core.js';
import { classifyAthleteActivities, mondayOf } from './strava-activity-classifier.js';

export const MAX_RANGE_DAYS = 92;
const TREND_WEEKS = 4;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
const MAX_EVENT_ATTEMPTS = 5;

function httpError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

/** On unless the deployment explicitly turns it off. */
export function coachStravaEnabled(env = process.env) {
  return !/^(off|false|0|no)$/i.test(String(env.STRAVA_COACH_SHARING || '').trim());
}

export function validCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) throw httpError('A valid athlete code is required', 400);
  return code;
}

/** Requested range, defaulting to the current Monday-to-Sunday week. */
export function resolveRange(start, end, todayISO) {
  const startDate = toIsoDate(start) || mondayOf(todayISO);
  const endDate = toIsoDate(end) || addDaysISO(mondayOf(toIsoDate(start) || todayISO), 6);
  if (startDate > endDate) throw httpError('The start date must be on or before the end date', 400);
  const days = Math.round((Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw httpError(`Choose a range of ${MAX_RANGE_DAYS} days or fewer`, 400);
  return { startDate, endDate };
}

/**
 * Pure: the athlete's Strava connection from the projected token row.
 * Returns { status: 'connected'|'not_connected'|'unavailable', ... }.
 */
export function connectionState(row, { readFailed = false } = {}) {
  if (readFailed) return { status: 'unavailable' };
  const id = row ? String(row.strava_athlete_id || '') : '';
  if (!/^\d+$/.test(id)) return { status: 'not_connected' };
  return { status: 'connected', stravaAthleteId: id, connectedAt: row.connected_at || null };
}

const enc = encodeURIComponent;

async function readConnection(sb, code) {
  try {
    const rows = await sb(`athlete_data?athlete_code=eq.${enc(code)}&key=eq.strava_tokens` +
      '&select=strava_athlete_id:value->>strava_athlete_id,connected_at:value->>connected_at&limit=1');
    return connectionState(Array.isArray(rows) ? rows[0] : null);
  } catch (error) {
    console.warn('[coach-strava] connection read failed:', error && error.message);
    return connectionState(null, { readFailed: true });
  }
}

/** Throws unless the view is on and the athlete has Strava connected. */
export async function assertConnected(sb, code, env = process.env) {
  if (!coachStravaEnabled(env)) {
    throw httpError('Strava activities are switched off for this deployment', 403, 'strava_coach_disabled');
  }
  const connection = await readConnection(sb, code);
  if (connection.status !== 'connected') {
    throw httpError('This athlete does not have Strava connected', 403, 'strava_not_connected');
  }
  return connection;
}

function optional(name, promise, missing) {
  return promise.then(value => value, error => {
    console.warn(`[coach-strava] ${name} read failed:`, error && error.message);
    missing.push(name);
    return null;
  });
}

function adelaideDateOf(timestamp) {
  const ms = Date.parse(timestamp || '');
  return Number.isFinite(ms) ? adelaideToday(new Date(ms)) : null;
}

/**
 * Load and classify. The caller has already authorised the coach for `code`.
 * `sb(path)` is a service-role PostgREST GET returning parsed JSON.
 */
export async function loadCoachStravaActivities({ code: rawCode, start, end, sb, now = new Date(), env = process.env }) {
  const code = validCode(rawCode);
  const todayISO = adelaideToday(now);
  const range = resolveRange(start, end, todayISO);

  if (!coachStravaEnabled(env)) {
    return { athleteCode: code, connection: { status: 'disabled' }, range, items: [], weeks: [], sessions: [] };
  }
  const connection = await readConnection(sb, code);
  if (connection.status !== 'connected') {
    // Nothing is read from strava_activities for an athlete without Strava.
    return { athleteCode: code, connection, range, items: [], weeks: [], sessions: [] };
  }

  // Classify a window that always covers the last four weeks of the range, so
  // the effort and frequency trend is available even for a one-week view.
  const windowStart = [range.startDate, addDaysISO(mondayOf(range.endDate), -7 * (TREND_WEEKS - 1))].sort()[0];
  const window = { startDate: windowStart, endDate: range.endDate };
  const plannedFrom = addDaysISO(window.startDate, -14);
  const plannedTo = addDaysISO(window.endDate, 14);
  const missing = [];

  const [activities, planned, state, reviews, trainingLogs, splitRows, lastSyncRows] = await Promise.all([
    sb(`strava_activities?athlete_code=eq.${enc(code)}` +
      `&and=(start_date_local.gte.${enc(`${window.startDate}T00:00:00Z`)},start_date_local.lt.${enc(`${addDaysISO(window.endDate, 1)}T00:00:00Z`)})` +
      '&select=strava_activity_id,start_date_local,sport_type,name,distance_m,moving_time_s,elapsed_time_s,suffer_score,summary,synced_at' +
      '&order=start_date_local.asc&limit=1500'),
    sb(`planned_sessions?athlete_code=eq.${enc(code)}&publish_state=eq.published` +
      `&and=(planned_date.gte.${plannedFrom},planned_date.lte.${plannedTo})` +
      '&select=id,notion_page_id,title,planned_date,session_type,status,library_id,distance_km,run_details,intensity,estimated_minutes,prescription_mode' +
      '&order=planned_date.asc&limit=1000'),
    optional('athlete_data', sb(`athlete_data?athlete_code=eq.${enc(code)}` +
      '&key=in.(logs,reschedules,strava_match_rejections)&select=key,value'), missing),
    optional('strava_activity_reviews', sb(`strava_activity_reviews?athlete_code=eq.${enc(code)}` +
      '&select=strava_activity_id,session_key,decision,decided_by,decided_at&limit=2000'), missing),
    optional('training_session_logs', sb(`training_session_logs?athlete_code=eq.${enc(code)}` +
      `&and=(session_date.gte.${window.startDate},session_date.lte.${window.endDate})` +
      '&select=session_name,session_category,session_date,distance_km,duration_min,client_write_id&limit=2000'), missing),
    optional('workout_splits', sb(`workout_splits?archived=eq.false&or=(athlete_code.is.null,athlete_code.eq.${enc(code)})&select=name&limit=200`), missing),
    optional('last_sync', sb(`strava_activities?athlete_code=eq.${enc(code)}&select=synced_at&order=synced_at.desc&limit=1`), missing),
  ]);

  const plannedRows = Array.isArray(planned) ? planned : [];
  const blob = key => {
    const row = (Array.isArray(state) ? state : []).find(r => r && r.key === key);
    return row && row.value && typeof row.value === 'object' ? row.value : {};
  };

  const sessionKeys = [...new Set(plannedRows.map(r => String(r.notion_page_id || r.id || '')).filter(k => /^[A-Za-z0-9-]+$/.test(k)))];
  const libraryIds = [...new Set(plannedRows.map(r => r.library_id).filter(isUuid))];
  const structuredIds = plannedRows.filter(r => r.prescription_mode === 'structured').map(r => r.id).filter(isUuid);
  const prefix = `session_${code}_`;

  const stravaAthleteId = connection.stravaAthleteId;

  const [loggedRows, libraryRows, exerciseRows, runStepRows, pendingRows] = await Promise.all([
    sessionKeys.length
      ? optional('session_logs', sb(`session_logs?athlete_code=eq.${enc(code)}` +
        `&session_key=in.(${sessionKeys.flatMap(k => [k, `${prefix}${k}`]).map(enc).join(',')})&select=session_key&limit=4000`), missing)
      : Promise.resolve([]),
    libraryIds.length
      ? optional('session_library', sb(`session_library?id=in.(${libraryIds.join(',')})&select=id,name,distance,description`), missing)
      : Promise.resolve([]),
    structuredIds.length
      ? optional('session_exercises', sb(`session_exercises?planned_session_id=in.(${structuredIds.join(',')})&select=planned_session_id&limit=4000`), missing)
      : Promise.resolve([]),
    structuredIds.length
      ? optional('run_steps', sb(`run_steps?planned_session_id=in.(${structuredIds.join(',')})&select=planned_session_id&limit=4000`), missing)
      : Promise.resolve([]),
    stravaAthleteId
      ? optional('strava_webhook_events', sb(`strava_webhook_events?owner_id=eq.${stravaAthleteId}` +
        `&processed_at=is.null&attempts=lt.${MAX_EVENT_ATTEMPTS}&select=id&limit=50`), missing)
      : Promise.resolve([]),
  ]);

  const library = {};
  (libraryRows || []).forEach(row => { library[row.id] = row; });
  const structured = new Map();
  structuredIds.forEach(id => structured.set(id, { exercises: 0, runSteps: 0 }));
  (exerciseRows || []).forEach(r => { const e = structured.get(r.planned_session_id); if (e) e.exercises += 1; });
  (runStepRows || []).forEach(r => { const e = structured.get(r.planned_session_id); if (e) e.runSteps += 1; });
  const gymKeys = ['Upper A', 'Upper B', 'Lower A', 'Lower B']
    .concat((splitRows || []).map(r => String(r.name || '')).filter(Boolean))
    .filter((v, i, all) => all.indexOf(v) === i)
    .sort((a, b) => b.length - a.length);

  const sync = {
    connected: !!stravaAthleteId,
    pendingEvents: Array.isArray(pendingRows) ? pendingRows.length : 0,
    lastSyncedAt: (Array.isArray(lastSyncRows) && lastSyncRows[0] && lastSyncRows[0].synced_at) || null,
  };
  sync.lastSyncedDate = adelaideDateOf(sync.lastSyncedAt);

  const result = classifyAthleteActivities({
    activities: Array.isArray(activities) ? activities : [],
    plannedRows,
    library,
    reschedules: blob('reschedules'),
    logs: blob('logs'),
    loggedKeys: new Set((loggedRows || []).map(r => String(r.session_key || ''))
      .map(k => (k.startsWith(prefix) ? k.slice(prefix.length) : k)).filter(Boolean)),
    athleteRejections: blob('strava_match_rejections'),
    reviews: Array.isArray(reviews) ? reviews : [],
    trainingLogs: Array.isArray(trainingLogs) ? trainingLogs : [],
    structured,
    gymKeys,
    todayISO,
    range: window,
    sync,
  });

  const inRange = date => date && date >= range.startDate && date <= range.endDate;
  const items = result.items.filter(item => inRange(item.activity ? item.activity.date : item.session.date));
  const shownActivities = new Set(items.filter(item => item.activity).map(item => item.activity.id));
  return {
    athleteCode: code,
    connection: { status: connection.status, connectedAt: connection.connectedAt },
    sync: { connected: sync.connected, pendingEvents: sync.pendingEvents, lastSyncedAt: sync.lastSyncedAt },
    range,
    today: todayISO,
    items,
    sessions: result.sessions.filter(session => inRange(session.date)),
    // Coach decisions on the activities shown, so a rejection can be undone.
    reviews: (Array.isArray(reviews) ? reviews : [])
      .filter(r => r && shownActivities.has(String(r.strava_activity_id)))
      .map(r => ({
        activityId: String(r.strava_activity_id), sessionKey: String(r.session_key),
        decision: r.decision, decidedBy: r.decided_by || null, decidedAt: r.decided_at || null,
      })),
    weeks: result.weeks,
    dataQuality: { partial: missing.length > 0, missingSources: missing.sort() },
    generatedAt: now.toISOString(),
  };
}

// ── Coach review (confirm / reject / clear one pairing) ──────────────────────

export const REVIEW_DECISIONS = ['confirmed', 'rejected', 'clear'];

export function validReviewInput(body = {}) {
  const code = validCode(body.code);
  const activityId = String(body.activityId ?? '').trim();
  if (!/^\d{1,20}$/.test(activityId) || Number(activityId) <= 0) throw httpError('A valid Strava activity id is required', 400);
  const sessionKey = String(body.sessionKey ?? '').trim();
  if (!/^[A-Za-z0-9-]{1,80}$/.test(sessionKey)) throw httpError('A valid session is required', 400);
  const decision = String(body.decision || '').trim().toLowerCase();
  if (!REVIEW_DECISIONS.includes(decision)) throw httpError('Decision must be confirmed, rejected or clear', 400);
  return { code, activityId, sessionKey, decision };
}

/**
 * `sb(path, { method, body, prefer })` is the service-role PostgREST helper.
 * The caller has already resolved `coach` and asserted scope for body.code.
 */
export async function saveStravaReview({ body, coach, sb, env = process.env }) {
  const input = validReviewInput(body);
  await assertConnected(sb, input.code, env);

  const [activityRows, sessionRows] = await Promise.all([
    sb(`strava_activities?athlete_code=eq.${enc(input.code)}&strava_activity_id=eq.${input.activityId}&select=strava_activity_id&limit=1`),
    sb(`planned_sessions?athlete_code=eq.${enc(input.code)}&` +
      (isUuid(input.sessionKey)
        ? `or=(id.eq.${input.sessionKey},notion_page_id.eq.${enc(input.sessionKey)})`
        : `notion_page_id=eq.${enc(input.sessionKey)}`) +
      '&select=id,notion_page_id&limit=1'),
  ]);
  // Same message whether the id is wrong or belongs to another athlete.
  if (!Array.isArray(activityRows) || !activityRows.length) throw httpError('Activity not found for this athlete', 404);
  const session = Array.isArray(sessionRows) ? sessionRows[0] : null;
  if (!session) throw httpError('Session not found for this athlete', 404);
  // Decisions are keyed exactly as the portal keys the session.
  const sessionKey = String(session.notion_page_id || session.id);

  const pair = `athlete_code=eq.${enc(input.code)}&strava_activity_id=eq.${input.activityId}&session_key=eq.${enc(sessionKey)}`;
  if (input.decision === 'clear') {
    await sb(`strava_activity_reviews?${pair}`, { method: 'DELETE', prefer: 'return=minimal' });
    return { cleared: true, sessionKey, activityId: input.activityId };
  }

  try {
    const rows = await sb('strava_activity_reviews?on_conflict=athlete_code,strava_activity_id,session_key', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [{
        athlete_code: input.code,
        strava_activity_id: Number(input.activityId),
        session_key: sessionKey,
        decision: input.decision,
        decided_by: String(coach && (coach.handle || coach.name) || 'COACH').slice(0, 60),
        decided_at: new Date().toISOString(),
      }],
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return {
      review: row ? {
        activityId: String(row.strava_activity_id), sessionKey: row.session_key,
        decision: row.decision, decidedBy: row.decided_by, decidedAt: row.decided_at,
      } : null,
    };
  } catch (error) {
    if (/strava_activity_reviews_one_session_per_activity|duplicate key/i.test(String(error && error.message))) {
      throw httpError('That activity or session is already confirmed against another match. Clear that match first.', 409);
    }
    throw error;
  }
}
