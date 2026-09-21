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
  // Calendar and Programming share the panel, so both tabs render it.
  assert.match(source, /if \(PROG_TABS\.includes\(tab\)\) renderProgramming\(\)/);
});

test('view mode round-trips through dp_prog_view', () => {
  const run = (requested) => {
    const values = new Map();
    const context = vm.createContext({
      localStorage: { setItem: (key, value) => values.set(key, value) },
      renderProgramming() {},
    });
    vm.runInContext(
      `let _progView = 'week';`
      + ` const PROG_VIEWS = new Set(['week', 'squad', 'block']);`
      + ` ${functionSource('setProgView')};`
      + ` setProgView(${JSON.stringify(requested)}); selected = _progView;`,
      context
    );
    return { selected: context.selected, stored: values.get('dp_prog_view') };
  };

  for (const view of ['week', 'squad', 'block']) {
    assert.deepEqual(run(view), { selected: view, stored: view }, `${view} view`);
  }
  // Anything unrecognised falls back to the single-athlete week rather than
  // leaving the programming tab with no body visible.
  assert.deepEqual(run('nonsense'), { selected: 'week', stored: 'week' });
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
  // Asserts that an empty state exists and explains itself, not its exact
  // wording: "No athletes found" became "No athletes match the current filter."
  // during the Phase 4 empty-state pass, and pinning the literal string would
  // fail every future improvement to the copy.
  const nutEmpty = functionSource('renderNutTable').match(/class="nut-empty">([^<]+)</);
  assert.ok(nutEmpty, 'renderNutTable must render an empty state');
  assert.ok(nutEmpty[1].trim().length > 12, `the empty state must explain itself, got "${nutEmpty[1]}"`);
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

// ── Calendar / Programming split ─────────────────────────────────────────────
// "Week" and "Block" described time units, not content: Week is session
// programming, Block is weekly mileage and macros. The views are now named for
// what they hold, and the squad board has its own tab.

test('Calendar and Programming are separate tabs over one panel', () => {
  assert.match(html, /id="tab-calendar-btn"/);
  assert.match(html, /id="tab-programming-btn"/);
  // One content div, so the visibility loop must compare content ids.
  assert.match(html, /calendar: 'programming'/);
  const source = functionSource('switchTab');
  assert.match(source, /const activeContentId = TAB_CONTENT_ID\[tab\] \|\| tab/);
  assert.match(source, /contentId === activeContentId/);
  assert.match(source, /if \(tab === 'calendar'\) _progView = 'squad'/);
  assert.match(source, /tab === 'programming' && _progView === 'squad'/);
  assert.match(source, /if \(PROG_TABS\.includes\(tab\)\) renderProgramming\(\)/);
});

test('the view switch names content, not time units, and says its scope', () => {
  const start = html.indexOf('id="prog-view-toggle"');
  const toggle = html.slice(start, html.indexOf('</div>\n    </div>', start));
  for (const name of ['Calendar', 'Sessions', 'Weekly Targets']) {
    assert.match(toggle, new RegExp(`${name}</span>`), `${name} segment`);
  }
  assert.doesNotMatch(toggle, />Week</);
  assert.doesNotMatch(toggle, />Block</);
  // Each segment states its scope, so neither name has to carry it alone.
  assert.match(toggle, /Whole squad · one week/);
  assert.match(toggle, /One athlete · day by day/);
  assert.match(toggle, /Mileage &amp; macros · per week/);
  // Every segment goes through goProgView so the switch and the tabs agree.
  assert.equal(toggle.match(/onclick="goProgView\(/g)?.length, 3);
});

test('Programming reopens on a single-athlete view, never the squad board', () => {
  const source = functionSource('_progDetailView');
  assert.match(source, /'block' \? 'block' : 'week'/);
  // The switch covers all three views, so it stays up on the squad board too.
  const render = functionSource('renderProgramming');
  assert.match(render, /\['week', 'squad', 'block'\]\.forEach/);
  assert.doesNotMatch(render, /toggle\.hidden/);
  assert.match(render, /_syncProgTabButtons\(\)/);
});

test('both tabs carry the planned-session badge', () => {
  const source = functionSource('updatePlanningBadge');
  assert.match(source, /'tab-programming-count', 'tab-calendar-count'/);
  assert.match(html, /id="tab-calendar-count"/);
});
