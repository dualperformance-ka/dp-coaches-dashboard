import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    value: (key) => values.get(key) ?? null,
  };
}

test('programming athlete migration prefers the new key, then planning, then nutrition', () => {
  for (const [seed, expected] of [
    [{ dp_prog_athlete: 'NEW', dp_plan_athlete: 'PLAN', dp_nut_athlete: 'NUT' }, 'NEW'],
    [{ dp_plan_athlete: 'PLAN', dp_nut_athlete: 'NUT' }, 'PLAN'],
    [{ dp_nut_athlete: 'NUT' }, 'NUT'],
  ]) {
    const localStorage = storage(seed);
    const context = vm.createContext({ localStorage });
    vm.runInContext(`${functionSource('_migrateProgAthleteSelection')}; result = _migrateProgAthleteSelection();`, context);
    assert.equal(context.result, expected);
    assert.equal(localStorage.value('dp_prog_athlete'), expected);
  }
});

test('unified athlete codes retain nutrition-only history', () => {
  const context = vm.createContext({
    _roster: [{ code: 'ACTIVE', active: true }],
    _nutPlans: [{ athlete_code: 'NUT_ONLY' }],
    _planRowsSB: [],
    _allAthletes: [],
    COACHES: new Set(['COACH']),
  });
  vm.runInContext(`${functionSource('_progAthleteCodes')}; result = _progAthleteCodes();`, context);
  assert.deepEqual([...context.result], ['ACTIVE', 'COACH', 'NUT_ONLY']);
});

test('legacy chip setters update the single programming athlete state', () => {
  const localStorage = storage();
  const context = vm.createContext({ localStorage, renderProgramming() {} });
  vm.runInContext(`let _progAthlete = null; ${functionSource('setProgAthlete')} ${functionSource('setPlanAthlete')} ${functionSource('setNutAthlete')}; setPlanAthlete('A'); afterPlan = _progAthlete; setNutAthlete('B'); afterNut = _progAthlete;`, context);
  assert.equal(context.afterPlan, 'A');
  assert.equal(context.afterNut, 'B');
  assert.equal(localStorage.value('dp_prog_athlete'), 'B');
});

test('full-page Plan Week entry lands on programming with the athlete selected', () => {
  const localStorage = storage();
  const calls = [];
  const context = vm.createContext({ localStorage, hideFP() {}, switchTab: (tab) => calls.push(tab) });
  vm.runInContext(`let _progAthlete = null; ${functionSource('fpPlanWeek')}; fpPlanWeek('JORDAN'); selected = _progAthlete;`, context);
  assert.equal(context.selected, 'JORDAN');
  assert.equal(localStorage.value('dp_prog_athlete'), 'JORDAN');
  assert.deepEqual(calls, ['planning']);
});
