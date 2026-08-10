import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/01-core.js', import.meta.url), 'utf8');
const helperSource = source.slice(0, source.indexOf('// ── SUPABASE'));
const context = {};
vm.createContext(context);
vm.runInContext(helperSource, context);

test('priority markers are limited to female splits', () => {
  assert.equal(context.isFemaleSplit('Glute A · Female'), true);
  assert.equal(context.isFemaleSplit('Upper B · Female'), true);
  assert.equal(context.isFemaleSplit('Upper A'), false);
  assert.equal(context.isFemalePriorityExercise('Upper A', 'Machine Shoulder Press'), false);
});

test('female priorities cover the intended minimum session without hiding exercises', () => {
  assert.equal(context.isFemalePriorityExercise('Glute A · Female', 'Barbell Hip Thrust'), true);
  assert.equal(context.isFemalePriorityExercise('Glute A · Female', 'Seated Hamstring Curl'), false);
  assert.equal(context.isFemalePriorityExercise('Glute B · Female', 'Lying Hamstring Curl'), true);
  assert.equal(context.isFemalePriorityExercise('Upper A · Female', 'Cable Abdominal Crunch'), true);
  assert.equal(context.isFemalePriorityExercise('Upper B · Female', 'Dumbbell Hammer Curl'), false);
});

test('priority matching tolerates punctuation and case changes from workout data', () => {
  assert.equal(context.isFemalePriorityExercise('GLUTE B - FEMALE', 'Leg Press (feet high & wide)'), true);
});
