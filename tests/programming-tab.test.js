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

test('Planning and Nutrition are consolidated into one Programming panel', () => {
  assert.match(html, /id="tab-programming-btn"/);
  assert.match(html, /id="tab-programming-content"/);
  assert.match(html, /id="prog-ath-chips"/);
  assert.match(html, /id="prog-view-toggle"/);
  assert.match(html, /id="prog-week-body"/);
  assert.match(html, /id="prog-block-body"/);
  assert.doesNotMatch(html, /id="tab-planning-content"/);
  assert.doesNotMatch(html, /id="tab-nut-content"/);
});

test('legacy tab aliases select the matching Programming view', () => {
  const source = functionSource('switchTab');
  assert.match(source, /tab === 'planning' \|\| tab === 'nutrition'/);
  assert.match(source, /tab === 'nutrition' \? 'block' : 'week'/);
  assert.match(source, /tab = 'programming'/);
  assert.match(source, /if \(tab === 'programming'\) renderProgramming\(\)/);
});

test('view mode round-trips through dp_prog_view', () => {
  const values = new Map();
  const context = vm.createContext({
    localStorage: { setItem: (key, value) => values.set(key, value) },
    renderProgramming() {},
  });
  vm.runInContext(`let _progView = 'week'; ${functionSource('setProgView')}; setProgView('block'); selected = _progView;`, context);
  assert.equal(context.selected, 'block');
  assert.equal(values.get('dp_prog_view'), 'block');
});

test('clicking a Block row sets the week offset and flips to Week view', () => {
  const calls = [];
  const context = vm.createContext({
    _progAthlete: 'JORDAN',
    _nutWkNum: (label) => Number(String(label).match(/\d+/)?.[0] ?? -1),
    _nutCurrentWeekLabel: () => 'Week 4',
    setProgView: (view) => calls.push(view),
  });
  vm.runInContext(`let _progWeekOffset = 0; ${functionSource('openProgWeek')}; openProgWeek('Week 7'); offset = _progWeekOffset;`, context);
  assert.equal(context.offset, 3);
  assert.deepEqual(calls, ['week']);
});

test('Programming badge preserves nutrition load errors', () => {
  const source = functionSource('updatePlanningBadge');
  assert.match(source, /tab-programming-count/);
  assert.match(source, /_nutPlansLoadError/);
  assert.match(source, /textContent = '!'/);
});

test('both Programming bodies have empty states and render delegates', () => {
  assert.match(functionSource('renderProgramming'), /renderNutTable\(\)/);
  assert.match(functionSource('renderProgramming'), /renderPlanGrid\(\)/);
  assert.match(functionSource('renderNutTable'), /No athletes found/);
  assert.match(functionSource('renderPlanGrid'), /_progAthlete \? _planRowsForWeek/);
});

test('Block view renders training context and published day-adjustment counts', () => {
  const table = functionSource('renderNutTable');
  assert.match(table, /_plannedSessionsForWeek/);
  assert.match(table, /_plannedKmForWeek/);
  assert.match(table, /_keySessionForWeek/);
  assert.match(table, /publishedCountForWeek/);
  assert.match(table, /<th>Sessions<\/th><th>Run goal<\/th><th>Key session<\/th><th>Days adj\.<\/th>/);
  // The run goal is the same weekly_sport_targets record the Week bar edits —
  // one source of truth, so a goal set in either place shows in the other.
  assert.match(table, /sportCellHtml/);
  assert.match(table, /sport: 'running'/);
  assert.match(table, /bindCells\(wrap\)/);
});

test('weekly sport targets mount from the Week bar and remain editable', () => {
  const grid = functionSource('renderPlanGrid');
  assert.match(grid, /dmo-week-sports/);
  assert.match(grid, /\['running','cycling','swimming'\]/);
  assert.match(grid, /WeeklySportTargetsEditor\?\.sportCellHtml/);
  assert.match(grid, /WeeklySportTargetsEditor\?\.bindCells\(weekBar\)/);
  assert.match(html, /<div id="weekly-sport-targets-editor"><\/div>[\s\S]*<div id="daily-macro-overrides-editor"><\/div>/);
});

test('phone layout remaps every Block cell into a labelled card row', () => {
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /content:attr\(data-label\)/);
  assert.match(functionSource('renderNutTable'), /data-label="Key session"/);
  assert.match(functionSource('renderNutTable'), /data-label="Days adjusted"/);
});
