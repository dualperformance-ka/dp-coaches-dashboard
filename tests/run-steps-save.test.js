// Structured run save and publish (server/programming.js).
//
// The save used to DELETE every run_steps row and then POST the new rows one
// request at a time, so the portal could read a published session with no
// steps or half a workout. It now makes ONE call, rpc/replace_run_steps, which
// swaps the tree in a single transaction. These tests pin that, plus the
// validation backstop and the publish gate.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRunStepRows,
  garminDeliveryStatus,
  readPrescription,
  saveRunSteps,
  setPublishState,
} from '../server/programming.js';

const COACH = { id: 'c1', handle: 'KARL', role: 'admin' };

function session(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    athlete_code: 'THOMAS',
    title: 'Intervals',
    planned_date: '2026-11-12',
    week_label: 'Week 6',
    session_type: 'Speed',
    status: 'Planned',
    publish_state: 'draft',
    prescription_mode: 'legacy',
    locked_at: null,
    programme_week_id: null,
    ...overrides,
  };
}

function fakeSb({ sessionRow = session(), runSteps = [], allowed = null, receipts = [], detail = null, moves = null } = {}) {
  const calls = [];
  const sb = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (path.startsWith('planned_sessions?id=eq.') && path.includes('select=id,athlete_code')) return [sessionRow];
    if (path.startsWith('planned_sessions?id=eq.') && path.includes('select=run_details')) return detail ? [detail] : [];
    if (path.startsWith('planned_sessions?id=eq.') && options.method === 'PATCH') return [];
    if (path.startsWith('coach_athletes')) return allowed ? allowed.map((code) => ({ athlete_code: code })) : [];
    if (path.startsWith('run_steps?')) return runSteps;
    if (path.startsWith('session_exercises?')) return [];
    if (path.startsWith('workout_splits?')) return [];
    if (path.startsWith('garmin_workout_deliveries?')) return receipts;
    if (path.startsWith('athlete_data?')) return moves ? [{ value: moves }] : [];
    if (path === 'rpc/replace_run_steps') return { steps: options.body.p_steps.length };
    if (path === 'programme_change_log') return null;
    throw new Error('unexpected call ' + path);
  };
  sb.calls = calls;
  return sb;
}

// What the browser sends for 10′ WU → 6 × (1 km @ 4:30–4:45 + 90 s) → 10′ CD.
const REFERENCE = [
  { id: 'new-w', step_type: 'warmup', step_order: 0, end: 'time', durationText: '10:00', target: 'effort', effort: 'Easy' },
  { id: 'new-r', step_type: 'repeat', step_order: 1, repeat_count: 6 },
  { id: 'new-i', parent_step_id: 'new-r', step_type: 'interval', step_order: 0, end: 'distance', distance_km: 1, target: 'pace', pace_fast: '4:30', pace_slow: '4:45', coach_notes: 'private' },
  { id: 'new-j', parent_step_id: 'new-r', step_type: 'recovery', step_order: 1, end: 'time', durationText: '1:30', target: 'none' },
  { id: 'new-c', step_type: 'cooldown', step_order: 2, end: 'time', durationText: '10:00', target: 'none' },
];

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

test('a save is exactly one transactional call: no DELETE and no per-row inserts', async () => {
  const sb = fakeSb();
  const result = await saveRunSteps({ session_id: session().id, steps: REFERENCE }, sb, COACH, { uuid });

  const writes = sb.calls.filter((c) => c.method !== 'GET' && c.path !== 'programme_change_log');
  assert.deepEqual(writes.map((c) => c.path), ['rpc/replace_run_steps']);
  assert.equal(sb.calls.filter((c) => c.path.startsWith('run_steps')).length, 0, 'never touches run_steps directly');

  const { p_session_id: sessionId, p_steps: rows, p_publish_state: publish } = writes[0].body;
  assert.equal(sessionId, session().id);
  assert.equal(publish, null, 'a plain save does not change publish state');
  assert.equal(rows.length, 5);
  assert.equal(result.runSteps.length, 5);
  assert.equal(result.prescription_mode, 'structured');
});

test('before the migration is applied, a save fails closed with the fix and never falls back', async () => {
  const base = fakeSb();
  const sb = async (path, options = {}) => {
    if (path === 'rpc/replace_run_steps') {
      base.calls.push({ path, method: 'POST' });
      throw Object.assign(new Error('Could not find the function public.replace_run_steps'), { upstreamCode: 'PGRST202' });
    }
    return base(path, options);
  };
  await assert.rejects(saveRunSteps({ session_id: session().id, steps: REFERENCE }, sb, COACH, { uuid }),
    (error) => error.status === 409 && /migration 20261105000001/.test(error.message) && /Nothing was changed/.test(error.message));
  assert.deepEqual(base.calls.filter((c) => c.method !== 'GET').map((c) => c.path), ['rpc/replace_run_steps']);
});

test('rows get server ids, parents are remapped, and order is per sibling', async () => {
  const sb = fakeSb();
  await saveRunSteps({ session_id: session().id, steps: REFERENCE }, sb, COACH, { uuid });
  const rows = sb.calls.find((c) => c.path === 'rpc/replace_run_steps').body.p_steps;

  assert.ok(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.id)), 'client refs never reach the database');
  const repeat = rows.find((r) => r.step_type === 'repeat');
  const children = rows.filter((r) => r.parent_step_id === repeat.id);
  assert.deepEqual(children.map((r) => [r.step_type, r.step_order]), [['interval', 0], ['recovery', 1]]);
  assert.deepEqual(rows.filter((r) => !r.parent_step_id).map((r) => [r.step_type, r.step_order]),
    [['warmup', 0], ['repeat', 1], ['cooldown', 2]]);

  const interval = children[0];
  assert.deepEqual([interval.distance_km, interval.duration_sec, interval.intensity_type, interval.pace_min, interval.pace_max],
    [1, null, 'pace_range', '4:30', '4:45']);
  assert.equal(children[1].duration_sec, 90);
  assert.ok(rows.every((r) => r.planned_session_id === session().id));
});

test('save and publish travel together in the same call', async () => {
  const sb = fakeSb();
  const result = await saveRunSteps({ session_id: session().id, steps: REFERENCE, publish: true }, sb, COACH, { uuid });
  const call = sb.calls.find((c) => c.path === 'rpc/replace_run_steps');
  assert.equal(call.body.p_publish_state, 'published');
  assert.equal(result.publish_state, 'published');
  assert.equal(sb.calls.filter((c) => c.method === 'PATCH').length, 0, 'no separate publish request that could fail on its own');
});

test('an invalid workout is refused in plain language and nothing is written', async () => {
  const sb = fakeSb();
  const broken = REFERENCE.map((s) => (s.id === 'new-i' ? { ...s, pace_fast: '4.30' } : s));
  await assert.rejects(
    saveRunSteps({ session_id: session().id, steps: broken }, sb, COACH, { uuid }),
    (error) => error.status === 422 && /Step 2\.1 \(Interval\): pace “4\.30” isn’t minutes:seconds per km/.test(error.message)
  );
  assert.equal(sb.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('more than 100 rows is refused, never silently truncated', async () => {
  const sb = fakeSb();
  const many = Array.from({ length: 101 }, (_, i) => ({ id: 's' + i, step_type: 'run', step_order: i, end: 'lap' }));
  await assert.rejects(saveRunSteps({ session_id: session().id, steps: many }, sb, COACH, { uuid }),
    (error) => error.status === 422 && /at most 100 steps; this one has 101/.test(error.message));
  assert.equal(sb.calls.filter((c) => c.path === 'rpc/replace_run_steps').length, 0);
});

test('completed sessions and other coaches’ athletes are refused before any write', async () => {
  const locked = fakeSb({ sessionRow: session({ locked_at: '2026-11-01T00:00:00Z' }) });
  await assert.rejects(saveRunSteps({ session_id: session().id, steps: REFERENCE }, locked, COACH, { uuid }), { status: 409 });
  assert.equal(locked.calls.filter((c) => c.method !== 'GET').length, 0);

  const narrowed = fakeSb({ allowed: ['KHANG'] });
  await assert.rejects(
    saveRunSteps({ session_id: session().id, steps: REFERENCE }, narrowed, { ...COACH, role: 'coach' }, { uuid }),
    { status: 403 }
  );
  assert.equal(narrowed.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('a forged parent or session reference in the body cannot escape the session', async () => {
  const sb = fakeSb();
  const forged = REFERENCE.map((s) => ({ ...s, planned_session_id: 'other-session' }));
  await saveRunSteps({ session_id: session().id, steps: forged }, sb, COACH, { uuid });
  const rows = sb.calls.find((c) => c.path === 'rpc/replace_run_steps').body.p_steps;
  assert.ok(rows.every((r) => r.planned_session_id === session().id));

  const orphan = [{ id: 'a', parent_step_id: '99999999-9999-4999-8999-999999999999', step_type: 'interval', end: 'lap' }];
  await assert.rejects(saveRunSteps({ session_id: session().id, steps: orphan }, fakeSb(), COACH, { uuid }), { status: 422 });
});

test('buildRunStepRows emits parents before their children', () => {
  const steps = REFERENCE.map((s) => globalThis.DPRunWorkout.fromInput(s));
  const rows = buildRunStepRows(steps, 'sess', uuid);
  const seen = new Set();
  for (const row of rows) {
    if (row.parent_step_id) assert.ok(seen.has(row.parent_step_id));
    seen.add(row.id);
  }
});

// ── Publish gate ────────────────────────────────────────────────────────────

const BAD_ROWS = [{ id: 'x', planned_session_id: session().id, step_type: 'run', step_order: 0, distance_km: 1, duration_sec: 300 }];
const GOOD_ROWS = [{ id: 'y', planned_session_id: session().id, step_type: 'run', step_order: 0, distance_km: 8, intensity_type: 'hr_zone', hr_zone: 'Z2' }];

test('publishing a structured run the Garmin converter would reject is refused', async () => {
  const sb = fakeSb({ sessionRow: session({ prescription_mode: 'structured' }), runSteps: BAD_ROWS });
  await assert.rejects(
    setPublishState({ session_ids: [session().id], publish_state: 'published' }, sb, COACH),
    (error) => error.status === 422 && /can’t be published yet.*both a distance and a time/.test(error.message)
  );
  assert.equal(sb.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('a valid structured run, a strength session and a move to draft all publish as before', async () => {
  const good = fakeSb({ sessionRow: session({ prescription_mode: 'structured' }), runSteps: GOOD_ROWS });
  assert.equal((await setPublishState({ session_ids: [session().id], publish_state: 'published' }, good, COACH)).updated, 1);

  const strength = fakeSb({ sessionRow: session({ session_type: 'Strength', prescription_mode: 'structured' }), runSteps: [] });
  assert.equal((await setPublishState({ session_ids: [session().id], publish_state: 'published' }, strength, COACH)).updated, 1);

  // Hiding a broken run must always be possible.
  const draft = fakeSb({ sessionRow: session({ prescription_mode: 'structured', publish_state: 'published' }), runSteps: BAD_ROWS });
  assert.equal((await setPublishState({ session_ids: [session().id], publish_state: 'draft' }, draft, COACH)).publish_state, 'draft');
});

// ── Coach read ──────────────────────────────────────────────────────────────

test('the coach read carries the text prescription for reference and the delivery receipt', async () => {
  const sb = fakeSb({
    detail: { warm_up: '2km easy', intervals: '6x1km', working_pace: '4:30', rest: '90s jog', cool_down: '2km easy', run_details: null, updated_at: '2026-11-05T01:00:00+00:00' },
    receipts: [{ state: 'sent', scheduled_date: '2026-11-12', sent_at: '2026-11-04T09:00:00.000Z', updated_at: '2026-11-04T09:00:00.000Z' }],
  });
  const data = await readPrescription(session().id, sb);
  assert.deepEqual(data.legacyRun.map((r) => r.label), ['Warm up', 'Intervals / sets', 'Working pace', 'Rest between sets', 'Cool down']);
  assert.equal(data.garmin.delivery, 'sent');
  assert.equal(data.garmin.changedSince, true, 'edited after the athlete sent it');
  const receiptCall = sb.calls.find((c) => c.path.startsWith('garmin_workout_deliveries'));
  assert.match(receiptCall.path, /select=state,scheduled_date,sent_at,updated_at&/, 'no Garmin ids or tokens are read');
});

test('delivery status distinguishes none, uncertain, sent and changed-since', () => {
  const s = session();
  assert.deepEqual(garminDeliveryStatus([], s, null, []), { delivery: 'none' });
  assert.equal(garminDeliveryStatus([{ state: 'creating', updated_at: 'x' }], s, null, []).delivery, 'uncertain');
  const sent = [{ state: 'sent', sent_at: '2026-11-04T09:00:00.000Z', scheduled_date: '2026-11-12', updated_at: '2026-11-04T09:00:00.000Z' }];
  assert.equal(garminDeliveryStatus(sent, s, { updated_at: '2026-11-04T08:00:00+00:00' }, []).changedSince, false);
  assert.equal(garminDeliveryStatus(sent, s, { updated_at: '2026-11-04T08:00:00+00:00' }, [{ created_at: '2026-11-04T10:00:00+00:00' }]).changedSince, true);
  assert.equal(garminDeliveryStatus(sent, { ...s, planned_date: '2026-11-13' }, null, []).plannedDateDiffers, true);
});

test('a failed receipt read never breaks the builder', async () => {
  const sb = fakeSb();
  const original = sb;
  const failing = async (path, options) => {
    if (path.startsWith('garmin_workout_deliveries')) throw new Error('relation does not exist');
    return original(path, options);
  };
  const data = await readPrescription(session().id, failing);
  assert.deepEqual(data.garmin, { delivery: 'none' });
});

// ── Audit additions (Nov 2026) ──────────────────────────────────────────────

test('a session completed before locking existed is refused like every other programming write', async () => {
  // locked_at is null on sessions completed before the lock trigger; the
  // database function only checks locked_at, so the server must check status.
  const done = fakeSb({ sessionRow: session({ status: 'Completed', locked_at: null }) });
  await assert.rejects(saveRunSteps({ session_id: session().id, steps: REFERENCE }, done, COACH, { uuid }),
    (error) => error.status === 409 && /Completed/.test(error.message));
  assert.equal(done.calls.filter((c) => c.method !== 'GET').length, 0);

  const untyped = fakeSb({ sessionRow: session({ status: null }) });
  await saveRunSteps({ session_id: session().id, steps: REFERENCE }, untyped, COACH, { uuid });
  assert.equal(untyped.calls.filter((c) => c.path === 'rpc/replace_run_steps').length, 1, 'no status is still editable');
});

test('the Garmin date check follows the athlete’s own move, as Send to Garmin does', async () => {
  const sent = (date) => [{ state: 'sent', scheduled_date: date, sent_at: '2026-11-04T09:00:00.000Z', updated_at: '2026-11-04T09:00:00.000Z' }];
  const detail = { notion_page_id: 'abcdefabcdefabcdefabcdefabcdef12', updated_at: '2026-11-04T08:00:00+00:00' };

  // Athlete moved the run to the 14th and sent it: Garmin matches, no warning.
  let data = await readPrescription(session().id, fakeSb({ detail, receipts: sent('2026-11-14'), moves: { [detail.notion_page_id]: '2026-11-14' } }));
  assert.equal(data.garmin.plannedDateDiffers, false);
  assert.equal(data.garmin.athleteMovedTo, '2026-11-14');

  // Sent for the planned 12th, then the athlete moved it: Garmin is stale.
  data = await readPrescription(session().id, fakeSb({ detail, receipts: sent('2026-11-12'), moves: { [detail.notion_page_id]: '2026-11-14' } }));
  assert.equal(data.garmin.plannedDateDiffers, true);

  // Sessions without a Notion id are keyed by their own id.
  data = await readPrescription(session().id, fakeSb({ detail: { updated_at: detail.updated_at }, receipts: sent('2026-11-12'), moves: { [session().id]: '2026-11-15' } }));
  assert.equal(data.garmin.athleteMovedTo, '2026-11-15');
  assert.equal(data.garmin.plannedDateDiffers, true);

  // A move is shown even before anything is sent, and a garbage value is ignored.
  assert.equal(garminDeliveryStatus([], session(), null, [], '2026-11-14').athleteMovedTo, '2026-11-14');
  data = await readPrescription(session().id, fakeSb({ detail, moves: { [detail.notion_page_id]: 'soon' } }));
  assert.deepEqual(data.garmin, { delivery: 'none' });
});
