// Duplicating a session must carry the structured prescription.
//
// Why this test exists: duplicatePlanSession() cloned an allowlist of
// planned_sessions columns and nothing else, and plan_insert posted that single
// row. session_exercises and run_steps -- which is where every prescription the
// Phase 2/3 builder writes actually lives -- were left behind, so a duplicated
// session reached the athlete with no exercises and no run steps while the coach
// was told it had been copied. Phase 3's prescribed-vs-actual then had nothing to
// match the copy against.
//
// The fake Supabase below records every request, so these tests assert on what
// would reach the database rather than on the shape of the return value.

import assert from 'node:assert/strict';
import test from 'node:test';

import { copyPrescription } from '../server/programming.js';
import { insertPlannedSessions } from '../api/athletes.js';

function fakeSb({ exercises = [], steps = [] } = {}) {
  const calls = [];
  let nextId = 0;
  const sb = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });

    if (options.method === 'POST' && path === 'planned_sessions') {
      return [{ id: 'new-session', ...(Array.isArray(options.body) ? options.body[0] : options.body) }];
    }
    if (options.method === 'POST' && path === 'run_steps') {
      nextId += 1;
      return [{ id: `new-step-${nextId}` }];
    }
    if (options.method === 'POST' && path === 'session_exercises') return [];
    if (options.method === 'PATCH') return [];
    if (path.startsWith('session_exercises?')) return exercises;
    if (path.startsWith('run_steps?')) return steps;
    return [];
  };
  sb.calls = calls;
  return sb;
}

const EXERCISES = [
  { id: 'ex-1', planned_session_id: 'src', created_at: 'x', updated_at: 'y',
    exercise_name: 'Back Squat', position: 0, sets: 4, rep_min: 6, rep_max: 8, target_load: 110 },
  { id: 'ex-2', planned_session_id: 'src', created_at: 'x', updated_at: 'y',
    exercise_name: 'Romanian Deadlift', position: 1, sets: 3, rep_min: 8, rep_max: 10 },
];

// A repeat block and its two children: the shape that breaks a naive copy,
// because the children point at a parent id that only exists on the source.
const STEPS = [
  { id: 'st-wu', planned_session_id: 'src', parent_step_id: null, step_order: 0, step_type: 'warmup', distance_km: 2 },
  { id: 'st-rp', planned_session_id: 'src', parent_step_id: null, step_order: 1, step_type: 'repeat', repeat_count: 5 },
  { id: 'st-wk', planned_session_id: 'src', parent_step_id: 'st-rp', step_order: 0, step_type: 'interval', distance_km: 1, pace_min: '4:00' },
  { id: 'st-rc', planned_session_id: 'src', parent_step_id: 'st-rp', step_order: 1, step_type: 'recovery', duration_sec: 90 },
];

test('copying a strength prescription reassigns every exercise to the new session', async () => {
  const sb = fakeSb({ exercises: EXERCISES });
  const result = await copyPrescription('src', 'new-session', sb);

  assert.equal(result.copiedExercises, 2);
  const insert = sb.calls.find(c => c.path === 'session_exercises' && c.method === 'POST');
  assert.ok(insert, 'the exercises must actually be written, not just read');
  assert.equal(insert.body.length, 2);
  for (const row of insert.body) {
    assert.equal(row.planned_session_id, 'new-session');
    // The source row's identity and timestamps must not travel: reusing them
    // would collide on the primary key or backdate the copy.
    assert.ok(!('id' in row));
    assert.ok(!('created_at' in row));
    assert.ok(!('updated_at' in row));
  }
  assert.deepEqual(insert.body.map(r => r.exercise_name), ['Back Squat', 'Romanian Deadlift']);
  assert.equal(insert.body[0].target_load, 110);
});

test('copying a structured run remaps repeat children onto the new parent id', async () => {
  const sb = fakeSb({ steps: STEPS });
  const result = await copyPrescription('src', 'new-session', sb);

  assert.equal(result.copiedSteps, 4);
  const inserts = sb.calls.filter(c => c.path === 'run_steps' && c.method === 'POST');
  assert.equal(inserts.length, 4);

  const written = inserts.map(c => c.body[0]);
  const parents = written.filter(r => r.parent_step_id === null);
  const children = written.filter(r => r.parent_step_id !== null);
  assert.equal(parents.length, 2);
  assert.equal(children.length, 2);

  // The whole point: children must attach to the id the database assigned to the
  // copied repeat block, never to the source's id.
  for (const child of children) {
    assert.match(child.parent_step_id, /^new-step-/);
    assert.notEqual(child.parent_step_id, 'st-rp');
    assert.equal(child.planned_session_id, 'new-session');
  }
  assert.equal(written.find(r => r.step_type === 'repeat').repeat_count, 5);
  assert.equal(written.find(r => r.step_type === 'interval').pace_min, '4:00');
});

test('a run step whose parent did not copy is reported, never dropped quietly', async () => {
  // The parent is missing from the source set, so its child has nothing to
  // attach to. Silently skipping it would understate the prescription.
  const sb = fakeSb({ steps: [
    { id: 'st-orphan', planned_session_id: 'src', parent_step_id: 'gone', step_order: 0, step_type: 'interval', distance_km: 1 },
  ]});
  await assert.rejects(
    () => copyPrescription('src', 'new-session', sb),
    /no parent to attach to/
  );
});

test('plan_insert with copy_from carries the prescription and sets the mode', async () => {
  const sb = fakeSb({ steps: STEPS });
  const out = await insertPlannedSessions(
    { athlete_code: 'KAI', planned_date: '2026-09-12', title: 'Threshold 5x1km' },
    sb,
    'src'
  );

  assert.equal(out.ok, true);
  assert.equal(out.copied.copiedSteps, 4);
  const stepWrites = sb.calls.filter(c => c.path === 'run_steps' && c.method === 'POST');
  assert.equal(stepWrites.length, 4, 'the duplicate must arrive with its run steps');

  // A copy that keeps the legacy mode would not open the structured editor and
  // run analysis would not look for steps.
  const patch = sb.calls.find(c => c.method === 'PATCH' && c.path.startsWith('planned_sessions?id='));
  assert.ok(patch, 'prescription_mode must follow the prescription');
  assert.equal(patch.body.prescription_mode, 'structured');
});

test('plan_insert without copy_from is unchanged', async () => {
  const sb = fakeSb({ steps: STEPS });
  const out = await insertPlannedSessions(
    { athlete_code: 'KAI', planned_date: '2026-09-12', title: 'Easy 8km' },
    sb
  );

  assert.equal(out.ok, true);
  assert.equal(out.copied, undefined);
  assert.equal(sb.calls.filter(c => c.path === 'run_steps').length, 0);
  assert.equal(sb.calls.filter(c => c.path === 'session_exercises').length, 0);
});

test('a prescription cannot be copied onto a batch insert', async () => {
  const sb = fakeSb();
  await assert.rejects(
    () => insertPlannedSessions(
      [{ athlete_code: 'KAI', planned_date: '2026-09-12' }, { athlete_code: 'KAI', planned_date: '2026-09-13' }],
      sb,
      'src'
    ),
    /single new session/
  );
});
