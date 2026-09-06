import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const training = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const handbook = readFileSync(join(root, 'public', 'js', '05-handbook.js'), 'utf8');
const boot = readFileSync(join(root, 'public', 'js', '10-boot.js'), 'utf8');
const login = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');

function slice(source, from, to, what) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  assert.ok(start >= 0 && end > start, `${what} should remain discoverable`);
  return source.slice(start, end);
}

// new Date() with no arguments is the only clock these helpers read, so the
// context gets a frozen one. Constructed from local parts, not an ISO string,
// so the test does not depend on the runner's timezone.
function frozenClock(year, monthIndex, day, hour = 12, minute = 0) {
  const fixed = new Date(year, monthIndex, day, hour, minute).getTime();
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  };
}

// The week helpers sit in a browser bundle with no module boundary, so they are
// lifted out by source range the way streak.test.js lifts the streak helper.
function weekContext({ code = 'CHUNG', startDate = '2026-08-31', sessions = [], programmeWeeks = 12, now }) {
  const context = {
    athlete: { code, startDate },
    sessions,
    programmeWeeks,
    weekOffset: 0,
    window: {},
    Date: now,
  };
  vm.createContext(context);
  vm.runInContext(slice(core, 'function localISO(', 'function getWS(', 'the date helpers'), context);
  vm.runInContext(slice(handbook, 'function isDiscoveryWeek(', 'function getDisplayWeekNumber(', 'isDiscoveryWeek'), context);
  vm.runInContext(slice(core, '// Core programme/photo helpers', 'function getPhotos(', 'getCurrentProgrammeWeek'), context);
  vm.runInContext(slice(training, 'function trainingWeekDisplayLabel(', 'async function loadWeek(', 'trainingWeekDisplayLabel'), context);
  return context;
}

// ── The bug ──────────────────────────────────────────────────────────────────
//
// Chung started 31 August 2026 on a discovery week. The coaches dashboard
// counts that as Week 0 and calls 7-13 September Week 1. The portal counted
// floor(days/7) + 1, floored at 1, so it had no Week 0 at all and read a week
// ahead of the dashboard for every athlete who has a discovery week.

test('the discovery week is week 0, not week 1', () => {
  const sunday = weekContext({ now: frozenClock(2026, 8, 6, 17, 9) });   // Sun 6 Sept, day 6
  assert.equal(sunday.getCurrentProgrammeWeek(), 0);

  const monday = weekContext({ now: frozenClock(2026, 8, 7, 0, 1) });    // Mon 7 Sept, day 7
  assert.equal(monday.getCurrentProgrammeWeek(), 1);

  const sundayAfter = weekContext({ now: frozenClock(2026, 8, 13, 23, 59) });
  assert.equal(sundayAfter.getCurrentProgrammeWeek(), 1, 'week 1 runs to the Sunday');

  const weekTwo = weekContext({ now: frozenClock(2026, 8, 14, 6, 0) });
  assert.equal(weekTwo.getCurrentProgrammeWeek(), 2);
});

test('athletes who started before the discovery week still begin on week 1', () => {
  for (const code of ['JACOB', 'KHANG']) {
    const day0 = weekContext({ code, now: frozenClock(2026, 8, 6, 17, 9) });
    assert.equal(day0.getCurrentProgrammeWeek(), 1, `${code} has no week 0`);
    const day7 = weekContext({ code, now: frozenClock(2026, 8, 7, 0, 1) });
    assert.equal(day7.getCurrentProgrammeWeek(), 2, `${code} advances on the Monday`);
  }
});

test('a loaded Discovery Week session is week 0, not the date fallback', () => {
  // 'Discovery Week' carries no digit, so the label match failed and the date
  // maths answered instead — which is how the nutrition week label could sit a
  // week away from the training one for the same athlete.
  const context = weekContext({
    sessions: [{ week: 'Discovery Week' }],
    now: frozenClock(2026, 8, 3, 9, 0),
  });
  assert.equal(context.getCurrentProgrammeWeek(), 0);
});

test('a coach-assigned week label still wins over the date maths', () => {
  const context = weekContext({ sessions: [{ week: 'Week 4' }], now: frozenClock(2026, 8, 6, 17, 9) });
  assert.equal(context.getCurrentProgrammeWeek(), 4);
});

test('a daylight saving changeover does not eat a programme day', () => {
  // Adelaide moves to daylight time on Sunday 4 October 2026. Measured in
  // milliseconds that week is 23 hours short of seven days; measured in whole
  // local days it is seven, which is what the athlete lived through.
  const context = weekContext({ startDate: '2026-09-28', now: frozenClock(2026, 9, 5, 0, 30) });
  assert.equal(context.getCurrentProgrammeWeek(), 1);
});

test('the fallback week label matches the week the coach is looking at', () => {
  // The reported symptom: no sessions loaded for 7-13 Sept, so the label came
  // from the fallback and read "Week 2" while the dashboard said Week 1.
  const context = weekContext({ now: frozenClock(2026, 8, 6, 17, 9) });
  assert.equal(context.trainingWeekDisplayLabel(), 'Discovery Week', 'this week');
  context.weekOffset = 1;
  assert.equal(context.trainingWeekDisplayLabel(), 'Week 1', 'the week the coach programmed');
  context.weekOffset = 2;
  assert.equal(context.trainingWeekDisplayLabel(), 'Week 2');
});

// ── The stale week ───────────────────────────────────────────────────────────
//
// loadTrainingReadSnapshot returns a 24 hour localStorage snapshot before it
// makes any network call. The forced re-read only ran once at boot, for the
// week on screen at boot, so paging to a week opened earlier served whatever
// was in it then — an empty week, for a week the coach had since programmed.

test('a week served from the persisted snapshot is re-read, whichever week it is', () => {
  const loadWeekSource = slice(training, 'async function loadWeek(', 'function showNoplan(', 'loadWeek');
  assert.match(loadWeekSource, /refreshWeekIfStale\(\)/, 'loadWeek must re-read a persisted week');

  const helper = slice(training, 'function refreshWeekIfStale(', 'async function refreshWeekInBackground(', 'refreshWeekIfStale');
  assert.match(helper, /_trainingReadServedPersistent/, 'only a persisted read needs re-reading');
  assert.match(helper, /_weekRefreshInFlight/, 'and it must dedupe so the re-render cannot loop');

  // Boot goes through the same guarded helper rather than its own copy.
  assert.match(login, /refreshWeekIfStale\(\)/);
  assert.doesNotMatch(login, /\?refreshWeekInBackground\(\):null/, 'the boot special case is gone');
});

test('refreshWeekIfStale re-reads once per week and skips a fresh one', async () => {
  const context = {
    window: { _trainingReadServedPersistent: true },
    athlete: { code: 'CHUNG' },
    weekOffset: 0,
    calls: 0,
    setTimeout,
    Promise,
    Date,
    console,
    refreshWeekInBackground: async function () { context.calls += 1; return true; },
  };
  vm.createContext(context);
  vm.runInContext(slice(core, 'function localISO(', 'function getWS(', 'the date helpers'), context);
  vm.runInContext('function getWS(){var m=getMon(new Date());m.setDate(m.getDate()+weekOffset*7);return m;}', context);
  vm.runInContext(slice(training, 'function trainingReadCacheKey(', 'function readPersistedTrainingSnapshot(', 'the cache key'), context);
  // Stop at refreshWeekInBackground so the stub above is the one called.
  vm.runInContext(slice(training, 'var _weekRefreshInFlight', 'async function refreshWeekInBackground(', 'refreshWeekIfStale'), context);

  const first = vm.runInContext('refreshWeekIfStale()', context);
  const second = vm.runInContext('refreshWeekIfStale()', context);
  await Promise.all([first, second]);
  assert.equal(context.calls, 1, 'two renders of the same week are one re-read');

  context.window._trainingReadServedPersistent = false;
  assert.equal(vm.runInContext('refreshWeekIfStale()', context), null, 'a fresh week is left alone');
  assert.equal(context.calls, 1);
});

// ── Refresh has to mean refresh ──────────────────────────────────────────────

test('the refresh button drops the training week snapshots', () => {
  assert.match(boot, /clearTrainingWeekCache/, 'hardRefreshPortal must clear them');
  const hard = slice(boot, 'async function hardRefreshPortal(', '// Service worker registration', 'hardRefreshPortal');
  assert.match(hard, /clearTrainingWeekCache/);

  const store = new Map([
    ['dp_training_week_v1_CHUNG_2026-09-07_2026-09-13', '{}'],
    ['dp_training_week_v1_CHUNG_2026-08-31_2026-09-06', '{}'],
    ['dp_logs_CHUNG', 'keep me'],
    ['dp_goals_CHUNG', 'keep me too'],
  ]);
  const context = {
    window: { _trainingReadSnapshot: { stale: true }, _trainingReadServedPersistent: true },
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i],
      removeItem: (k) => { store.delete(k); },
    },
  };
  vm.createContext(context);
  vm.runInContext(slice(training, 'function clearTrainingWeekCache(', 'var _weekRefreshInFlight', 'clearTrainingWeekCache'), context);

  assert.equal(vm.runInContext('clearTrainingWeekCache()', context), 2);
  assert.deepEqual([...store.keys()].sort(), ['dp_goals_CHUNG', 'dp_logs_CHUNG'], 'drafts and logs survive');
  assert.equal(context.window._trainingReadSnapshot, null);
  assert.equal(context.window._trainingReadServedPersistent, false);
});
