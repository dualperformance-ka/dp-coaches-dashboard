import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanExerciseFields,
  materialiseSession,
  parseRepRange,
  parseRestSeconds,
  splitEntryToExercise,
} from '../server/programming.js';

// ── Parsing the shapes that already exist in workout_splits ──────────────────

test('rep ranges parse the way coaches actually write them', () => {
  assert.deepEqual(parseRepRange('8-12'), { min: 8, max: 12 });
  assert.deepEqual(parseRepRange('8–12'), { min: 8, max: 12 });   // en dash
  assert.deepEqual(parseRepRange('8 to 12'), { min: 8, max: 12 });
  assert.deepEqual(parseRepRange('6'), { min: 6, max: 6 });
  assert.deepEqual(parseRepRange(''), { min: null, max: null });
  assert.deepEqual(parseRepRange(null), { min: null, max: null });
});

test('rest parses seconds and minutes', () => {
  assert.equal(parseRestSeconds('90s'), 90);
  assert.equal(parseRestSeconds('180'), 180);
  assert.equal(parseRestSeconds('2 min'), 120);
  assert.equal(parseRestSeconds('1.5m'), 90);
  assert.equal(parseRestSeconds(''), null);
});

// A real row from the live DP S2 Lower C split.
const REAL_ENTRY = {
  alts: ['Seated Hamstring Curl'],
  reps: '8',
  rest: '90s',
  sets: '3',
  notes: 'RIR 1,0,0',
  exercise: 'Lying Down Hamstring Curl',
  repRange: '8-12',
  warmupSets: '0',
  workingSets: '3',
};

test('a live split entry maps cleanly onto a session exercise', () => {
  const row = splitEntryToExercise(REAL_ENTRY, 2, 'sess-1', 'split-9');
  assert.equal(row.planned_session_id, 'sess-1');
  assert.equal(row.exercise_name, 'Lying Down Hamstring Curl');
  assert.equal(row.position, 2);
  assert.equal(row.sets, 3);
  assert.equal(row.working_sets, 3);
  assert.equal(row.warmup_sets, 0);
  assert.equal(row.rep_min, 8);
  assert.equal(row.rep_max, 12);
  assert.equal(row.rest_seconds, 90);
  assert.deepEqual(row.alternatives, ['Seated Hamstring Curl']);
  assert.equal(row.source_split_id, 'split-9');
});

test("a split's note stays athlete-facing, because it always has been", () => {
  // The portal renders workout_splits notes in the exercise card today.
  // Migrating them to coach_notes would silently remove guidance athletes rely on.
  const row = splitEntryToExercise(REAL_ENTRY, 0, 'sess-1', null);
  assert.equal(row.athlete_notes, 'RIR 1,0,0');
  assert.equal(row.coach_notes, undefined);
});

test('unilateral metadata survives the mapping', () => {
  const row = splitEntryToExercise({
    exercise: 'Bulgarian Split Squat',
    repMode: 'left_right',
    leftRightExercises: ['Bulgarian Split Squat', 'Reverse Lunge'],
    repRange: '8-12',
  }, 0, 'sess-1', null);
  assert.equal(row.rep_mode, 'left_right');
  assert.deepEqual(row.left_right_exercises, ['Bulgarian Split Squat', 'Reverse Lunge']);
});

// ── Field sanitisation ───────────────────────────────────────────────────────

test('only known columns survive a field update', () => {
  const cleaned = cleanExerciseFields({
    sets: '4',
    rpe: '8.5',
    coach_notes: 'private',
    planned_session_id: 'sess-hijack',   // not editable
    id: 'other-row',                     // not editable
    created_at: '2020-01-01',            // not editable
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['coach_notes', 'rpe', 'sets']);
  assert.equal(cleaned.sets, 4, 'numbers are coerced');
  assert.equal(cleaned.rpe, 8.5, 'decimals are preserved');
});

test('a nonsense rep mode falls back rather than reaching the database', () => {
  assert.equal(cleanExerciseFields({ rep_mode: 'sideways' }).rep_mode, 'reps');
  assert.equal(cleanExerciseFields({ rep_mode: 'left_right' }).rep_mode, 'left_right');
});

test('alternatives are bounded and stringified', () => {
  const many = Array.from({ length: 40 }, (_, i) => `Alt ${i}`);
  assert.equal(cleanExerciseFields({ alternatives: many }).alternatives.length, 20);
  assert.deepEqual(cleanExerciseFields({ alternatives: 'not-an-array' }).alternatives, []);
});

// ── Lazy materialisation ─────────────────────────────────────────────────────

const COACH = { handle: 'KARL', role: 'admin' };

function sbFor({ session, splits = [], onWrite = () => {} }) {
  return async function sb(path, options) {
    if (options && options.method) { onWrite(path, options); return [{ id: 'new-row' }]; }
    if (path.startsWith('planned_sessions?id=eq.')) return [session];
    if (path.startsWith('workout_splits?')) return splits;
    if (path.startsWith('session_exercises?')) return [];
    return [];
  };
}

test('an already-structured session is left completely alone', async () => {
  const writes = [];
  const session = { id: 's1', athlete_code: 'JORDAN', title: 'Upper A', prescription_mode: 'structured', locked_at: null };
  const result = await materialiseSession('s1', sbFor({ session, onWrite: (p) => writes.push(p) }), COACH);

  assert.equal(result.created, 0);
  assert.equal(writes.length, 0, 'materialising twice must not duplicate exercises');
});

test('a completed session cannot be taken off its split', async () => {
  const session = { id: 's1', athlete_code: 'JORDAN', title: 'Upper A', prescription_mode: 'legacy', locked_at: '2026-08-10T09:00:00Z' };
  await assert.rejects(
    () => materialiseSession('s1', sbFor({ session }), COACH),
    (error) => error.status === 409
  );
});

test('materialising copies the matched split and flips the session to structured', async () => {
  const writes = [];
  const session = { id: 's1', athlete_code: 'JORDAN', title: 'Upper A', prescription_mode: 'legacy', locked_at: null };
  const splits = [{
    id: 'split-1', name: 'Upper A', athlete_code: null,
    exercises: [REAL_ENTRY, { exercise: 'Bench Press', sets: '4', repRange: '6-8', rest: '180s' }],
  }];

  const result = await materialiseSession('s1', sbFor({
    session, splits, onWrite: (path, options) => writes.push({ path, options }),
  }), COACH);

  assert.equal(result.created, 2);
  assert.equal(result.source, 'Upper A');

  const insert = writes.find((w) => w.path === 'session_exercises');
  assert.ok(insert, 'exercises are inserted');
  assert.equal(insert.options.body.length, 2);
  assert.equal(insert.options.body[0].planned_session_id, 's1');

  const patch = writes.find((w) => w.path.startsWith('planned_sessions?id=eq.'));
  assert.equal(patch.options.body.prescription_mode, 'structured');
});

test('an athlete-specific split beats the global one of the same name', async () => {
  // Mirrors the portal's own resolution order, so taking control of a session
  // gives the athlete exactly what they were already seeing.
  const writes = [];
  const session = { id: 's1', athlete_code: 'JORDAN', title: 'Upper A', prescription_mode: 'legacy', locked_at: null };
  const splits = [
    { id: 'global', name: 'Upper A', athlete_code: null, exercises: [{ exercise: 'Global Bench' }] },
    { id: 'jordan', name: 'Upper A', athlete_code: 'JORDAN', exercises: [{ exercise: 'Jordan Bench' }] },
  ];

  await materialiseSession('s1', sbFor({ session, splits, onWrite: (p, o) => writes.push({ p, o }) }), COACH);
  const insert = writes.find((w) => w.p === 'session_exercises');
  assert.equal(insert.o.body[0].exercise_name, 'Jordan Bench');
  assert.equal(insert.o.body[0].source_split_id, 'jordan');
});

test('the longest matching split name wins', async () => {
  // "DP S2 Lower C" must beat "Lower C", exactly as GYM_KEYS does in the portal.
  const writes = [];
  const session = { id: 's1', athlete_code: 'JORDAN', title: 'DP S2 Lower C', prescription_mode: 'legacy', locked_at: null };
  const splits = [
    { id: 'short', name: 'Lower C', athlete_code: null, exercises: [{ exercise: 'Short Match' }] },
    { id: 'long', name: 'DP S2 Lower C', athlete_code: null, exercises: [{ exercise: 'Long Match' }] },
  ];

  await materialiseSession('s1', sbFor({ session, splits, onWrite: (p, o) => writes.push({ p, o }) }), COACH);
  const insert = writes.find((w) => w.p === 'session_exercises');
  assert.equal(insert.o.body[0].exercise_name, 'Long Match');
});

test('a session with no matching split becomes structured but empty', async () => {
  const writes = [];
  const session = { id: 's1', athlete_code: 'JORDAN', title: 'Arms + Shoulders', prescription_mode: 'legacy', locked_at: null };

  const result = await materialiseSession('s1', sbFor({
    session, splits: [], onWrite: (p, o) => writes.push({ p, o }),
  }), COACH);

  assert.equal(result.created, 0);
  assert.equal(result.source, null);
  assert.ok(!writes.some((w) => w.p === 'session_exercises'), 'no empty insert');
  assert.ok(writes.some((w) => w.p.startsWith('planned_sessions?id=eq.')), 'still flips to structured');
});
