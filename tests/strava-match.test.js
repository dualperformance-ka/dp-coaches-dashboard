import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD,
  classifyPrescribedIntensity,
  matchActivityToSession,
  stravaActivityKey,
} from '../public/js/strava-match.js';

const root = new URL('..', import.meta.url).pathname;
const loggingSource = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');

function rejectionHelpers(){
  const start=loggingSource.indexOf('function removeLatestStravaRejection');
  const end=loggingSource.indexOf('function stravaMatchActivityKey',start);
  assert.ok(start>=0&&end>start,'Strava rejection helper should remain discoverable');
  const context={};vm.createContext(context);vm.runInContext(loggingSource.slice(start,end),context);return context;
}

const session = { id: 'long-run', date: '2026-08-04', plannedKm: 12 };
const run = (id, km, extra = {}) => ({
  id,
  sport_type: 'Run',
  start_date_local: '2026-08-04T07:00:00',
  distance: km * 1000,
  moving_time: 3600,
  ...extra,
});

test('exact distance match completes with high confidence', () => {
  const result = matchActivityToSession(session, [run(1, 12)]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'high');
  assert.equal(result.activity.id, 1);
});

test('15% over and 15% under both complete', () => {
  assert.equal(matchActivityToSession(session, [run(2, 13.8)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(3, 10.2)]).matched, true);
});

test('a 12km prescription has no upper distance limit but keeps its lower bound', () => {
  assert.equal(matchActivityToSession(session, [run(17, 14.35)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(18, 15)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(19, 30)]).matched, true);
  assert.equal(matchActivityToSession(session, [run(20, 10.19)]).matched, false);
});

test('a 30km run completes a 10km prescription', () => {
  const result = matchActivityToSession({ ...session, plannedKm: 10 }, [run(21, 30)]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'high');
  assert.equal(result.activity.id, 21);
});

test('a 4km commute ride does not complete a 12km run session', () => {
  const result = matchActivityToSession(session, [run(4, 4, { sport_type: 'Ride' })]);
  assert.equal(result.matched, false);
});

test('a short commute run is outside the planned-distance tolerance', () => {
  assert.equal(matchActivityToSession(session, [run(5, 4)]).matched, false);
});

test('WeightTraining never matches a run session', () => {
  const result = matchActivityToSession(session, [run(6, 12, { sport_type: 'WeightTraining' })]);
  assert.equal(result.matched, false);
});

test('two runs on one day map to two sessions, not one twice', () => {
  const activities = [run(7, 5.1), run(8, 12.1)];
  const first = matchActivityToSession({ id: 'easy', date: session.date, plannedKm: 5 }, activities);
  const second = matchActivityToSession(session, activities, {
    claimedActivityIds: [stravaActivityKey(first.activity)],
  });
  assert.equal(first.activity.id, 7);
  assert.equal(second.activity.id, 8);
});

test('a session with no planned distance returns low confidence', () => {
  const result = matchActivityToSession({ id: 'open-run', date: session.date }, [run(9, 13.1)]);
  assert.equal(result.matched, true);
  assert.equal(result.confidence, 'low');
});

test('a rejected pairing is not re-suggested', () => {
  const result = matchActivityToSession(session, [run(10, 12)], {
    rejections: { 'long-run': ['10'] },
  });
  assert.equal(result.matched, false);
  assert.ok(result.reasons.includes('rejected'));
});

test('undo removes only the latest rejection for the selected session', () => {
  const original={ easy: ['activity-1','activity-2'], tempo: ['activity-3'] };
  const restored=rejectionHelpers().removeLatestStravaRejection(original,'easy');
  assert.deepEqual(JSON.parse(JSON.stringify(restored)),{ easy: ['activity-1'], tempo: ['activity-3'] });
  assert.deepEqual(original,{ easy: ['activity-1','activity-2'], tempo: ['activity-3'] });
});

test('undo clears the session rejection key after restoring its only activity', () => {
  const restored=rejectionHelpers().removeLatestStravaRejection({ easy: ['activity-1'] },'easy');
  assert.deepEqual(JSON.parse(JSON.stringify(restored)),{});
});

test('prescribed tempo run at 2.4 relative effort per km downgrades to low confidence', () => {
  const tempo = { ...session, name: 'Tempo — 4 × 1500m' };
  const activity = run(11, 12, { relative_effort: 12 * 2.4 });
  const result = matchActivityToSession(tempo, [activity]);
  assert.equal(DEFAULT_RELATIVE_EFFORT_PER_KM_THRESHOLD, 3.0);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.reasons, ['intensity_below_prescription']);
});

test('prescribed tempo run at 5.4 relative effort per km stays high confidence', () => {
  const tempo = { ...session, name: 'Tempo — 4 x 1500m' };
  const result = matchActivityToSession(tempo, [run(12, 12, { relative_effort: 12 * 5.4 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

test('prescribed easy run executed at 5.4 relative effort per km stays high and is flagged for coaches', () => {
  const easy = { ...session, name: 'Easy 12km' };
  const result = matchActivityToSession(easy, [run(13, 12, { relative_effort: 12 * 5.4 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, ['ran_above_prescription']);
});

test('missing relative effort leaves the previous result unchanged', () => {
  const tempo = { ...session, name: 'Threshold intervals' };
  const result = matchActivityToSession(tempo, [run(14, 12)]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

test('zero relative effort is treated as absent rather than easy', () => {
  const tempo = { ...session, name: 'Hill repeats — 12 x 90s' };
  const result = matchActivityToSession(tempo, [run(15, 12, { relative_effort: 0 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});

test('an unparseable session name is unknown and does not downgrade', () => {
  const unknown = { ...session, name: 'Wednesday Run' };
  assert.equal(classifyPrescribedIntensity(unknown), 'unknown');
  const result = matchActivityToSession(unknown, [run(16, 12, { relative_effort: 12 * 2.4 })]);
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.reasons, []);
});
