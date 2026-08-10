import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Swapping freely is only safe if the data underneath keeps up. These tests
// cover the muscle-group layer that answers "what actually got trained" once
// the exercise name stops being a reliable answer.
const root = new URL('..', import.meta.url).pathname;
const coreSource = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const libraryStart = coreSource.indexOf('const STR = ');
const libraryEnd = coreSource.indexOf('\n\n// ── RUN LIBRARY', libraryStart);
const helperStart = coreSource.indexOf('function normaliseExerciseName');
const helperEnd = coreSource.indexOf('function getType', helperStart);

const context = {};
vm.createContext(context);
vm.runInContext(
  `${coreSource.slice(helperStart, helperEnd)}\n${coreSource.slice(libraryStart, libraryEnd)};` +
  'this.summariseMuscleGroups=summariseMuscleGroups;this.variationChurn=variationChurn;' +
  'this.slotVariationHistory=slotVariationHistory;this.exerciseMuscleGroup=exerciseMuscleGroup;' +
  'this.strengthSetWorkload=strengthSetWorkload;',
  context
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('an abandoned set is not counted as training', () => {
  assert.equal(context.strengthSetWorkload({ weight: '60', reps: '' }), null);
  assert.equal(context.strengthSetWorkload({}), null);
  assert.deepEqual(plain(context.strengthSetWorkload({ weight: '60', reps: '8' })), { reps: 8, volume: 480 });
  // Unilateral work records each side; both count toward the muscle group.
  assert.deepEqual(plain(context.strengthSetWorkload({ weight: '20', repsLeft: '8', repsRight: '7' })), { reps: 15, volume: 300 });
});

test('a fully swapped session still rolls up to the muscle groups trained', () => {
  const entry = {
    __sessionDate: '2026-08-03',
    'Pull Up': [{ reps: '8', done: true }, { reps: '6', done: true }],
    'Single Arm Dumbbell Row': [{ weight: '24', reps: '10' }],
    'Seated Calf Raise': [{ weight: '60', reps: '12' }],
  };
  const summary = plain(context.summariseMuscleGroups([entry]));
  const byLabel = Object.fromEntries(summary.map((group) => [group.key, group]));
  assert.ok(byLabel.vertical_pull, 'a pull-up must credit vertical pull');
  assert.equal(byLabel.vertical_pull.sets, 2);
  assert.equal(byLabel.horizontal_row.sets, 1);
  assert.equal(byLabel.horizontal_row.volume, 240);
  // Soleus work must not be folded into the straight-leg calf group.
  assert.ok(byLabel.calf_bent);
  assert.ok(!byLabel.calf_straight);
});

test('bodyweight work counts as sets trained even with no load', () => {
  const summary = plain(context.summariseMuscleGroups([{ 'Push Up': [{ reps: '15' }] }]));
  assert.equal(summary[0].sets, 1);
  assert.equal(summary[0].volume, 0);
});

test('slot history follows the programmed slot, not the exercise name', () => {
  const logs = {
    s1: { __sessionDate: '2026-07-06', __slots: { 'Low Machine Row': 'Low Machine Row' }, 'Low Machine Row': [{ weight: '50', reps: '10' }] },
    s2: { __sessionDate: '2026-07-13', __slots: { 'Low Machine Row': 'T-Bar Row' }, 'T-Bar Row': [{ weight: '40', reps: '10' }] },
  };
  const history = plain(context.slotVariationHistory(logs, 'Low Machine Row'));
  assert.deepEqual(history.map((item) => item.exercise), ['T-Bar Row', 'Low Machine Row']);
});

test('a settled athlete is never nagged about swapping', () => {
  const logs = {
    s1: { __sessionDate: '2026-07-06', __slots: { 'Lat Pulldown': 'Lat Pulldown' }, 'Lat Pulldown': [{ weight: '50', reps: '10' }] },
    s2: { __sessionDate: '2026-07-13', __slots: { 'Lat Pulldown': 'Lat Pulldown' }, 'Lat Pulldown': [{ weight: '52.5', reps: '10' }] },
    s3: { __sessionDate: '2026-07-20', __slots: { 'Lat Pulldown': 'Pull Up' }, 'Pull Up': [{ reps: '8' }] },
  };
  const churn = plain(context.variationChurn(logs, 'Lat Pulldown'));
  assert.equal(churn.sessions, 3);
  assert.equal(churn.distinct, 2);
  assert.equal(churn.churning, false);
});

test('rotating a different variation every session is flagged', () => {
  const logs = {
    s1: { __sessionDate: '2026-07-06', __slots: { 'Lat Pulldown': 'Lat Pulldown' }, 'Lat Pulldown': [{ weight: '50', reps: '10' }] },
    s2: { __sessionDate: '2026-07-13', __slots: { 'Lat Pulldown': 'Pull Up' }, 'Pull Up': [{ reps: '8' }] },
    s3: { __sessionDate: '2026-07-20', __slots: { 'Lat Pulldown': 'Straight Arm Pulldown' }, 'Straight Arm Pulldown': [{ weight: '30', reps: '12' }] },
  };
  const churn = plain(context.variationChurn(logs, 'Lat Pulldown'));
  assert.equal(churn.churning, true);
  assert.equal(churn.current, 'Straight Arm Pulldown');
  assert.equal(churn.variations.length, 3);
});

test('logs written before slot tracking existed stay silent rather than wrong', () => {
  const legacy = { s1: { __sessionDate: '2026-06-01', 'Lat Pulldown': [{ weight: '50', reps: '10' }] } };
  const churn = plain(context.variationChurn(legacy, 'Lat Pulldown'));
  assert.equal(churn.sessions, 0);
  assert.equal(churn.churning, false);
});

test('an empty or malformed log never throws', () => {
  assert.deepEqual(plain(context.summariseMuscleGroups([])), []);
  assert.deepEqual(plain(context.summariseMuscleGroups([null, 'nope', []])), []);
  assert.equal(plain(context.variationChurn({}, 'Lat Pulldown')).churning, false);
  assert.equal(context.exerciseMuscleGroup('Not A Real Movement'), null);
});
