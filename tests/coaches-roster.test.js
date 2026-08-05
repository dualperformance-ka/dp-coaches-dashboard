import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const dashboardSource = readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8'
);

const buildStart = dashboardSource.indexOf('function buildAll(');
const buildEnd = dashboardSource.indexOf('\nfunction buildSyncAudit(', buildStart);
const buildSource = dashboardSource.slice(buildStart, buildEnd);

function buildContext(overrides = {}) {
  return {
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
    localDateStr: () => '2026-08-05',
    nid: value => String(value || '').trim().toUpperCase() || null,
    programmeRestartWeek: () => null,
    _planRowsForWeek: () => [],
    _nutWkNum: () => -1,
    avg: () => null,
    calcRecoveryScore: () => null,
    detectPRs: () => ({ recent: [], allTime: {} }),
    buildTimeseries: () => [],
    buildActionList: () => ({}),
    _isAcked: () => false,
    buildSyncAudit: () => [],
    weeklyCheckinStatus: () => ({
      checkinDue: true,
      requiredWeekEnd: '2026-08-02',
      hasCurrentCheckin: false,
      hasLastWeekCheckin: true,
      hasRecent: true,
      isStale: false,
    }),
    getPlanningAthleteId: row => String(row.Athlete || '').trim().toUpperCase() || null,
    isSessionSubmitted: () => false,
    ...overrides,
  };
}

test('dashboard builds a card model for every coach even with no activity rows', () => {
  assert.notEqual(buildStart, -1, 'buildAll must exist');
  assert.notEqual(buildEnd, -1, 'buildAll boundary must exist');
  const context = buildContext();

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

test('roster aliases collapse a full-name legacy identity onto the portal code', () => {
  const aliasStart = dashboardSource.indexOf('const STATIC_ALIASES =');
  const aliasEnd = dashboardSource.indexOf('// Coaches are filtered OUT', aliasStart);
  const nidStart = dashboardSource.indexOf('function nid(');
  const nidEnd = dashboardSource.indexOf('\nfunction sid(', nidStart);
  const aliasSource = dashboardSource.slice(aliasStart, aliasEnd);
  const nidSource = dashboardSource.slice(nidStart, nidEnd);
  const context = buildContext();

  vm.runInNewContext(
    `${aliasSource}\n${nidSource}\n` +
    `installRosterAliases([{ code: 'THOMAS', name: 'Thomas Trinh', active: true }], []);\n` +
    `${buildSource}\n` +
    `result = buildAll(` +
      `[{ _athleteCode: 'THOMAS', Name: 'THOMAS', 'Week Ending': '2026-08-02' },` +
       `{ Name: 'Thomas Trinh', 'Week Ending': '2026-07-19' }],` +
      `[], [], [], [{ Code: 'THOMAS', Name: 'Thomas Trinh' }], [], [], [],` +
      `[{ code: 'THOMAS', name: 'Thomas Trinh', active: true }]);`,
    context
  );

  assert.equal(context.result.athletes.length, 1);
  assert.equal(context.result.athletes[0].id, 'THOMAS');
  assert.equal(context.result.athletes[0].displayName, 'Thomas Trinh');
  assert.equal(context.result.athletes[0].weekly['Week Ending'], '2026-08-02');
});

test('current compliance counts submitted portal logs and overdue pending plans', () => {
  const context = buildContext({
    isSessionSubmitted: (_code, id) => id === 'done-session',
  });

  vm.runInNewContext(
    `${buildSource}\nresult = buildAll(` +
      `[], [], [{ AthleteID: 'THOMAS', Date: '2026-08-05' }], [],` +
      `[{ Code: 'THOMAS', Name: 'Thomas Trinh' }], [],` +
      `[{ _id: 'done-session', Athlete: 'THOMAS', 'Planned Date': '2026-08-03', 'Status ': 'Planned' },` +
       `{ _id: 'pending-session', Athlete: 'THOMAS', 'Planned Date': '2026-08-04', 'Status ': 'Planned' }], [],` +
      `[{ code: 'THOMAS', name: 'Thomas Trinh', active: true }]);`,
    context
  );

  assert.equal(context.result.athletes[0].compliance, 50);
});

test('weekly status respects the due week, Monday grace, and a new athlete start date', () => {
  const helperStart = dashboardSource.indexOf('function shiftIsoDay(');
  const helperEnd = dashboardSource.indexOf('// ── Parse a single Exercise Log', helperStart);
  const helperSource = dashboardSource.slice(helperStart, helperEnd);
  const context = { result: null };

  vm.runInNewContext(
    `${helperSource}\nresult = [` +
      `weeklyCheckinStatus('2026-08-02', '2026-08-05', '2026-08-09', '2026-01-01'),` +
      `weeklyCheckinStatus('2026-08-02', '2026-08-10', '2026-08-16', '2026-01-01'),` +
      `weeklyCheckinStatus('', '2026-08-05', '2026-08-09', '2026-08-03')` +
    `];`,
    context
  );

  assert.equal(context.result[0].isStale, false, 'previous Sunday covers Wednesday');
  assert.equal(context.result[1].isStale, false, 'Monday remains a grace day');
  assert.equal(context.result[2].checkinDue, false, 'new starter is not overdue before a first due week');
});

test('Jojo remains a configured coach', () => {
  assert.match(
    dashboardSource,
    /const COACHES = new Set\(\['KARL', 'ALEX', 'JOJO'\]\);/
  );
});
