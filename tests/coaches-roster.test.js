import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const dashboardSource = readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8'
);

test('dashboard builds a card model for every coach even with no activity rows', () => {
  const buildStart = dashboardSource.indexOf('function buildAll(');
  const buildEnd = dashboardSource.indexOf('\nfunction buildSyncAudit(', buildStart);

  assert.notEqual(buildStart, -1, 'buildAll must exist');
  assert.notEqual(buildEnd, -1, 'buildAll boundary must exist');

  const buildSource = dashboardSource.slice(buildStart, buildEnd);
  const context = {
    result: null,
    COACHES: new Set(['KARL', 'ALEX', 'JOJO']),
    NO_DISCOVERY: new Set(),
    WEEK_OVERRIDES: {},
    DISCOVERY_TYPES: new Set(),
    _startDateOverrides: {},
    _programmeRestarts: {},
    currentWeekStart: new Date('2026-08-03T00:00:00+09:30'),
    currentWeekEnd: '2026-08-09',
    dago: () => new Date('2026-05-01T00:00:00+09:30'),
    localDateStr: () => '2026-08-04',
    nid: value => String(value || '').trim().toUpperCase() || null,
    programmeRestartWeek: () => null,
    _planRowsForWeek: () => [],
    _nutWkNum: () => -1,
    avg: () => null,
    calcRecoveryScore: () => null,
    detectPRs: () => [],
    buildTimeseries: () => [],
    buildActionList: () => ({}),
    _isAcked: () => false,
    buildSyncAudit: () => [],
  };

  vm.runInNewContext(
    `${buildSource}\nresult = buildAll([], [], [], [], [], [], [], []);`,
    context
  );

  assert.deepEqual(
    Array.from(context.result.coaches, coach => coach.id),
    ['KARL', 'ALEX', 'JOJO']
  );
  assert.equal(context.result.athletes.length, 0);
});

test('Jojo remains a configured coach', () => {
  assert.match(
    dashboardSource,
    /const COACHES = new Set\(\['KARL', 'ALEX', 'JOJO'\]\);/
  );
});
