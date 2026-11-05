// Structured run rules shared by the coach builder and the server.
//
// These mirror the athlete portal's Garmin converter
// (dp-athlete-portal/api/_lib/garmin-workouts.js). Every "rejects" case here
// is one the converter refuses, so the builder catches it before an athlete
// taps Send to Garmin and gets an error instead of a workout.

import assert from 'node:assert/strict';
import test from 'node:test';

import '../public/run-workout.js';

const R = globalThis.DPRunWorkout;
const RUN = { id: 'sess-1', session_type: 'Speed', title: 'Intervals', publish_state: 'draft' };

// Builder shape for: 10 min warm-up → 6 × (1 km @ 4:30–4:45 + 90 s) → 10 min cool-down.
function reference() {
  return [
    { id: 'w', step_type: 'warmup', step_order: 0, end: 'time', durationText: '10:00', target: 'effort', effort: 'Easy' },
    { id: 'r', step_type: 'repeat', step_order: 1, repeat_count: 6 },
    { id: 'i', parent_step_id: 'r', step_type: 'interval', step_order: 0, end: 'distance', distance_km: 1, target: 'pace', pace_fast: '4:30', pace_slow: '4:45', instructions: 'Smooth and controlled', coach_notes: 'Watch her cadence' },
    { id: 'j', parent_step_id: 'r', step_type: 'recovery', step_order: 1, end: 'time', durationText: '90s', target: 'none' },
    { id: 'c', step_type: 'cooldown', step_order: 2, end: 'time', durationText: '10', target: 'effort', effort: 'Easy' },
  ].map(R.fromInput);
}

const messages = (report) => report.errors.map((e) => e.message).join('\n');

test('pace and time parse the way coaches write them', () => {
  assert.equal(R.parsePace('4:30'), 270);
  assert.equal(R.parsePace('4:30/km'), 270);
  assert.equal(R.parsePace('4:30 min/km'), 270);
  assert.ok(Number.isNaN(R.parsePace('4.30')));
  assert.ok(Number.isNaN(R.parsePace('4:3')));
  assert.equal(R.formatPace(285), '4:45');

  assert.equal(R.parseDuration('10:00'), 600);
  assert.equal(R.parseDuration('1:30'), 90);
  assert.equal(R.parseDuration('90s'), 90);
  assert.equal(R.parseDuration('90 sec'), 90);
  assert.equal(R.parseDuration('10'), 600, 'a bare number is minutes');
  assert.equal(R.parseDuration('10 min'), 600);
  assert.equal(R.parseDuration('1:05:00'), 3900);
  assert.equal(R.parseDuration(''), null);
  assert.ok(Number.isNaN(R.parseDuration('ten')));
  assert.equal(R.formatDuration(90), '1:30');
  assert.equal(R.humanDuration(90), '1 min 30 s');
  assert.equal(R.humanDistance(0.4), '400 m');
});

test('the reference interval session is valid, Garmin-ready and counted the way the converter counts', () => {
  const report = R.validate(RUN, reference());
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.garminReady, true);
  // warm-up + 6 × (interval + recovery) + cool-down
  assert.equal(report.expandedSteps, 14);
  assert.equal(report.totals.distanceKm, 6);
  assert.equal(report.totals.durationSec, 600 + 6 * 90 + 600);
});

test('a continuous run is valid with distance, time or the lap button', () => {
  for (const step of [
    { end: 'distance', distance_km: 12, target: 'hr', hr_zone: '2' },
    { end: 'time', durationText: '45:00', target: 'rpe', rpe: 4 },
    { end: 'lap', target: 'none' },
  ]) {
    const report = R.validate(RUN, [R.fromInput({ id: 'a', step_type: 'run', ...step })]);
    assert.equal(report.valid, true, messages(report));
  }
});

test('rows written for the portal use the converter contract exactly', () => {
  const steps = reference();
  const rows = steps.map((s, i) => R.toRow(s, 'sess-1', 'id-' + s.id, s.parent_step_id ? 'id-' + s.parent_step_id : null, s.step_order));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  assert.deepEqual(
    { type: byId['id-w'].step_type, duration: byId['id-w'].duration_sec, distance: byId['id-w'].distance_km, intensity: byId['id-w'].intensity_type, effort: byId['id-w'].effort },
    { type: 'warmup', duration: 600, distance: null, intensity: 'effort', effort: 'Easy' }
  );
  assert.equal(byId['id-r'].repeat_count, 6);
  assert.equal(byId['id-r'].distance_km, null);
  const interval = byId['id-i'];
  assert.equal(interval.parent_step_id, 'id-r');
  assert.equal(interval.distance_km, 1);
  assert.equal(interval.duration_sec, null, 'never both distance and time');
  assert.equal(interval.intensity_type, 'pace_range');
  assert.equal(interval.pace_min, '4:30', 'pace_min is the faster pace');
  assert.equal(interval.pace_max, '4:45');
  assert.equal(interval.instructions, 'Smooth and controlled');
  assert.equal(interval.coach_notes, 'Watch her cadence', 'kept for the coach; the portal never selects it');
  assert.equal(byId['id-j'].duration_sec, 90);
  assert.equal(byId['id-j'].intensity_type, null);
});

test('pace entered slow-first is stored fast-first; a single pace is a pace target', () => {
  const [swapped] = [R.fromInput({ id: 'a', step_type: 'interval', end: 'distance', distance_km: 1, target: 'pace', pace_fast: '4:45', pace_slow: '4:30' })];
  const row = R.toRow(swapped, 's', 'x', null, 0);
  assert.equal(row.pace_min, '4:30');
  assert.equal(row.pace_max, '4:45');

  const single = R.toRow(R.fromInput({ id: 'b', step_type: 'run', end: 'distance', distance_km: 5, target: 'pace', pace_fast: '5:00' }), 's', 'y', null, 0);
  assert.equal(single.intensity_type, 'pace');
  assert.equal(single.pace_min, '5:00');
  assert.equal(single.pace_max, null);
});

test('heart-rate, RPE and effort targets carry only their own column', () => {
  const hr = R.toRow(R.fromInput({ id: 'a', step_type: 'run', end: 'lap', target: 'hr', hr_zone: '3', pace_fast: '4:00', rpe: 9 }), 's', 'x', null, 0);
  assert.deepEqual([hr.intensity_type, hr.hr_zone, hr.pace_min, hr.rpe], ['hr_zone', 'Z3', null, null]);
  const rpe = R.toRow(R.fromInput({ id: 'b', step_type: 'run', end: 'lap', target: 'rpe', rpe: 7 }), 's', 'y', null, 0);
  assert.deepEqual([rpe.intensity_type, rpe.rpe, rpe.hr_zone], ['rpe', 7, null]);
});

test('a database row reads back into the same builder step', () => {
  const steps = reference();
  const rows = steps.map((s) => R.toRow(s, 'sess-1', s.id, s.parent_step_id, s.step_order));
  const back = rows.map(R.fromRow);
  const report = R.validate(RUN, back);
  assert.equal(report.valid, true, messages(report));
  assert.equal(report.expandedSteps, 14);
  const interval = back.find((s) => s.id === 'i');
  assert.equal(interval.end, 'distance');
  assert.equal(interval.target, 'pace');
  const lap = R.fromRow({ id: 'l', step_type: 'run' });
  assert.equal(lap.end, 'lap', 'no distance and no time is an explicit lap-button step');
});

test('step problems are explained in plain language with a step number', () => {
  const cases = [
    [{ end: 'distance', distance_km: null }, /Step 1 \(Run\): needs a distance in km, or choose “Lap button”/],
    [{ end: 'time', durationText: 'soon' }, /time isn’t readable/],
    [{ end: 'distance', distance_km: 0 }, /more than 0 km/],
    [{ end: 'lap', target: 'pace', pace_fast: '4.30' }, /isn’t minutes:seconds per km/],
    [{ end: 'lap', target: 'pace', pace_fast: '0:59' }, /between 1:30 and 30:00/],
    [{ end: 'lap', target: 'pace', pace_fast: '' }, /needs a pace/],
    [{ end: 'lap', target: 'hr', hr_zone: '6' }, /heart-rate zone from 1 to 5/],
    [{ end: 'lap', target: 'rpe', rpe: 11 }, /RPE from 1 to 10/],
    [{ end: 'lap', target: 'effort', effort: '' }, /needs an effort description/],
    [{ end: 'lap', instructions: 'x'.repeat(501) }, /instructions are too long/],
  ];
  for (const [patch, pattern] of cases) {
    const report = R.validate(RUN, [R.fromInput({ id: 'a', step_type: 'run', ...patch })]);
    assert.equal(report.valid, false, JSON.stringify(patch));
    assert.match(messages(report), pattern);
  }
});

test('a legacy row with both distance and time is flagged, not silently resolved', () => {
  const report = R.validate(RUN, [R.fromRow({ id: 'a', step_type: 'run', distance_km: 1, duration_sec: 300 })]);
  assert.match(messages(report), /both a distance and a time/);
});

test('repeat trees: empty, bad counts, orphans, cycles and over-nesting are refused', () => {
  const empty = R.validate(RUN, [R.fromInput({ id: 'r', step_type: 'repeat', repeat_count: 3 })]);
  assert.match(messages(empty), /has no steps inside it/);

  for (const count of [0, 101, 2.5, null]) {
    const steps = [
      R.fromInput({ id: 'r', step_type: 'repeat', repeat_count: count }),
      R.fromInput({ id: 'a', parent_step_id: 'r', step_type: 'interval', end: 'lap' }),
    ];
    assert.match(messages(R.validate(RUN, steps)), /whole number of rounds between 1 and 100/, String(count));
  }

  const orphan = R.validate(RUN, [R.fromInput({ id: 'a', parent_step_id: 'gone', step_type: 'run', end: 'lap' })]);
  assert.match(messages(orphan), /no longer exists/);

  const cycle = R.validate(RUN, [
    R.fromInput({ id: 'x', parent_step_id: 'y', step_type: 'repeat', repeat_count: 2 }),
    R.fromInput({ id: 'y', parent_step_id: 'x', step_type: 'repeat', repeat_count: 2 }),
  ]);
  assert.match(messages(cycle), /loop of repeat blocks/);

  const notRepeat = R.validate(RUN, [
    R.fromInput({ id: 'a', step_type: 'run', end: 'lap' }),
    R.fromInput({ id: 'b', parent_step_id: 'a', step_type: 'run', end: 'lap' }),
  ]);
  assert.match(messages(notRepeat), /not a repeat block/);

  // Converter: a repeat inside a repeat is fine, one more level is not.
  const nested = [
    R.fromInput({ id: 'r1', step_type: 'repeat', repeat_count: 2 }),
    R.fromInput({ id: 'r2', parent_step_id: 'r1', step_type: 'repeat', repeat_count: 2 }),
    R.fromInput({ id: 'a', parent_step_id: 'r2', step_type: 'interval', end: 'lap' }),
  ];
  assert.equal(R.validate(RUN, nested).valid, true, messages(R.validate(RUN, nested)));
  const tooDeep = nested.concat([
    R.fromInput({ id: 'r3', parent_step_id: 'r2', step_type: 'repeat', repeat_count: 2 }),
    R.fromInput({ id: 'b', parent_step_id: 'r3', step_type: 'interval', end: 'lap' }),
  ]);
  assert.match(messages(R.validate(RUN, tooDeep)), /nested too deeply/);
});

test('the 100-step Garmin limit counts expanded repeats, and refuses rather than truncating', () => {
  const steps = [
    R.fromInput({ id: 'r', step_type: 'repeat', repeat_count: 51 }),
    R.fromInput({ id: 'a', parent_step_id: 'r', step_type: 'interval', end: 'distance', distance_km: 0.2 }),
    R.fromInput({ id: 'b', parent_step_id: 'r', step_type: 'recovery', end: 'time', durationText: '30s' }),
  ];
  const report = R.validate(RUN, steps);
  assert.equal(report.expandedSteps, 102);
  assert.match(messages(report), /102 Garmin steps\. Garmin allows 100/);

  steps[0].repeat_count = 50;
  assert.equal(R.validate(RUN, steps).valid, true);

  const rows = Array.from({ length: 101 }, (_, i) => R.fromInput({ id: 's' + i, step_type: 'run', step_order: i, end: 'lap' }));
  assert.match(messages(R.validate(RUN, rows)), /101 rows/);
});

test('session types the portal will not send are a blocker, not a step error', () => {
  const brick = R.validate({ ...RUN, session_type: 'Brick' }, reference());
  assert.equal(brick.valid, true);
  assert.equal(brick.garminReady, false);
  assert.match(brick.blockers.join(' '), /“Brick” is not a running type/);

  const untyped = R.validate({ ...RUN, session_type: null }, reference());
  assert.match(untyped.blockers.join(' '), /no type/);

  for (const type of ['Run', 'running', 'Easy Effort', 'Tempo', 'Speed', 'Long Run', 'Recovery', 'race', 'Threshold', 'VO2']) {
    assert.equal(R.sessionSendsToGarmin({ session_type: type }), true, type);
  }
  for (const type of ['Strength', 'Run + Strength', 'Brick', 'Optional', 'Weekly KM Total', 'Swim', 'Cycling', '']) {
    assert.equal(R.sessionSendsToGarmin({ session_type: type }), false, type);
  }
});

test('RPE and effort are explained as on-screen text, never as a watch alert', () => {
  const report = R.validate(RUN, reference());
  assert.match(report.notes.map((n) => n.message).join(' '), /reach the watch as text on screen/);
});

test('the preview reads in running order with repeats nested', () => {
  const nodes = R.tree(reference());
  assert.deepEqual(nodes.map((n) => n.label), [
    'Warm-up · 10 min · Easy',
    'Repeat 6 times',
    'Cool-down · 10 min · Easy',
  ]);
  assert.deepEqual(nodes[1].children.map((n) => n.label), [
    'Interval · 1 km · 4:30–4:45 /km',
    'Recovery · 1 min 30 s',
  ]);
});

test('fromInput drops anything that is not a builder field', () => {
  const step = R.fromInput({ id: 'a', step_type: 'run', end: 'lap', planned_session_id: 'someone-else', athlete_code: 'X', coach_notes: 'ok' });
  assert.equal(step.planned_session_id, undefined);
  assert.equal(step.athlete_code, undefined);
  assert.equal(step.coach_notes, 'ok');
});

// ── Audit additions (Nov 2026) ──────────────────────────────────────────────

test('distances are whole metres, the unit Garmin ends a distance step on', () => {
  const step = (km) => R.fromInput({ id: 'd', step_type: 'run', step_order: 0, end: 'distance', distance_km: km, target: 'none' });
  for (const km of [1, 0.4, 1.609, 21.0975 - 0.0005, 0.001]) assert.equal(R.validate(RUN, [step(km)]).valid, true, String(km));
  const bad = R.validate(RUN, [step(0.4005)]);
  assert.equal(bad.valid, false);
  assert.match(messages(bad), /whole metres/);
  // Stored rounded to the metre, so km × 1000 is the metre count the portal sends.
  assert.equal(R.toRow(step(1.609), 's', 'x', null, 0).distance_km, 1.609);
});

test('a single pace is valid but the coach is told the watch band is zero-width', () => {
  const single = R.fromInput({ id: 'p', step_type: 'interval', step_order: 0, end: 'distance', distance_km: 1, target: 'pace', pace_fast: '4:30' });
  const report = R.validate(RUN, [single]);
  assert.equal(report.valid, true);
  assert.ok(report.notes.some((n) => /zero-width/.test(n.message) && /4:30–4:40/.test(n.message)));
  const range = R.validate(RUN, reference());
  assert.ok(!range.notes.some((n) => /zero-width/.test(n.message)), 'a real range carries no warning');
});
