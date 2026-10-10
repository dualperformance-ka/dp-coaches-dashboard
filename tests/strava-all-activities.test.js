// Every shared Strava activity, classified against the programme.
//
// Numbered tests map one-to-one to the acceptance list in the feature brief.
// Pure classification is tested directly; the loader and the API handler are
// tested against a recording PostgREST stub so the security assertions are
// about what was actually requested, not what a function promised.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyAthleteActivities,
  coachActivitySummary,
  rowToMatcherActivity,
  sportFamily,
} from '../server/strava-activity-classifier.js';
import {
  loadCoachStravaActivities,
  resolveRange,
  saveStravaReview,
  connectionState,
} from '../server/coach-strava-activities.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// Week of Mon 5 Oct 2026. "Today" is Sat 10 Oct unless a test says otherwise.
const TODAY = '2026-10-10';
const WEEK = { startDate: '2026-10-05', endDate: '2026-10-11' };
const SYNC_OK = { connected: true, pendingEvents: 0, lastSyncedDate: TODAY };

let nextId = 1000;
function activity(date, type, km, minutes, extra = {}) {
  const id = extra.id ?? (nextId += 1);
  const time = extra.time || '07:00';
  const summary = {
    id, name: extra.name || `${type} activity`, sport_type: type, type,
    start_date_local: `${date}T${time}:00Z`, start_date: `${date}T${time}:00Z`,
    distance: km == null ? 0 : km * 1000, moving_time: minutes * 60, elapsed_time: minutes * 60 + 60,
    suffer_score: extra.effort ?? null, average_heartrate: extra.hr ?? null,
    map: { summary_polyline: 'secret_polyline' }, start_latlng: [-34.9, 138.6], end_latlng: [-34.9, 138.6],
    location_city: 'Adelaide', ...extra.summary,
  };
  return {
    strava_activity_id: id, start_date_local: `${date}T${time}:00+00:00`, sport_type: type,
    name: summary.name, distance_m: summary.distance, moving_time_s: summary.moving_time,
    elapsed_time_s: summary.elapsed_time, suffer_score: summary.suffer_score, summary,
    synced_at: `${date}T09:00:00+00:00`,
  };
}

function session(id, date, title, extra = {}) {
  return {
    id, notion_page_id: null, title, planned_date: date, session_type: extra.type ?? null,
    status: extra.status || 'Planned', distance_km: extra.km ?? null, library_id: null,
    run_details: extra.details ?? null, intensity: extra.intensity ?? null,
    estimated_minutes: extra.minutes ?? null, prescription_mode: 'legacy',
  };
}

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function classify(input) {
  return classifyAthleteActivities({ todayISO: TODAY, range: WEEK, sync: SYNC_OK, ...input });
}
const activityItem = (result, id) => result.items.find(i => i.kind === 'activity' && i.activity.id === String(id));
const sessionResult = (result, key) => result.sessions.find(s => s.key === key);
const week = result => result.weeks.find(w => w.weekStart === WEEK.startDate);

// ── 1-4: programmed vs unprogrammed ──────────────────────────────────────────

test('1. a programmed run is completed by the matching Strava run', () => {
  const run = activity('2026-10-05', 'Run', 10.2, 55, { name: 'Morning Run' });
  const result = classify({
    activities: [run],
    plannedRows: [session(uuid(1), '2026-10-05', 'Easy Run — 10km', { km: 10 })],
  });
  assert.equal(activityItem(result, run.strava_activity_id).status, 'programmed');
  assert.equal(activityItem(result, run.strava_activity_id).session.key, uuid(1));
  assert.equal(sessionResult(result, uuid(1)).status, 'completed');
  assert.equal(sessionResult(result, uuid(1)).completion, 'strava');
});

test('2. an unprogrammed ride on a rest day appears in All Activities', () => {
  const ride = activity('2026-10-06', 'Ride', 42, 95, { name: 'Afternoon Ride' });
  const result = classify({
    activities: [ride],
    plannedRows: [session(uuid(2), '2026-10-06', 'Rest Day', { type: 'rest' })],
  });
  const item = activityItem(result, ride.strava_activity_id);
  assert.equal(item.status, 'unprogrammed');
  assert.equal(item.activity.sport, 'cycling');
  assert.equal(result.sessions.length, 0, 'a rest day is not a session that can be missed');
});

test('3. an unprogrammed swim appears in All Activities', () => {
  const swim = activity('2026-10-09', 'Swim', 1.5, 35);
  const result = classify({ activities: [swim], plannedRows: [] });
  const item = activityItem(result, swim.strava_activity_id);
  assert.equal(item.status, 'unprogrammed');
  assert.equal(item.activity.sport, 'swimming');
  assert.equal(item.activity.distanceM, 1500);
});

test('4. an unprogrammed gym session appears in All Activities', () => {
  const gym = activity('2026-10-07', 'WeightTraining', null, 55, { name: 'Lunch Weights' });
  const result = classify({ activities: [gym], plannedRows: [] });
  const item = activityItem(result, gym.strava_activity_id);
  assert.equal(item.status, 'unprogrammed');
  assert.equal(item.activity.sport, 'strength');
  assert.equal(item.activity.distanceM, null, 'a weights session has no distance, not 0 km');
});

// ── 5-9: matching rules ──────────────────────────────────────────────────────

test('5. multiple activities on one day appear separately', () => {
  const am = activity('2026-10-08', 'Run', 8, 42, { time: '06:00' });
  const pm = activity('2026-10-08', 'Ride', 30, 70, { time: '17:30' });
  const walk = activity('2026-10-08', 'Walk', 3, 35, { time: '19:00' });
  const result = classify({
    activities: [pm, walk, am],
    plannedRows: [session(uuid(5), '2026-10-08', 'Intervals — 8km', { km: 8 })],
  });
  const day = result.items.filter(i => i.kind === 'activity' && i.activity.date === '2026-10-08');
  assert.deepEqual(day.map(i => i.activity.id), [am, pm, walk].map(a => String(a.strava_activity_id)));
  assert.deepEqual(day.map(i => i.status), ['programmed', 'unprogrammed', 'unprogrammed']);
});

test('6. one activity cannot complete two programmed sessions', () => {
  const run = activity('2026-10-05', 'Run', 10, 55);
  const result = classify({
    activities: [run],
    plannedRows: [
      session(uuid(61), '2026-10-05', 'Easy Run — 10km', { km: 10 }),
      session(uuid(62), '2026-10-05', 'Easy Run — 10km (PM)', { km: 10 }),
    ],
  });
  const completed = result.sessions.filter(s => s.status === 'completed');
  assert.equal(completed.length, 1);
  assert.equal(result.sessions.filter(s => s.activityKeys.includes(String(run.strava_activity_id))).length, 1);
  assert.equal(sessionResult(result, completed[0].key === uuid(61) ? uuid(62) : uuid(61)).status, 'missed');
});

test('7. repeated syncs do not create duplicate activities', () => {
  const run = activity('2026-10-05', 'Run', 10, 55);
  const resync = { ...run, synced_at: '2026-10-06T01:00:00+00:00' };
  const once = classify({ activities: [run], plannedRows: [] });
  const twice = classify({ activities: [run, resync, run], plannedRows: [] });
  assert.equal(twice.items.length, 1);
  assert.deepEqual(twice.items.map(i => i.key), once.items.map(i => i.key));
  assert.equal(week(twice).overall.activities, 1);
});

test('8. a manually logged session is not duplicated when its Strava activity arrives', () => {
  const run = activity('2026-10-05', 'Run', 10.1, 54);
  const plan = session(uuid(8), '2026-10-05', 'Easy Run — 10km', { km: 10 });
  const result = classify({
    activities: [run],
    plannedRows: [plan],
    loggedKeys: new Set([uuid(8)]),
    trainingLogs: [{ session_name: 'Easy Run — 10km', session_category: 'Run', session_date: '2026-10-05', distance_km: 10, duration_min: 55 }],
  });
  assert.equal(result.items.length, 1, 'one workout, one row');
  assert.equal(activityItem(result, run.strava_activity_id).status, 'programmed');
  assert.equal(sessionResult(result, uuid(8)).completion, 'portal_log_and_strava');
  assert.equal(week(result).actual.running.sessions, 1);
  assert.equal(week(result).actual.running.distanceKm, 10.1, 'the activity is counted, the log is not added on top');
});

test('9. a different sport cannot complete a programmed session', () => {
  const ride = activity('2026-10-05', 'Ride', 10, 30);
  const gym = activity('2026-10-06', 'WeightTraining', null, 50);
  const result = classify({
    todayISO: '2026-10-12',
    activities: [ride, gym],
    plannedRows: [
      session(uuid(91), '2026-10-05', 'Easy Run — 10km', { km: 10 }),
      session(uuid(92), '2026-10-06', 'Swim technique', { type: 'swim' }),
    ],
  });
  assert.equal(activityItem(result, ride.strava_activity_id).status, 'unprogrammed');
  assert.equal(activityItem(result, gym.strava_activity_id).status, 'unprogrammed');
  assert.equal(sessionResult(result, uuid(91)).status, 'missed');
  assert.equal(sessionResult(result, uuid(92)).status, 'missed');
});

// ── 10-11: missed and review ─────────────────────────────────────────────────

test('10. missed sessions are only missed once the day has ended and sync is current', () => {
  const plannedRows = [
    session(uuid(101), '2026-10-06', 'Easy Run — 8km', { km: 8 }),
    session(uuid(102), '2026-10-09', 'Recovery Run — 6km', { km: 6 }),
    session(uuid(103), '2026-10-10', 'Long Run — 18km', { km: 18 }),
    session(uuid(104), '2026-10-11', 'Easy Run — 5km', { km: 5 }),
  ];
  const current = classify({ plannedRows, sync: { connected: true, pendingEvents: 0, lastSyncedDate: TODAY } });
  assert.equal(sessionResult(current, uuid(101)).status, 'missed');
  assert.equal(sessionResult(current, uuid(102)).status, 'missed');
  assert.equal(sessionResult(current, uuid(103)).status, 'upcoming', 'today is still in progress');
  assert.equal(sessionResult(current, uuid(104)).status, 'upcoming');

  const pending = classify({ plannedRows, sync: { connected: true, pendingEvents: 2, lastSyncedDate: TODAY } });
  assert.equal(sessionResult(pending, uuid(101)).status, 'awaiting_sync', 'queued webhook events may hold the run');

  const stale = classify({ plannedRows, sync: { connected: true, pendingEvents: 0, lastSyncedDate: '2026-10-08' } });
  assert.equal(sessionResult(stale, uuid(102)).status, 'awaiting_sync', 'nothing has synced since that day ended');
  assert.equal(sessionResult(stale, uuid(101)).status, 'missed', 'older than the two-day sync grace');

  const week10 = week(current);
  assert.equal(week10.programme.missed, 2);
  assert.equal(week10.programme.upcoming, 2);
});

test('11. low-confidence matches go to review rather than completing', () => {
  const easyNamed = activity('2026-10-07', 'Run', 12, 62, { name: 'Easy Run' });
  const openRun = activity('2026-10-08', 'Run', 7, 40, { name: 'Morning Run' });
  const result = classify({
    activities: [easyNamed, openRun],
    plannedRows: [
      session(uuid(111), '2026-10-07', 'Threshold Run — 12km', { km: 12 }),
      session(uuid(112), '2026-10-08', 'Run', {}), // no planned distance
    ],
  });
  const threshold = activityItem(result, easyNamed.strava_activity_id);
  assert.equal(threshold.status, 'needs_review');
  assert.ok(threshold.match.reasons.includes('activity_named_easy'));
  assert.equal(sessionResult(result, uuid(111)).status, 'needs_review', 'not completed, not missed');
  assert.equal(activityItem(result, openRun.strava_activity_id).status, 'needs_review');
  assert.equal(week(result).programme.needsReview, 2);
  assert.equal(week(result).overall.needsReview, 2);
});

test('11b. a quality session completed without effort data never claims its structure', () => {
  const run = activity('2026-10-07', 'Run', 12, 58, { name: 'Morning Run' });
  const result = classify({
    activities: [run],
    plannedRows: [session(uuid(113), '2026-10-07', 'Threshold Run — 12km', { km: 12 })],
  });
  const item = activityItem(result, run.strava_activity_id);
  assert.equal(item.status, 'programmed');
  assert.ok(item.match.reasons.includes('structure_unverified'));
});

// ── 12-13: totals and compliance ─────────────────────────────────────────────

test('12. weekly actual totals include programmed and unprogrammed work, each once', () => {
  const result = classify({
    activities: [
      activity('2026-10-05', 'Run', 10.2, 55, { effort: 40 }),
      activity('2026-10-06', 'Ride', 42, 95, { effort: 60 }),
      activity('2026-10-07', 'WeightTraining', null, 55),
      activity('2026-10-08', 'Run', 8.1, 44, { effort: 70 }),
      activity('2026-10-09', 'Swim', 1.5, 35),
    ],
    plannedRows: [
      session(uuid(121), '2026-10-05', 'Easy Run — 10km', { km: 10 }),
      session(uuid(122), '2026-10-08', 'Intervals — 8km', { km: 8 }),
      session(uuid(123), '2026-10-09', 'Recovery Run — 6km', { km: 6 }),
    ],
  });
  const w = week(result);
  assert.deepEqual(w.prescribed.running, { sessions: 3, km: 24, minutes: null, upcomingKm: null });
  assert.equal(w.actual.running.sessions, 2);
  assert.equal(w.actual.running.distanceKm, 18.3);
  assert.equal(w.actual.cycling.distanceKm, 42);
  assert.equal(w.actual.swimming.distanceM, 1500);
  assert.equal(w.actual.strength.sessions, 1);
  assert.equal(w.actual.strength.durationMinutes, 55);
  assert.equal(w.overall.activities, 5);
  assert.equal(w.overall.trainingMinutes, 55 + 95 + 55 + 44 + 35);
  assert.equal(w.overall.programmedCompleted, 2);
  assert.equal(w.overall.unprogrammedCompleted, 3);
  assert.equal(w.overall.missed, 1);
  assert.equal(w.overall.relativeEffort, 170);
  assert.equal(w.overall.activeDays, 5);
  assert.deepEqual(
    { run: w.additional.running, ride: w.additional.cycling, swim: w.additional.swimming, gym: w.additional.strength },
    { run: 0, ride: 1, swim: 1, gym: 1 },
  );
  assert.equal(w.variance.runningKm, -5.7);
});

test('13. compliance excludes unprogrammed activities from its denominator', () => {
  const extras = [1, 2, 3].map(n => activity(`2026-10-0${n + 5}`, 'Ride', 20, 50));
  const result = classify({
    activities: [activity('2026-10-05', 'Run', 10, 55), ...extras],
    plannedRows: [
      session(uuid(131), '2026-10-05', 'Easy Run — 10km', { km: 10 }),
      session(uuid(132), '2026-10-06', 'Easy Run — 8km', { km: 8 }),
      session(uuid(133), '2026-10-11', 'Long Run — 20km', { km: 20 }),
    ],
  });
  const w = week(result);
  assert.equal(w.programme.completed, 1);
  assert.equal(w.programme.missed, 1);
  assert.equal(w.programme.upcoming, 1);
  assert.equal(w.programme.compliancePercent, 50, '1 of 2 decided sessions; 3 extra rides and the future run are excluded');
  assert.equal(w.prescribed.running.upcomingKm, 20, 'the variance is read with the distance still to come');
});

// ── Overrides and the athlete's own record ───────────────────────────────────

test('a coach rejection is never silently re-matched, and a confirmation wins', () => {
  const run = activity('2026-10-05', 'Run', 10, 55);
  const plannedRows = [session(uuid(141), '2026-10-05', 'Easy Run — 10km', { km: 10 })];
  const rejected = classify({
    activities: [run], plannedRows, todayISO: '2026-10-12',
    reviews: [{ strava_activity_id: run.strava_activity_id, session_key: uuid(141), decision: 'rejected' }],
  });
  assert.equal(activityItem(rejected, run.strava_activity_id).status, 'unprogrammed');
  assert.equal(sessionResult(rejected, uuid(141)).status, 'missed');

  const gym = activity('2026-10-05', 'Workout', null, 40);
  const confirmed = classify({
    activities: [gym],
    plannedRows: [session(uuid(142), '2026-10-05', 'Upper A', { type: 'strength' })],
    reviews: [{ strava_activity_id: gym.strava_activity_id, session_key: uuid(142), decision: 'confirmed' }],
  });
  assert.equal(activityItem(confirmed, gym.strava_activity_id).status, 'programmed');
  assert.equal(activityItem(confirmed, gym.strava_activity_id).match.via, 'coach');
  assert.equal(sessionResult(confirmed, uuid(142)).completion, 'coach_confirmed');
});

test("an athlete's \"Not this run\" is honoured, and their recorded match is reused", () => {
  const a = activity('2026-10-05', 'Run', 10, 55, { time: '06:00' });
  const b = activity('2026-10-05', 'Run', 9.8, 54, { time: '18:00' });
  const plannedRows = [session(uuid(151), '2026-10-05', 'Easy Run — 10km', { km: 10 })];
  const athleteRejected = classify({
    activities: [a, b], plannedRows,
    athleteRejections: { [uuid(151)]: [String(a.strava_activity_id)] },
  });
  assert.equal(activityItem(athleteRejected, a.strava_activity_id).status, 'unprogrammed');
  assert.equal(activityItem(athleteRejected, b.strava_activity_id).status, 'programmed');

  const recorded = classify({
    activities: [a, b], plannedRows,
    logs: { [uuid(151)]: { __stravaMatch: { activityKey: String(b.strava_activity_id), activityKeys: [String(b.strava_activity_id)], confidence: 'high' } } },
  });
  assert.equal(activityItem(recorded, b.strava_activity_id).match.via, 'athlete');
  assert.equal(activityItem(recorded, a.strava_activity_id).status, 'unprogrammed');
});

test('strength sessions pair with same-day weight training; generic workouts go to review', () => {
  const weights = activity('2026-10-06', 'WeightTraining', null, 60);
  const workout = activity('2026-10-07', 'Workout', null, 45);
  const result = classify({
    activities: [weights, workout],
    plannedRows: [
      session(uuid(161), '2026-10-06', 'Lower A', { type: 'strength' }),
      session(uuid(162), '2026-10-07', 'Upper B', { type: 'strength' }),
    ],
  });
  assert.equal(activityItem(result, weights.strava_activity_id).status, 'programmed');
  assert.equal(activityItem(result, workout.strava_activity_id).status, 'needs_review');
});

test('rescheduled sessions match on the day the athlete moved them to', () => {
  const run = activity('2026-10-07', 'Run', 10, 55);
  const result = classify({
    activities: [run],
    plannedRows: [session(uuid(171), '2026-10-06', 'Easy Run — 10km', { km: 10 })],
    reschedules: { [uuid(171)]: '2026-10-07' },
  });
  assert.equal(activityItem(result, run.strava_activity_id).status, 'programmed');
  assert.equal(sessionResult(result, uuid(171)).date, '2026-10-07');
});

// ── 18: deletions ────────────────────────────────────────────────────────────

test('18. a deleted Strava activity disappears and its match stops applying', () => {
  const run = activity('2026-10-05', 'Run', 10, 55);
  const plannedRows = [session(uuid(181), '2026-10-05', 'Easy Run — 10km', { km: 10 })];
  const reviews = [{ strava_activity_id: run.strava_activity_id, session_key: uuid(181), decision: 'confirmed' }];
  const logs = { [uuid(181)]: { __stravaMatch: { activityKey: String(run.strava_activity_id), confidence: 'high' } } };
  const before = classify({ activities: [run], plannedRows, reviews, logs, todayISO: '2026-10-12' });
  assert.equal(sessionResult(before, uuid(181)).status, 'completed');

  // The portal's webhook deletes the cache row; the decision rows remain.
  const after = classify({ activities: [], plannedRows, reviews, logs, todayISO: '2026-10-12' });
  assert.equal(after.items.filter(i => i.kind === 'activity').length, 0);
  assert.equal(sessionResult(after, uuid(181)).status, 'missed');

  // A session the athlete also logged stays completed on that record alone.
  const logged = classify({ activities: [], plannedRows, reviews, logs, loggedKeys: new Set([uuid(181)]), todayISO: '2026-10-12' });
  assert.equal(sessionResult(logged, uuid(181)).status, 'completed');
  assert.equal(sessionResult(logged, uuid(181)).completion, 'portal_log');
});

// ── Privacy of the payload ───────────────────────────────────────────────────

test('14a. coaches receive a summary allowlist: no route, coordinates or location', () => {
  const run = activity('2026-10-05', 'Run', 10, 50, { hr: 150, effort: 55, summary: { external_id: 'garmin_ping_1', total_elevation_gain: 80 } });
  const summary = coachActivitySummary(rowToMatcherActivity(run));
  const text = JSON.stringify(summary);
  for (const banned of ['secret_polyline', 'summary_polyline', 'latlng', '-34.9', 'Adelaide', 'access_token', 'refresh_token']) {
    assert.equal(text.includes(banned), false, `${banned} leaked into the coach payload`);
  }
  assert.equal(summary.paceSecPerKm, 300);
  assert.equal(summary.averageHeartrate, 150);
  assert.equal(summary.relativeEffort, 55);
  assert.equal(summary.source, 'Garmin');
  assert.equal(summary.stravaUrl, `https://www.strava.com/activities/${run.strava_activity_id}`);
});

test('sport families cover the Strava types the brief lists', () => {
  assert.deepEqual(
    ['Run', 'TrailRun', 'VirtualRun', 'Ride', 'VirtualRide', 'MountainBikeRide', 'Swim', 'WeightTraining', 'Workout', 'Walk', 'Hike', 'Yoga']
      .map(sportFamily),
    ['running', 'running', 'running', 'cycling', 'cycling', 'cycling', 'swimming', 'strength', 'other', 'walking', 'walking', 'other'],
  );
});

// ── Loader: consent, switch, scope of reads ──────────────────────────────────

function recordingSb(tables) {
  const calls = [];
  const sb = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    const table = path.split('?')[0];
    const handler = tables[table];
    if (handler === undefined) return [];
    return typeof handler === 'function' ? handler(path, options) : handler;
  };
  return { sb, calls };
}

// The projected strava_tokens row: an athlete with Strava connected.
const CONNECTED = path => (path.includes('strava_tokens') ? [{ strava_athlete_id: '555', connected_at: '2026-09-01T00:00:00Z' }] : []);
const NOW = new Date('2026-10-10T02:00:00Z'); // Sat 10 Oct, Adelaide

test('every activity of a connected athlete appears with no further step from the athlete', async () => {
  const { sb, calls } = recordingSb({
    athlete_data: CONNECTED,
    strava_activities: [
      activity('2026-10-10', 'Run', 2.6, 15, { time: '06:00' }),
      activity('2026-10-10', 'Run', 5.7, 31, { time: '07:20' }),
    ],
  });
  const result = await loadCoachStravaActivities({ code: 'THOMAS', sb, now: NOW, env: {} });
  assert.equal(result.connection.status, 'connected');
  assert.deepEqual(result.items.map(i => i.status), ['unprogrammed', 'unprogrammed'],
    'a Saturday with nothing planned still shows both runs, as unprogrammed');
  assert.equal(calls.some(c => c.path.startsWith('strava_coach_sharing')), false, 'no consent table is involved');
});

test('16. a disconnected athlete shows nothing: strava_activities is never read', async () => {
  for (const tokens of [[], [{ strava_athlete_id: null }], [{ strava_athlete_id: 'not-a-number' }]]) {
    const { sb, calls } = recordingSb({ athlete_data: tokens, strava_activities: [activity('2026-10-05', 'Run', 10, 50)] });
    const result = await loadCoachStravaActivities({ code: 'ALVIN', sb, now: NOW, env: {} });
    assert.equal(result.connection.status, 'not_connected');
    assert.deepEqual(result.items, []);
    assert.equal(calls.some(c => c.path.startsWith('strava_activities')), false);
  }
});

test('the kill switch hides the view and reads nothing', async () => {
  for (const value of ['off', 'false', '0', 'no']) {
    const { sb, calls } = recordingSb({ athlete_data: CONNECTED });
    const result = await loadCoachStravaActivities({ code: 'ALVIN', sb, now: NOW, env: { STRAVA_COACH_SHARING: value } });
    assert.equal(result.connection.status, 'disabled');
    assert.equal(calls.length, 0);
  }
});

test('a failed connection read fails closed', async () => {
  const { sb, calls } = recordingSb({ athlete_data: () => { throw new Error('network'); } });
  const result = await loadCoachStravaActivities({ code: 'ALVIN', sb, now: NOW, env: {} });
  assert.equal(result.connection.status, 'unavailable');
  assert.equal(calls.some(c => c.path.startsWith('strava_activities')), false);
});

test('14b. every read is scoped to the athlete and tokens are projected away', async () => {
  const { sb, calls } = recordingSb({
    strava_activities: path => (path.includes('synced_at&order=synced_at') ? [{ synced_at: '2026-10-10T00:00:00Z' }] : [activity('2026-10-05', 'Run', 10, 50)]),
    athlete_data: CONNECTED,
  });
  const result = await loadCoachStravaActivities({ code: 'alvin', sb, now: NOW, env: {} });
  assert.equal(result.athleteCode, 'ALVIN');
  assert.equal(result.items.length, 1);
  const perAthlete = ['strava_activities', 'planned_sessions', 'athlete_data', 'strava_activity_reviews', 'training_session_logs', 'session_logs'];
  calls.filter(c => perAthlete.includes(c.path.split('?')[0])).forEach(c => {
    assert.match(c.path, /athlete_code=eq\.ALVIN/, `${c.path} is not scoped to the athlete`);
  });
  const tokenRead = calls.find(c => c.path.includes('strava_tokens'));
  assert.match(tokenRead.path, /select=strava_athlete_id:value->>strava_athlete_id,connected_at:value->>connected_at/);
  assert.equal(/select=\*|select=value/.test(tokenRead.path), false, 'the token row itself must never be selected');
  assert.ok(calls.some(c => c.path.startsWith('strava_webhook_events?owner_id=eq.555')));
  assert.equal(JSON.stringify(result).includes('secret_polyline'), false);
});

test('15. a Strava rate limit or outage cannot remove cached history: the coach path never calls Strava', async () => {
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async url => { outbound.push(String(url)); throw new Error('no network in this test'); };
  try {
    const { sb } = recordingSb({
      strava_activities: [activity('2026-10-05', 'Run', 10, 50)],
      athlete_data: CONNECTED,
      strava_webhook_events: [{ id: 1 }, { id: 2 }], // backlog while Strava throttles the drain
    });
    const result = await loadCoachStravaActivities({ code: 'ALVIN', sb, now: NOW, env: {} });
    assert.equal(result.items.length, 1, 'the cached activity is still shown');
    assert.equal(result.sync.pendingEvents, 2);
    assert.deepEqual(outbound, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  for (const file of ['server/coach-strava-activities.js', 'server/strava-activity-classifier.js']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.equal(/strava\.com\/(api|oauth)/.test(source), false, `${file} must not talk to Strava`);
    assert.equal(/\bfetch\(/.test(source), false, `${file} must not make network calls of its own`);
  }
});

test('17. history is read from the cache for any range up to 92 days, and no further', async () => {
  const old = activity('2026-07-14', 'Run', 12, 60);
  const { sb, calls } = recordingSb({ athlete_data: CONNECTED, strava_activities: [old] });
  const result = await loadCoachStravaActivities({ code: 'ALVIN', start: '2026-07-13', end: '2026-07-19', sb, now: NOW, env: {} });
  assert.equal(result.items.length, 1);
  assert.match(calls.find(c => c.path.startsWith('strava_activities?') && c.path.includes('and=')).path, /2026-06-22/,
    'the window reaches back four weeks for the trend, and no further');
  assert.throws(() => resolveRange('2026-01-01', '2026-10-01', TODAY), /92 days/);
  assert.deepEqual(resolveRange('', '', TODAY), WEEK);
});

test('connection state: only a numeric Strava athlete id counts as connected', () => {
  assert.equal(connectionState(null).status, 'not_connected');
  assert.equal(connectionState({ strava_athlete_id: '' }).status, 'not_connected');
  assert.equal(connectionState({ strava_athlete_id: '123', connected_at: 'x' }).status, 'connected');
  assert.equal(connectionState(null, { readFailed: true }).status, 'unavailable');
});

// ── Review writes ────────────────────────────────────────────────────────────

test('16b. a coach cannot record a decision for an athlete without Strava connected', async () => {
  const { sb, calls } = recordingSb({ athlete_data: [] });
  await assert.rejects(
    saveStravaReview({ body: { code: 'ALVIN', activityId: '123', sessionKey: uuid(1), decision: 'confirmed' }, coach: { handle: 'KARL' }, sb, env: {} }),
    error => error.status === 403,
  );
  assert.equal(calls.some(c => c.method === 'POST'), false);
});

test('review writes are keyed the way the portal keys sessions, and clear deletes only that pair', async () => {
  const { sb, calls } = recordingSb({
    athlete_data: CONNECTED,
    strava_activities: [{ strava_activity_id: 123 }],
    planned_sessions: [{ id: uuid(9), notion_page_id: 'legacy-notion-id' }],
    strava_activity_reviews: (path, options) => (options.method === 'POST'
      ? [{ ...options.body[0] }]
      : null),
  });
  const saved = await saveStravaReview({ body: { code: 'ALVIN', activityId: '123', sessionKey: uuid(9), decision: 'rejected' }, coach: { handle: 'ALEX' }, sb, env: {} });
  assert.equal(saved.review.sessionKey, 'legacy-notion-id');
  assert.equal(saved.review.decidedBy, 'ALEX');
  const write = calls.find(c => c.method === 'POST');
  assert.equal(write.body[0].athlete_code, 'ALVIN');

  await saveStravaReview({ body: { code: 'ALVIN', activityId: '123', sessionKey: uuid(9), decision: 'clear' }, coach: { handle: 'ALEX' }, sb, env: {} });
  const del = calls.find(c => c.method === 'DELETE');
  assert.match(del.path, /athlete_code=eq\.ALVIN&strava_activity_id=eq\.123&session_key=eq\.legacy-notion-id/);
});

test('review writes refuse another athlete\'s activity and a duplicate confirmation', async () => {
  const notMine = recordingSb({ athlete_data: CONNECTED, strava_activities: [], planned_sessions: [{ id: uuid(9) }] });
  await assert.rejects(
    saveStravaReview({ body: { code: 'ALVIN', activityId: '999', sessionKey: uuid(9), decision: 'confirmed' }, coach: { handle: 'KARL' }, sb: notMine.sb, env: {} }),
    error => error.status === 404,
  );
  const dup = recordingSb({
    athlete_data: CONNECTED,
    strava_activities: [{ strava_activity_id: 1 }],
    planned_sessions: [{ id: uuid(9) }],
    strava_activity_reviews: () => { throw new Error('duplicate key value violates unique constraint "strava_activity_reviews_one_session_per_activity"'); },
  });
  await assert.rejects(
    saveStravaReview({ body: { code: 'ALVIN', activityId: '1', sessionKey: uuid(9), decision: 'confirmed' }, coach: { handle: 'KARL' }, sb: dup.sb, env: {} }),
    error => error.status === 409,
  );
});

// ── API: the coach boundary end to end ───────────────────────────────────────

function responseRecorder() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return value; },
    end() { return undefined; },
  };
}

async function withApi(routes, run) {
  const saved = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'DASHBOARD_ACCESS_KEY', 'STRAVA_COACH_SHARING']
    .map(key => [key, process.env[key]]);
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.DASHBOARD_ACCESS_KEY = 'coach-key';
  delete process.env.STRAVA_COACH_SHARING; // default: on
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    requested.push({ href, method: options.method || 'GET' });
    const path = href.split('/rest/v1/')[1] || '';
    for (const [prefix, value] of routes) {
      if (path.startsWith(prefix)) {
        const body = typeof value === 'function' ? value(path) : value;
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('[]', { status: 200 });
  };
  try {
    const { default: handler } = await import('../api/athletes.js');
    return await run(handler, requested);
  } finally {
    globalThis.fetch = originalFetch;
    saved.forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
}

const ALEX = [{ id: 'c-alex', handle: 'ALEX', name: 'Alex', role: 'coach', enabled: true }];

test('14c. a coach can only open the Strava activity of an athlete they are assigned', async () => {
  await withApi([
    ['coaches?', ALEX],
    ['coach_athletes?', [{ athlete_code: 'NATE' }]],
    ['athlete_data?', path => (path.includes('strava_tokens') ? [{ strava_athlete_id: '555' }] : [])],
    ['strava_activities?', [activity('2026-10-05', 'Run', 10, 50)]],
  ], async (handler, requested) => {
    const res = responseRecorder();
    await handler({
      method: 'GET', query: { action: 'strava_activities', code: 'JORDAN' },
      headers: { 'x-dashboard-key': 'coach-key', 'x-coach-name': 'Alex' },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(requested.some(r => r.href.includes('/strava_activities?')), false, 'nothing read for an unassigned athlete');
    assert.equal(requested.some(r => r.href.includes('strava_tokens')), false, 'not even the connection is checked');

    const allowed = responseRecorder();
    await handler({
      method: 'GET', query: { action: 'strava_activities', code: 'NATE', start: '2026-10-05', end: '2026-10-11' },
      headers: { 'x-dashboard-key': 'coach-key', 'x-coach-name': 'Alex' },
    }, allowed);
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.ok, true);
    assert.equal(allowed.body.items.length, 1);
  });
});

test('14d. without the dashboard key nothing is read at all', async () => {
  await withApi([], async (handler, requested) => {
    const res = responseRecorder();
    await handler({ method: 'GET', query: { action: 'strava_activities', code: 'NATE' }, headers: { authorization: 'Bearer athlete-token' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(requested.length, 0);
  });
});

test('the raw coach Strava endpoint stays blocked: the dashboard reads summaries from the cache only', async () => {
  const source = readFileSync(join(root, 'api', 'strava.js'), 'utf8');
  assert.match(source, /strava_athlete_only/);
  const ui = readFileSync(join(root, 'public', 'strava-activities.js'), 'utf8');
  assert.match(ui, /\/api\/athletes\?action=strava_activities/);
  assert.equal(/['"`]\/api\/strava/.test(ui), false);
  assert.equal(/localStorage\.setItem\([^)]*strava/i.test(ui), false, 'Strava data is never cached in the coach browser');
});
