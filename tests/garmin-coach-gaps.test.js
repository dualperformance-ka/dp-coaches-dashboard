// Coach-side gaps before Send to Garmin goes to clients:
//   - Start from text: a session's own text prescription → draft steps the
//     coach reviews. Never saved by itself, never guesses a target.
//   - Garmin readiness for the next 14 days, by the same rules as the builder.
//   - Delivery states a coach can act on, and the coach reset for a lost create.
//   - The AI analysis never receives connected-provider data.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import '../public/run-workout.js';
import { garminDeliveryStatus, garminReadiness, resetGarminReceipt } from '../server/programming.js';

const R = globalThis.DPRunWorkout;
const ADMIN = { id: 'c1', handle: 'KARL', role: 'admin' };
const SCOPED = { id: 'c2', handle: 'ALEX', role: 'coach' };
const SID = '11111111-1111-4111-8111-111111111111';
const shape = (steps) => steps.map((s) => [s.step_type, s.repeat_count, s.end, s.distance_km, s.duration_sec, s.target, s.pace_fast, s.pace_slow]);

// ── Start from text ──────────────────────────────────────────────────────────

test('the acceptance session drafts from its text into exactly the coach fixture', () => {
  const draft = R.fromLegacyRun({ title: '6 × 1 km', warm_up: '10min easy', intervals: '6 x 1km', working_pace: '4:30-4:45', rest: '90s jog', cool_down: '10min easy' });
  assert.deepEqual(shape(draft.steps), [
    ['warmup', null, 'time', null, 600, 'effort', '', ''],
    ['repeat', 6, 'lap', null, null, 'none', '', ''],
    ['interval', null, 'distance', 1, null, 'pace', '4:30', '4:45'],
    ['recovery', null, 'time', null, 90, 'effort', '', ''],
    ['cooldown', null, 'time', null, 600, 'effort', '', ''],
  ]);
  assert.equal(R.validate({ session_type: 'Intervals', prescription_mode: 'structured' }, draft.steps).valid, true);
  assert.ok(draft.notes.some((n) => /pace target on the main set/.test(n)), 'the coach is told the pace was placed');
});

test('a stated pace becomes a pace range in either order; a pace word stays text', () => {
  for (const pace of ['4:45-4:30', '4:30 to 4:45 /km', '4:30–4:45 min/km']) {
    const interval = R.fromLegacyRun({ intervals: '6 x 1km', working_pace: pace }).steps.find((s) => s.step_type === 'interval');
    assert.deepEqual([interval.target, interval.pace_fast, interval.pace_slow], ['pace', '4:30', '4:45'], pace);
  }
  const single = R.fromLegacyRun({ intervals: '8km steady', working_pace: '5:10 /km' }).steps[0];
  assert.deepEqual([single.target, single.pace_fast, single.pace_slow], ['pace', '5:10', '']);
  const word = R.fromLegacyRun({ intervals: '5 x 1km', working_pace: 'Threshold' });
  const rep = word.steps.find((s) => s.step_type === 'interval');
  assert.equal(rep.target, 'effort');assert.equal(rep.effort, 'Threshold');
  assert.ok(word.notes.some((n) => /effort word/.test(n)));
});

test('nothing is guessed: no pace stays open and says so; unreadable text builds nothing', () => {
  const open = R.fromLegacyRun({ intervals: '6 x 1km', rest: '2min walk' });
  assert.equal(open.steps.find((s) => s.step_type === 'interval').target, 'none');
  assert.ok(open.notes.some((n) => /no pace/.test(n)));
  const none = R.fromLegacyRun({ warm_up: 'Included', intervals: 'Hills, feel it out' });
  assert.equal(none.steps.length, 0);assert.match(none.notes[0], /Add the steps yourself/);
  const range = R.fromLegacyRun({ warm_up: '10-15min easy', intervals: '6 x 1km' });
  assert.equal(range.steps[0].duration_sec, 600);assert.ok(range.notes.some((n) => /low end/.test(n)));
});

test('Start from text is offered only on an empty builder with text, and only drafts', () => {
  const builder = readFileSync(new URL('../public/run-builder.js', import.meta.url), 'utf8');
  assert.match(builder, /\(hasText\(\) \? '<button type="button" class="rx-btn" data-quick="text"/);
  assert.match(builder, /if \(state\.steps\.length\) return;\n    if \(kind === 'text'\)/, 'never applied over existing steps');
  const quick = builder.slice(builder.indexOf('function quickStart'), builder.indexOf('// The run’s text prescription') > 0 ? builder.indexOf('// The run’s text prescription') : builder.indexOf("// The run's text prescription"));
  assert.doesNotMatch(quick, /apiPost|save\(|publish/, 'drafting never saves or publishes');
  const plan = readFileSync(new URL('../public/plan-session-run.js', import.meta.url), 'utf8');
  assert.match(plan, /legacyText: function \(\)/, 'Plan Session drafts from the text fields as they are now');
});

// ── Delivery states and the coach reset ──────────────────────────────────────

test('a lost create needs a coach check, a lost calendar entry the athlete can finish', () => {
  const s = { id: SID, planned_date: '2026-11-12' };
  assert.equal(garminDeliveryStatus([{ state: 'creating', updated_at: '2026-11-06T00:00:00Z' }], s, null, []).delivery, 'needs_check');
  assert.equal(garminDeliveryStatus([{ state: 'scheduling', scheduled_date: '2026-11-12', updated_at: '2026-11-06T00:00:00Z' }], s, null, []).delivery, 'calendar_unconfirmed');
  const builder = readFileSync(new URL('../public/run-builder.js', import.meta.url), 'utf8');
  for (const words of ['Saved to Garmin Connect.', 'Out of date in Garmin.', 'Calendar not confirmed, athlete can finish.', 'Needs coach check.']) assert.ok(builder.includes(words), words);
});

function resetSb({ session, allowed = ['KARL'], cleared = 1 }) {
  const calls = [];
  const sb = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (path.startsWith('planned_sessions?id=eq.')) return session ? [session] : [];
    if (path.startsWith('coach_athletes')) return allowed.map((code) => ({ athlete_code: code }));
    if (path.startsWith('garmin_workout_deliveries')) return Array.from({ length: cleared }, () => ({ state: 'retryable' }));
    throw new Error('unexpected ' + path);
  };
  return { sb, calls };
}

test('the coach reset only moves a creating receipt to retryable, for an allowed athlete', async () => {
  const session = { id: SID, athlete_code: 'karl', planned_date: '2026-11-12', status: 'Planned' };
  const { sb, calls } = resetSb({ session });
  assert.deepEqual(await resetGarminReceipt({ session_id: SID }, sb, ADMIN), { ok: true, cleared: 1 });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, `garmin_workout_deliveries?athlete_code=eq.KARL&planned_session_id=eq.${SID}&state=eq.creating`);
  assert.deepEqual(Object.keys(patch.body).sort(), ['fingerprint', 'owner_id', 'schedule_id', 'scheduled_date', 'state', 'updated_at', 'workout_id']);
  assert.equal(patch.body.state, 'retryable');
  await assert.rejects(resetGarminReceipt({ session_id: SID }, resetSb({ session, cleared: 0 }).sb, ADMIN), /Nothing to clear/);
  const scoped = resetSb({ session, allowed: ['THOMAS'] });
  await assert.rejects(resetGarminReceipt({ session_id: SID }, scoped.sb, SCOPED));
  assert.equal(scoped.calls.some((c) => c.method === 'PATCH'), false, 'no write for an athlete the coach may not touch');
});

// ── Readiness ────────────────────────────────────────────────────────────────

test('readiness lists the next 14 days of running sessions with the builder’s own verdict', async () => {
  const rows = [
    { id: 'a', title: 'Intervals', session_type: 'Intervals', planned_date: '2026-11-07', publish_state: 'published', prescription_mode: 'structured', status: 'Planned' },
    { id: 'b', title: 'Tempo', session_type: 'Tempo', planned_date: '2026-11-08', publish_state: 'draft', prescription_mode: 'structured', status: 'Planned' },
    { id: 'c', title: 'Easy', session_type: 'Easy Effort', planned_date: '2026-11-09', publish_state: 'published', prescription_mode: 'legacy', status: 'Planned' },
    { id: 'd', title: 'Broken', session_type: 'VO2', planned_date: '2026-11-10', publish_state: 'published', prescription_mode: 'structured', status: 'Planned' },
    { id: 'e', title: 'Upper A', session_type: 'Strength', planned_date: '2026-11-10', publish_state: 'published', prescription_mode: 'structured', status: 'Planned' },
    { id: 'f', title: 'Brick', session_type: 'Brick', planned_date: '2026-11-11', publish_state: 'published', prescription_mode: 'legacy', status: 'Planned' },
  ];
  const steps = [
    { id: 's1', planned_session_id: 'a', step_type: 'run', step_order: 0, distance_km: 5 },
    { id: 's2', planned_session_id: 'b', step_type: 'run', step_order: 0, duration_sec: 1200 },
    { id: 's3', planned_session_id: 'd', step_type: 'run', step_order: 0, distance_km: 1, duration_sec: 300 },
  ];
  const queries = [];
  const sb = async (path) => {
    queries.push(path);
    if (path.startsWith('coach_athletes')) return [{ athlete_code: 'KARL' }];
    if (path.startsWith('planned_sessions?')) return rows;
    if (path.startsWith('run_steps?')) return steps;
    if (path.startsWith('garmin_workout_deliveries?')) return [{ planned_session_id: 'a', state: 'sent' }];
    throw new Error('unexpected ' + path);
  };
  const out = await garminReadiness('karl', sb, SCOPED, { now: new Date('2026-11-06T03:00:00Z') });
  assert.equal(out.from, '2026-11-06');assert.equal(out.to, '2026-11-19');
  assert.match(queries.find((q) => q.startsWith('planned_sessions?')), /athlete_code=eq\.KARL&planned_date=gte\.2026-11-06&planned_date=lte\.2026-11-19/);
  assert.deepEqual(out.items.map((i) => [i.id, i.status, i.draft, i.delivery]), [
    ['a', 'ready', false, 'sent'], ['b', 'ready', true, null], ['c', 'text_only', false, null], ['d', 'needs_fixing', false, null],
  ]);
  assert.match(out.items[2].reason, /Start from text/);
  assert.match(out.items[3].reason, /distance or a time|both/i);
  assert.deepEqual(out.counts, { ready: 2, text_only: 1, needs_fixing: 1 });
  await assert.rejects(garminReadiness('THOMAS', async (p) => (p.startsWith('coach_athletes') ? [{ athlete_code: 'KARL' }] : []), SCOPED));
});

// ── AI input boundary ────────────────────────────────────────────────────────

test('the AI analysis and the coach weekly summary read no connected-provider data', () => {
  // dualperformance.au/privacy: the AI summary "never receives data from a
  // connected device". The portal asserts its half in tests/garmin.test.js.
  for (const file of ['../api/analyse.js', '../server/coach-weekly-summary.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    assert.doesNotMatch(source, /strava_activities|garmin_activities|garmin_dailies|garmin_sleeps|garmin_connections/, file);
  }
});
