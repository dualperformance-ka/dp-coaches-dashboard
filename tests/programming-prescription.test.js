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

// ── Save a session back out as a split (§39) ─────────────────────────────────

import { exerciseToSplitEntry, saveSessionAsSplit } from '../server/programming.js';

test('a split survives the round trip out to a session and back', async () => {
  // The strongest guarantee available here: materialising a split into a
  // session and then saving that session as a split must not quietly drop
  // sets, rep ranges, rest, alternatives or unilateral metadata.
  const original = {
    exercise: 'Bulgarian Split Squat',
    sets: '4',            // total, warm-up included — the editor's convention
    reps: '8',
    repRange: '8-12',
    rest: '90s',
    warmupSets: '1',
    workingSets: '3',
    notes: 'RIR 1,0,0',
    alts: ['Reverse Lunge', 'Dumbbell Split Squat'],
    repMode: 'left_right',
    leftRightExercises: ['Bulgarian Split Squat', 'Reverse Lunge'],
  };

  const asRow = splitEntryToExercise(original, 0, 'sess-1', 'split-1');
  const backAgain = exerciseToSplitEntry(asRow);

  assert.equal(backAgain.exercise, original.exercise);
  assert.equal(backAgain.repRange, original.repRange);
  assert.equal(backAgain.rest, original.rest);
  assert.equal(backAgain.warmupSets, original.warmupSets);
  assert.equal(backAgain.workingSets, original.workingSets);
  assert.equal(backAgain.sets, original.sets, 'sets stays warm-up + working');
  assert.equal(backAgain.notes, original.notes);
  assert.deepEqual(backAgain.alts, original.alts);
  assert.equal(backAgain.repMode, 'left_right');
  assert.deepEqual(backAgain.leftRightExercises, original.leftRightExercises);
});

test('a plain bilateral exercise round-trips without gaining stray metadata', () => {
  const row = splitEntryToExercise(
    { exercise: 'Bench Press', sets: '4', repRange: '6-8', rest: '180s', warmupSets: '2', workingSets: '4' },
    0, 'sess-1', null
  );
  const entry = exerciseToSplitEntry(row);
  assert.equal('repMode' in entry, false, 'no rep mode on a normal exercise');
  assert.equal('leftRightExercises' in entry, false);
  assert.equal(entry.sets, '6', '2 warm-up + 4 working');
});

test('a coach-only note never reaches a saved split', async () => {
  // workout_splits.exercises[].notes is rendered to athletes by the portal, so
  // a private note copied in here would be published to everyone.
  const writes = [];
  const sb = async (path, options) => {
    if (options && options.method === 'POST') { writes.push({ path, options }); return [{ id: 'new-split', name: 'Lower C', athlete_code: null }]; }
    if (path.startsWith('planned_sessions?id=eq.')) {
      return [{ id: 's1', athlete_code: 'ALEX', title: 'Lower C', status: 'Planned', locked_at: null }];
    }
    if (path.startsWith('session_exercises?')) {
      return [{ exercise_name: 'Leg Extension', sets: 4, warmup_sets: 1, working_sets: 3,
                rep_min: 8, rep_max: 12, rest_seconds: 90,
                athlete_notes: 'First set warm-up',
                coach_notes: 'knee is grumpy, do not tell him',
                alternatives: [], left_right_exercises: [], rep_mode: 'reps' }];
    }
    return [];
  };

  const result = await saveSessionAsSplit(
    { session_id: 's1', name: 'Lower C' }, sb, { handle: 'KARL', role: 'admin' }
  );

  assert.equal(result.exercises, 1);
  assert.equal(result.scope, 'all athletes');

  const insert = writes.find((w) => w.path === 'workout_splits');
  const serialised = JSON.stringify(insert.options.body);
  assert.ok(!serialised.includes('grumpy'), 'coach note must not reach the split');
  assert.ok(serialised.includes('First set warm-up'), 'athlete note does');
});

test('a duplicate split name is refused rather than silently shadowing', async () => {
  // (name, athlete_code) is UNIQUE, but Postgres treats NULLs as distinct — so
  // two shared splits of the same name would both insert and the portal would
  // resolve to whichever came back first.
  const sb = async (path, options) => {
    if (options && options.method === 'POST') return [{ id: 'x' }];
    if (path.startsWith('planned_sessions?id=eq.')) {
      return [{ id: 's1', athlete_code: 'ALEX', title: 'Upper A', status: 'Planned', locked_at: null }];
    }
    if (path.startsWith('session_exercises?')) return [{ exercise_name: 'Bench Press', sets: 4 }];
    if (path.startsWith('workout_splits?name=eq.')) {
      assert.ok(path.includes('athlete_code=is.null'), 'a blank code checks the shared namespace');
      return [{ id: 'existing' }];
    }
    return [];
  };

  await assert.rejects(
    () => saveSessionAsSplit({ session_id: 's1', name: 'Upper A' }, sb, { handle: 'KARL', role: 'admin' }),
    (error) => error.status === 409 && /already exists/.test(error.message)
  );
});

test('an empty session cannot be saved as a split', async () => {
  const sb = async (path) => {
    if (path.startsWith('planned_sessions?id=eq.')) {
      return [{ id: 's1', athlete_code: 'ALEX', title: 'Rest', status: 'Planned', locked_at: null }];
    }
    return [];
  };
  await assert.rejects(
    () => saveSessionAsSplit({ session_id: 's1', name: 'Empty' }, sb, { handle: 'KARL', role: 'admin' }),
    (error) => error.status === 400 && /no exercises/.test(error.message)
  );
});

test('saving to another athlete is authorised separately', async () => {
  // The session belongs to an athlete this coach may touch, but the split is
  // being filed under a different athlete's code — that needs its own check.
  const sb = async (path) => {
    if (path.startsWith('planned_sessions?id=eq.')) {
      return [{ id: 's1', athlete_code: 'NATE', title: 'Upper A', status: 'Planned', locked_at: null }];
    }
    if (path.startsWith('coach_athletes')) return [{ athlete_code: 'NATE' }];
    return [];
  };
  await assert.rejects(
    () => saveSessionAsSplit(
      { session_id: 's1', name: 'Upper A', athlete_code: 'JORDAN' },
      sb, { id: 'c-alex', handle: 'ALEX', role: 'coach' }
    ),
    (error) => error.status === 403
  );
});
