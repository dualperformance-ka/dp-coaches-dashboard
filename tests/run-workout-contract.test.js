// Contract test: the coach builder against the athlete portal's ACTUAL
// Garmin converter, not a description of it.
//
// tests/fixtures/portal-garmin-workouts.js is a verbatim copy of
// dp-athlete-portal/api/_lib/garmin-workouts.js. Rows are produced by the
// dashboard's real save path (fromInput → validate → buildRunStepRows), passed
// through JSON the way PostgREST returns them, and fed to buildRunningWorkout().
//
// The promise under test: anything the builder calls Garmin-ready, the portal
// converts; anything the portal refuses, the builder never calls ready.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import '../public/run-workout.js';
import { buildRunStepRows } from '../server/programming.js';
import {
  buildRunningWorkout,
  GARMIN_RUN_SESSION_TYPES as PORTAL_TYPES,
} from './fixtures/portal-garmin-workouts.js';

const R = globalThis.DPRunWorkout;
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/garmin-acceptance-fixture.json', import.meta.url), 'utf8'));

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
// What the portal reads back: plain JSON, numeric columns as numbers.
const viaDatabase = (rows) => JSON.parse(JSON.stringify(rows));
const PORTAL_COLUMNS = ['id', 'parent_step_id', 'step_order', 'step_type', 'repeat_count', 'distance_km', 'duration_sec',
  'intensity_type', 'pace_min', 'pace_max', 'hr_zone', 'rpe', 'effort', 'instructions'];
// The portal selects exactly these columns (loadWorkoutPrescription); coach_notes is not among them.
const asPortalReads = (rows) => viaDatabase(rows).map((row) => Object.fromEntries(PORTAL_COLUMNS.map((k) => [k, row[k] ?? null])));

function convert(session, builderInput) {
  const steps = builderInput.map(R.fromInput);
  const report = R.validate(session, steps);
  const rows = report.valid ? buildRunStepRows(steps, 'sess', uuid) : null;
  return { steps, report, rows, workout: rows && report.garminReady ? buildRunningWorkout(session, asPortalReads(rows)) : null };
}

function leafCount(steps, times = 1) {
  return steps.reduce((sum, step) => sum + (step.type === 'WorkoutRepeatStep' ? leafCount(step.steps, times * step.repeatValue) : times), 0);
}

// ── Acceptance fixture ──────────────────────────────────────────────────────

test('acceptance fixture: 10′ WU → 6 × (1 km @ 4:30–4:45 + 90″) → 10′ CD converts exactly', () => {
  const { report, rows, workout } = convert(FIXTURE.session, FIXTURE.builderSteps);

  assert.equal(report.valid, true);
  assert.equal(report.garminReady, true, report.blockers.join('; '));
  assert.equal(report.rows, FIXTURE.expectedCounts.rows);
  assert.equal(report.expandedSteps, FIXTURE.expectedCounts.expandedGarminSteps);
  assert.equal(report.totals.distanceKm, FIXTURE.expectedCounts.distanceKm);
  assert.equal(report.totals.durationSec, FIXTURE.expectedCounts.durationSec);

  // The run_steps rows the coach's save writes.
  const refOf = new Map(rows.map((row, i) => [row.id, FIXTURE.expectedRunStepRows[i].ref]));
  const written = rows.map((row) => {
    const { id, planned_session_id, parent_step_id, ...rest } = row;
    return { ref: refOf.get(id), parent: parent_step_id ? refOf.get(parent_step_id) : null, ...rest };
  });
  assert.deepEqual(written, FIXTURE.expectedRunStepRows);

  // What the athlete's Send to Garmin posts.
  assert.deepEqual(workout, FIXTURE.expectedGarminWorkout);
  assert.equal(leafCount(workout.segments[0].steps), FIXTURE.expectedCounts.expandedGarminSteps);
});

// ── Other shapes the brief names ────────────────────────────────────────────

test('continuous run, heart-rate target, lap-button step and RPE/effort convert as the coach sees them', () => {
  const session = { title: 'Mixed', session_type: 'Easy Effort', prescription_mode: 'structured' };
  const { report, workout } = convert(session, [
    { id: 'a', step_type: 'run', step_order: 0, end: 'distance', distance_km: 8, target: 'none', instructions: 'Conversational' },
    { id: 'b', step_type: 'run', step_order: 1, end: 'time', durationText: '40:00', target: 'hr', hr_zone: '2' },
    { id: 'c', step_type: 'run', step_order: 2, end: 'lap', target: 'effort', effort: 'Strides on the straights', instructions: 'Press lap when done' },
    { id: 'd', step_type: 'run', step_order: 3, end: 'time', durationText: '5 min', target: 'rpe', rpe: 7, coach_notes: 'PRIVATE-NOTE' },
  ]);
  assert.equal(report.garminReady, true);
  const [continuous, hr, open, rpe] = workout.segments[0].steps;

  assert.deepEqual([continuous.durationType, continuous.durationValue, continuous.targetType, continuous.description],
    ['DISTANCE', 8000, 'OPEN', 'Conversational']);
  assert.deepEqual([hr.durationType, hr.durationValue, hr.targetType, hr.targetValue], ['TIME', 2400, 'HEART_RATE', 2]);
  // Lap button: OPEN duration with no value. Effort reaches the watch as text.
  assert.deepEqual([open.durationType, open.durationValue, open.targetType], ['OPEN', null, 'OPEN']);
  assert.equal(open.description, 'Strides on the straights Press lap when done');
  // The converter's own text, trailing space included when there are no instructions.
  assert.deepEqual([rpe.targetType, rpe.description], ['OPEN', 'RPE 7/10. ']);

  assert.ok(!JSON.stringify(workout).includes('PRIVATE-NOTE'), 'coach notes never reach Garmin');
  assert.ok(report.notes.some((n) => /open target/.test(n.message)), 'the coach is told RPE/effort are text');
});

test('a nested repeat converts with the expanded count the builder shows', () => {
  const { report, workout } = convert({ title: 'Sets', session_type: 'VO2', prescription_mode: 'structured' }, [
    { id: 'o', step_type: 'repeat', step_order: 0, repeat_count: 3 },
    { id: 'i', parent_step_id: 'o', step_type: 'repeat', step_order: 0, repeat_count: 4 },
    { id: 'x', parent_step_id: 'i', step_type: 'interval', step_order: 0, end: 'distance', distance_km: 0.2, target: 'pace', pace_fast: '3:30', pace_slow: '3:40' },
    { id: 'y', parent_step_id: 'i', step_type: 'recovery', step_order: 1, end: 'time', durationText: '60s', target: 'none' },
    { id: 'z', parent_step_id: 'o', step_type: 'rest', step_order: 1, end: 'time', durationText: '3:00', target: 'none' },
  ]);
  assert.equal(report.garminReady, true);
  assert.equal(report.expandedSteps, 27);
  assert.equal(leafCount(workout.segments[0].steps), 27);
  assert.equal(workout.segments[0].steps[0].steps[0].steps[0].durationValue, 200);
});

// ── Session types ───────────────────────────────────────────────────────────

test('the builder and the portal accept exactly the same session types', () => {
  assert.deepEqual([...R.GARMIN_RUN_SESSION_TYPES].sort(), [...PORTAL_TYPES].sort());
  const steps = FIXTURE.builderSteps;
  for (const type of ['Speed', 'Easy Effort', 'Long Run', 'Tempo', 'Recovery', 'running', 'Run']) {
    assert.equal(convert({ ...FIXTURE.session, session_type: type }, steps).report.garminReady, true, type);
  }
  for (const type of ['Strength', 'Brick', 'Run + Strength', 'Optional', 'Weekly KM Total', 'Swim', null]) {
    const { report } = convert({ ...FIXTURE.session, session_type: type }, steps);
    assert.equal(report.garminReady, false, String(type));
    assert.throws(() => buildRunningWorkout({ ...FIXTURE.session, session_type: type }, asPortalReads(buildRunStepRows(steps.map(R.fromInput), 's', uuid))), /Only running sessions/);
  }
});

// ── Agreement under random input ────────────────────────────────────────────
// Deterministic PRNG so a failure reproduces.
function prng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const SESSION_TYPES = ['Speed', 'Easy Effort', 'Long Run', 'Strength', 'Brick', null, 'run'];

// Rows as they can exist in the database: the run_steps CHECK constraints
// limit step_type and intensity_type and tie repeat_count to repeats.
function randomRows(rand) {
  const rows = []; let n = 0;
  function add(parent, depth, order) {
    const id = `r${++n}`;
    const repeat = depth < 4 && rand() < 0.2;
    if (repeat) {
      rows.push({ id, parent_step_id: parent, step_order: order, step_type: 'repeat', repeat_count: pick(rand, [1, 2, 6, 6, 12, 40, 101]) });
      const kids = 1 + Math.floor(rand() * 3) - (rand() < 0.1 ? 1 : 0);
      for (let i = 0; i < kids; i += 1) add(id, depth + 1, i);
      return;
    }
    const intensity = pick(rand, [null, null, null, 'pace', 'pace_range', 'hr', 'hr_zone', 'rpe', 'effort', 'text']);
    const clean = rand() < 0.6; // most rows are well formed, as real saves are
    rows.push({
      id, parent_step_id: parent, step_order: order,
      step_type: pick(rand, ['warmup', 'run', 'interval', 'recovery', 'rest', 'cooldown']),
      repeat_count: null,
      ...(clean ? (rand() < 0.5 ? { distance_km: pick(rand, [1, 0.4, 5]), duration_sec: null }
        : { distance_km: null, duration_sec: pick(rand, [null, 90, 600]) })
        : { distance_km: pick(rand, [null, null, 1, 0.4, 5, 0, 0.4005]), duration_sec: pick(rand, [null, null, 90, 600, 0]) }),
      intensity_type: intensity,
      pace_min: clean ? pick(rand, ['4:30', '4:45', '4:30/km']) : pick(rand, [null, '4:30', '4:45', '1:29', '30:01', 'fast', '4:30/km']),
      pace_max: clean ? pick(rand, [null, '4:45', '4:20']) : pick(rand, [null, null, '4:45', '4:20', 'slow']),
      hr_zone: clean ? pick(rand, ['Z2', '5', 'zone 3']) : pick(rand, [null, 'Z2', '5', 'zone 3', '6', 'Z0']),
      rpe: clean ? pick(rand, [7, 10, 3]) : pick(rand, [null, 7, 0, 11, 10]),
      effort: clean ? 'Easy' : pick(rand, [null, '', 'Easy']),
      instructions: pick(rand, [null, 'Relax the shoulders']),
    });
  }
  const top = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < top; i += 1) add(null, 0, i);
  return rows;
}

test('5,000 random database workouts: whatever the portal refuses, the builder never calls Garmin-ready', () => {
  const rand = prng(20261106);
  let refused = 0, ready = 0;
  for (let i = 0; i < 5000; i += 1) {
    const rows = randomRows(rand);
    const session = { title: 'Fuzz', session_type: pick(rand, SESSION_TYPES), prescription_mode: 'structured' };
    let portalError = null;
    try { buildRunningWorkout(session, viaDatabase(rows)); } catch (error) { portalError = error; }
    const report = R.validate(session, rows.map(R.fromRow));
    if (portalError) {
      refused += 1;
      assert.equal(report.garminReady, false, `case ${i}: portal refused (${portalError.message}) but builder said ready\n${JSON.stringify(rows)}`);
    }
    if (report.garminReady) ready += 1;
  }
  assert.ok(refused > 1000 && ready > 500, `fuzz covers both outcomes (refused ${refused}, ready ${ready})`);
});

test('5,000 random builder workouts: whatever the builder saves as ready, the portal converts with the same step count', () => {
  const rand = prng(1106);
  let checked = 0;
  for (let i = 0; i < 5000; i += 1) {
    const rows = randomRows(rand);
    const session = { title: 'Fuzz', session_type: pick(rand, SESSION_TYPES), prescription_mode: 'structured' };
    const steps = rows.map(R.fromRow);
    const report = R.validate(session, steps);
    if (!report.garminReady) continue;
    // Re-save through the coach save path, then read as the portal does.
    const saved = asPortalReads(buildRunStepRows(steps, 'sess', uuid));
    const workout = buildRunningWorkout(session, saved);
    assert.equal(leafCount(workout.segments[0].steps), report.expandedSteps, `case ${i}`);
    checked += 1;
  }
  assert.ok(checked > 500, `checked ${checked}`);
});
