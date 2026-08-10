import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The swap bank only earns its place if every programmed slot resolves to a
// same-muscle pattern. A slot that falls through returns no extra options, and
// the athlete silently loses the fallback exactly when the gym is busiest.
const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const libraryStart = source.indexOf('const STR = ');
const libraryEnd = source.indexOf('\n\n// ── RUN LIBRARY', libraryStart);
const helperStart = source.indexOf('function normaliseExerciseName');
const helperEnd = source.indexOf('function getType', helperStart);

const context = {};
vm.createContext(context);
vm.runInContext(
  `${source.slice(helperStart, helperEnd)}\n${source.slice(libraryStart, libraryEnd)};` +
  'this.STR=STR;this.getExerciseSwapOptions=getExerciseSwapOptions;this.exercisePatternKey=exercisePatternKey;this.EX_PATTERNS=EX_PATTERNS;',
  context
);

// Values built inside the VM belong to another realm, so arrays are compared
// through plain copies rather than deepEqual on the raw objects.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function extrasFor(prescription) {
  return context.getExerciseSwapOptions(prescription).groups.reduce((total, group) => total + group.options.length, 0);
}

test('every programmed exercise resolves to a muscle group with usable swaps', () => {
  for (const [splitName, exercises] of Object.entries(context.STR)) {
    for (const exercise of exercises) {
      const pattern = context.exercisePatternKey(exercise.exercise);
      assert.ok(pattern, `${splitName} / ${exercise.exercise} has no movement pattern`);
      assert.ok(extrasFor(exercise) > 0, `${splitName} / ${exercise.exercise} offers no additional options`);
    }
  }
});

test('the coach shortlist stays first and is never repeated in the wider bank', () => {
  const prescription = context.STR['Upper A'].find((item) => item.exercise === 'Lat Pulldown');
  const result = context.getExerciseSwapOptions(prescription);
  assert.equal(result.priority[0], 'Lat Pulldown');
  assert.deepEqual(plain(result.priority), ['Lat Pulldown', 'Cable Lat Pulldown', 'Machine Lat Pulldown']);
  const normalise = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const everything = plain(result.priority).map(normalise).concat(...plain(result.groups).map((group) => group.options.map(normalise)));
  assert.equal(new Set(everything).size, everything.length);
});

test('options are grouped by equipment in a fixed order', () => {
  const result = context.getExerciseSwapOptions({ exercise: 'Barbell Romanian Dead Lift' });
  const order = ['Machine', 'Cable', 'Free weight', 'Bodyweight / bands'];
  const labels = plain(result.groups).map((group) => group.label);
  assert.deepEqual(plain(labels), order.filter((label) => labels.includes(label)));
  const freeWeights = plain(result.groups).find((group) => group.equipment === 'free').options;
  assert.ok(freeWeights.includes('Dumbbell Romanian Deadlift'));
});

test('swaps respect the muscle group rather than just the body part', () => {
  assert.equal(context.exercisePatternKey('Standing Calf Raise'), 'calf_straight');
  assert.equal(context.exercisePatternKey('Seated Calf Raise'), 'calf_bent');
  assert.equal(context.exercisePatternKey('Adduction Machine'), 'hip_adduction');
  assert.equal(context.exercisePatternKey('Seated Hip Abduction'), 'hip_abduction');
  const soleus = context.getExerciseSwapOptions({ exercise: 'Seated Calf Raise' });
  const soleusOptions = plain(soleus.groups).flatMap((group) => group.options);
  assert.ok(!soleusOptions.includes('Standing Calf Raise'), 'a soleus slot must not offer a straight-leg calf raise');
});

test('unseen Supabase exercises still get options through keyword inference', () => {
  assert.equal(context.exercisePatternKey('Half Kneeling Single Arm Cable Row'), 'horizontal_row');
  assert.equal(context.exercisePatternKey('Weighted Nordic Curl'), 'hamstring_curl');
  assert.ok(extrasFor({ exercise: 'Paused Barbell Back Squat' }) > 0);
});

test('a coach can lock a slot that must not be substituted', () => {
  const locked = context.getExerciseSwapOptions({ exercise: 'Barbell Back Squat', swapLocked: true });
  assert.deepEqual(plain(locked.groups), []);
  assert.deepEqual(plain(locked.priority), ['Barbell Back Squat']);
});
