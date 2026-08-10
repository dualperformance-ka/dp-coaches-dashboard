import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');

function readinessCalculator() {
  const start = source.indexOf('function calculateDailyReadiness');
  const end = source.indexOf('function getHomeInsights', start);
  assert.ok(start >= 0 && end > start, 'daily readiness calculator should remain discoverable');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.calculateDailyReadiness;
}

test('daily readiness uses sleep, energy, inverted soreness and inverted stress', () => {
  const calculate = readinessCalculator();
  assert.equal(calculate({ sleep: 8, energy: 7, soreness: 3, stress: 2 }), 80);
  assert.equal(calculate({ sleep: 5, energy: 5, soreness: 6, stress: 6 }), 50);
  assert.equal(calculate(null), null);
});

test('readiness refreshes at midnight and when the app returns to view', () => {
  assert.match(source, /next\.setHours\(24,0,1,0\)/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /window\.addEventListener\('focus'/);
  assert.match(source, /loadStructuredBodyData\(athlete\.code\)/);
  assert.match(source, /dp_daily_body_'\+athlete\.code\+'_'/);
});
