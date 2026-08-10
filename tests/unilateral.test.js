import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const start = source.indexOf('function normaliseExerciseName');
const end = source.indexOf('function getType', start);
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const strengthStart = source.indexOf('const STR = ');
const strengthEnd = source.indexOf('\n\n// ── RUN LIBRARY', strengthStart);
const strengthContext = {};
vm.createContext(strengthContext);
vm.runInContext(`${source.slice(strengthStart, strengthEnd)};this.STR=STR;`, strengthContext);

test('female unilateral movements use left/right reps', () => {
  [
    'Bulgarian Split Squat',
    'Walking Lunge',
    'Reverse Lunge',
    'Dumbbell Step Up',
    'Cable Glute Kickback',
    'Cable Hip Abduction',
    'Cable Adduction',
    'Cable Hip Adduction',
    'Cable Lateral Raise',
    'Dumbbell Row',
    'Copenhagen Plank',
    'Single Leg Curl',
  ].forEach((name) => assert.equal(context.usesLeftRightReps(name), true, name));
});

test('Lower A offers cable hip adduction with separate left/right reps', () => {
  const adduction = strengthContext.STR['Lower A'].find(
    (exercise) => exercise.exercise === 'Adduction Machine'
  );
  assert.ok(adduction);
  assert.deepEqual(Array.from(adduction.alts), ['Cable Hip Adduction']);
  assert.deepEqual(Array.from(adduction.leftRightExercises), ['Cable Hip Adduction']);
  assert.equal(context.usesLeftRightReps('Cable Hip Adduction', adduction), true);
});

test('female bilateral movements keep one reps field', () => {
  [
    'Barbell Romanian Deadlift',
    'Seated Hip Abduction',
    'Lateral Dumbbell Raise',
    'Machine Lateral Raise',
    'Dumbbell Bicep Curl',
    'Leg Press (feet high & wide)',
  ].forEach((name) => assert.equal(context.usesLeftRightReps(name), false, name));
});

test('Supabase metadata can explicitly mark non-obvious unilateral variants', () => {
  const prescription = {
    exercise: 'Contralateral Reach',
    repMode: 'left_right',
    leftRightExercises: ['Contralateral Reach', 'Supported Reach'],
  };
  assert.equal(context.usesLeftRightReps('Contralateral Reach', prescription), true);
  assert.equal(context.usesLeftRightReps('Supported Reach', prescription), true);
  assert.equal(context.usesLeftRightReps('Hack Squat', prescription), false);
});
