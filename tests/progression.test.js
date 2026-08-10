import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const context = {
  console,
  Date,
  Math,
  Intl,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  document: {
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  },
  window: {
    addEventListener: () => {},
    matchMedia: () => ({ matches: false })
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {}
  }
};
vm.createContext(context);
vm.runInContext(source, context);

const exercise = {
  exercise: 'Single Leg Extension',
  sets: '4',
  warmupSets: '1',
  workingSets: '3',
  reps: '8',
  repRange: '8-12'
};
const set = (row, reps) => ({
  _rowIndex: row,
  weight: '29',
  repsLeft: String(reps),
  repsRight: String(reps)
});
const previous = [
  { weight: '29', repsLeft: '10', repsRight: '10' },
  { weight: '29', repsLeft: '11', repsRight: '11' },
  { weight: '29', repsLeft: '11', repsRight: '11' },
  { weight: '29', repsLeft: '11', repsRight: '11' }
];

test('warm-up row never counts as a working set during live logging', () => {
  const current = [set(0, 12), set(1, 12), set(2, 12)];
  const working = context.getWorkingSlice(exercise, current);
  assert.equal(working.length, 2);
  assert.deepEqual(Array.from(working, (entry) => entry._rowIndex), [1, 2]);
});

test('final working set prompt holds weight and previews the unlocked load', () => {
  const current = [set(0, 12), set(1, 12), set(2, 12)];
  const live = context._nsLiveProgress(
    exercise,
    current,
    {},
    exercise.exercise,
    [{ sets: previous }],
    previous
  );
  assert.match(live.msg, /2 of 3 working sets/);
  assert.match(live.prompt, /Final working set: stay at 29kg and aim for 12/);
  assert.match(live.prompt, /next session/);
});

test('completed working sets show a consistent Today comparison and next-session action', () => {
  const current = [set(0, 12), set(1, 12), set(2, 12), set(3, 12)];
  const live = context._nsLiveProgress(
    exercise,
    current,
    {},
    exercise.exercise,
    [{ sets: previous }],
    previous
  );
  assert.equal(live.msg, '36 reps · 3 up on last session');
  assert.match(live.prompt, /^Next session: Increase to/);
  assert.equal(live.ahead, true);
});

test('bonus set counts as volume but cannot replace a programmed working set', () => {
  const bilateral = {
    exercise: 'Incline Dumbbell Press',
    sets: '2',
    workingSets: '2',
    reps: '8',
    repRange: '8-12'
  };
  const current = [
    { _rowIndex: 0, weight: '22.5', reps: '10' },
    { _rowIndex: 1, weight: '22.5', reps: '9' },
    { _rowIndex: 2, weight: '22.5', reps: '8' }
  ];
  const last = [
    { weight: '22.5', reps: '9' },
    { weight: '22.5', reps: '8' }
  ];
  const working = context.getWorkingSlice(bilateral, current);
  assert.deepEqual(Array.from(working, (entry) => entry.reps), ['10', '9']);

  const live = context._nsLiveProgress(
    bilateral,
    current,
    {},
    bilateral.exercise,
    [{ sets: last }],
    last
  );
  assert.equal(live.msg, '19 reps · 2 up on last session');
  assert.match(live.prompt, /^Next session: Stay at 22.5kg/);
  assert.equal(live.ahead, true);
});

test('bonus set at the rep ceiling cannot unlock a load increase for an unfinished programmed set', () => {
  const bilateral = {
    exercise: 'Incline Dumbbell Press',
    sets: '2',
    workingSets: '2',
    reps: '8',
    repRange: '8-12'
  };
  const current = [
    { _rowIndex: 0, weight: '22.5', reps: '12' },
    { _rowIndex: 1, weight: '22.5', reps: '11' },
    { _rowIndex: 2, weight: '22.5', reps: '12' }
  ];
  const recommendation = context.computeOverload(
    bilateral,
    current,
    bilateral.exercise,
    []
  );
  assert.equal(recommendation.status, 'Beat Last Week');
  assert.equal(recommendation.action, 'Stay at 22.5kg');
  assert.deepEqual(Array.from(recommendation.target), [12, 12]);
});

test('legacy logs without row metadata keep the first programmed sets', () => {
  const bilateral = {
    exercise: 'Incline Dumbbell Press',
    sets: '2',
    workingSets: '2',
    reps: '8',
    repRange: '8-12'
  };
  const historical = [
    { weight: '22.5', reps: '10' },
    { weight: '22.5', reps: '9' },
    { weight: '22.5', reps: '8' }
  ];
  const working = context.getWorkingSlice(bilateral, historical);
  assert.deepEqual(Array.from(working, (entry) => entry.reps), ['10', '9']);
});

test('exercise history follows the exercise across splits and name formatting', () => {
  context.allSessions = [
    { id: 'upper-a-old', date: '2026-06-01' },
    { id: 'full-body-new', date: '2026-07-01' }
  ];
  // Deliberately insert the newer session first: selection must follow session
  // dates, not object insertion order or split name.
  context.logs = {
    'full-body-new': {
      '  INCLINE   DUMBBELL PRESS ': [{ weight: '25', reps: '9' }],
      __sessionDate: '2026-07-01'
    },
    'upper-a-old': {
      'Incline Dumbbell Press': [{ weight: '22.5', reps: '10' }],
      __sessionDate: '2026-06-01'
    }
  };

  const previous = context.getExercisePreviousEffort('current-lower', 'Incline Dumbbell Press');
  const history = context.getExerciseHistory('current-lower', 'incline dumbbell press');

  assert.equal(previous[0].weight, '25');
  assert.deepEqual(Array.from(history, (entry) => entry.sessionId), ['full-body-new', 'upper-a-old']);
  assert.deepEqual(Array.from(history, (entry) => entry.sets[0].weight), ['25', '22.5']);
});

test('assisted dips progress by reducing assistance rather than adding weight', () => {
  const assisted = {
    exercise: 'Assisted Dips',
    sets: '2',
    workingSets: '2',
    reps: '8',
    repRange: '8-12'
  };
  const current = [
    { weight: '20.4', reps: '12' },
    { weight: '20.4', reps: '12' }
  ];
  const history = [
    { sets: current },
    { sets: [{ weight: '27', reps: '12' }, { weight: '27', reps: '12' }] }
  ];

  const recommendation = context.computeOverload(assisted, current, assisted.exercise, history);

  assert.equal(recommendation.status, 'Ready to Progress');
  assert.equal(recommendation.action, 'Reduce assistance to 13.8kg');
  assert.equal(recommendation.weightKg, 13.8);
  assert.equal(recommendation.assisted, true);
  assert.match(context._nsChip(recommendation), /13\.8kg assist/);
});

test('assisted dips hold the assistance setting while reps are still building', () => {
  const assisted = {
    exercise: 'Assisted Dips',
    sets: '2',
    workingSets: '2',
    reps: '8',
    repRange: '8-12'
  };
  const current = [
    { weight: '20.4', reps: '10' },
    { weight: '20.4', reps: '10' }
  ];

  const recommendation = context.computeOverload(assisted, current, assisted.exercise, []);

  assert.equal(recommendation.action, 'Stay at 20.4kg assistance');
  assert.match(recommendation.reason, /before reducing assistance/);
});
