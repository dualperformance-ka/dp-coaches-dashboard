import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Block view's week picking and unsaved-edit handling live inline in
// public/index.html, so slice the real declarations out and run them in a vm the
// way rescheduling.test.js does. These cover the bugs that used to silently lose
// a coach's typed macros or offer the wrong week to add.
const root = new URL('..', import.meta.url).pathname;
const source = readFileSync(join(root, 'public', 'index.html'), 'utf8');

function grabBlock(marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing source block: ${marker}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${marker}`);
}
function grabLine(marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing source line: ${marker}`);
  return source.slice(start, source.indexOf('\n', start));
}

function makeContext() {
  const context = vm.createContext({ console });
  vm.runInContext(`
    let _nutPlans = [];
    let _selectedWeek = 'Week 1';
    let _progWeeks = {};
    const DEFAULT_PROG_WEEKS = 12;
    const getProgWeeks = code => _progWeeks[code] ?? DEFAULT_PROG_WEEKS;
    const isDiscoveryWeek = v => String(v ?? '').trim() === 'Week 0' || Number(v) === 0;
    const _progSelectedWeekLabel = () => _selectedWeek;
    ${grabBlock('function _nutWkNum(label)')}
    ${grabBlock('function _nextNutWeekNum(code) {')}
    ${grabLine('const _nutDrafts = new Map();')}
    ${grabLine('const _nutDraftKey =')}
    ${grabLine('function _clearNutDraft(code, weekLabel)')}
    ${grabBlock('function _moveNutDraft(code, fromLabel, toLabel) {')}
  `, context);
  return context;
}
const run = (context, expr) => vm.runInContext(expr, context);
const weeks = (...labels) => labels.map(week_label => ({ athlete_code: 'CHUNG', week_label }));

test('the add button offers the athlete’s current week when it has no targets yet', () => {
  const c = makeContext();
  run(c, `_nutPlans = ${JSON.stringify(weeks('Week 1', 'Week 2'))}; _selectedWeek = 'Week 3';`);
  assert.equal(run(c, `_nextNutWeekNum('CHUNG')`), 3);
});

test('it fills a gap inside the block instead of running off the end', () => {
  // Regression: this used to return maxWeek + 1, so a coach who had skipped
  // Week 5 was offered Week 13 and the block silently grew by a week.
  const c = makeContext();
  run(c, `_nutPlans = ${JSON.stringify(weeks(...[1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12].map(n => `Week ${n}`)))};
          _selectedWeek = 'Week 2';`);
  assert.equal(run(c, `_nextNutWeekNum('CHUNG')`), 5);
});

test('Discovery Week is only offered when it is the athlete’s current week', () => {
  const c = makeContext();
  run(c, `_nutPlans = ${JSON.stringify(weeks('Week 1', 'Week 2'))}; _selectedWeek = 'Week 1';`);
  assert.equal(run(c, `_nextNutWeekNum('CHUNG')`), 3, 'mid-block athletes are not sent back to Week 0');

  const d = makeContext();
  run(d, `_nutPlans = ${JSON.stringify(weeks('Week 1'))}; _selectedWeek = 'Week 0';`);
  assert.equal(run(d, `_nextNutWeekNum('CHUNG')`), 0);
});

test('a full block reports the week past the end, which is what extends it', () => {
  const c = makeContext();
  const full = weeks(...Array.from({ length: 12 }, (_, i) => `Week ${i + 1}`));
  run(c, `_nutPlans = ${JSON.stringify(full)}; _selectedWeek = 'Week 12'; _progWeeks = { CHUNG: 12 };`);
  assert.equal(run(c, `_nextNutWeekNum('CHUNG')`), 13);
});

test('drafts are keyed per athlete and week, so two athletes never share one', () => {
  const c = makeContext();
  run(c, `_nutDrafts.set(_nutDraftKey('CHUNG', 'Week 1'), { calories: '2650' });
          _nutDrafts.set(_nutDraftKey('BENNY', 'Week 1'), { calories: '3100' });`);
  assert.equal(run(c, `_nutDrafts.get(_nutDraftKey('CHUNG', 'Week 1')).calories`), '2650');
  assert.equal(run(c, `_nutDrafts.get(_nutDraftKey('BENNY', 'Week 1')).calories`), '3100');
});

test('relabelling a week carries its unsaved edits to the new label', () => {
  // Regression: a relabel used to leave the draft stranded under the old key and
  // the server's stored row overwrote what the coach had just typed.
  const c = makeContext();
  run(c, `_nutDrafts.set(_nutDraftKey('CHUNG', 'Week 4'), { protein: '185' });`);
  // vm objects come from another realm, so compare the value rather than the object.
  assert.equal(run(c, `_moveNutDraft('CHUNG', 'Week 4', 'Week 6').protein`), '185');
  assert.equal(run(c, `_nutDrafts.has(_nutDraftKey('CHUNG', 'Week 4'))`), false);
  assert.equal(run(c, `_nutDrafts.get(_nutDraftKey('CHUNG', 'Week 6')).protein`), '185');
});

test('saving or deleting a row drops only that row’s draft', () => {
  const c = makeContext();
  run(c, `_nutDrafts.set(_nutDraftKey('CHUNG', 'Week 1'), { calories: '2650' });
          _nutDrafts.set(_nutDraftKey('CHUNG', 'Week 2'), { calories: '2700' });
          _clearNutDraft('CHUNG', 'Week 1');`);
  assert.equal(run(c, `_nutDrafts.has(_nutDraftKey('CHUNG', 'Week 1'))`), false);
  assert.equal(run(c, `_nutDrafts.get(_nutDraftKey('CHUNG', 'Week 2')).calories`), '2700');
});
