import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const logging = readFileSync(join(root, 'public', 'js', '09-logging.js'), 'utf8');

const context = {
  console, Date, Math, Intl,
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  document: { addEventListener: () => {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  window: { addEventListener: () => {}, matchMedia: () => ({ matches: false }) },
  localStorage: { getItem: () => null, setItem: () => {} }
};
vm.createContext(context);
vm.runInContext(training, context);
vm.runInContext(logging, context);

test('merging a revised split preserves removed exercise progress', () => {
  const previous = {
    'Bench Press': [{ weight: '80', reps: '6' }],
    'Lat Pulldown': [{ weight: '60', reps: '10' }],
    __sessionDate: '2026-06-01'
  };
  const current = {
    ' bench   press ': [{ weight: '82.5', reps: '6' }],
    'Leg Press': [{ weight: '140', reps: '10' }]
  };

  const merged = context.mergeStrengthLog(previous, current, { __sessionDate: '2026-07-01' });

  assert.equal(merged['Bench Press'], undefined);
  assert.equal(merged[' bench   press '][0].weight, '82.5');
  assert.equal(merged['Lat Pulldown'][0].weight, '60');
  assert.equal(merged['Leg Press'][0].weight, '140');
  assert.equal(merged.__sessionDate, '2026-07-01');
});
