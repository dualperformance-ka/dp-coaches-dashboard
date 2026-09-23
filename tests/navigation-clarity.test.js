import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/coach-parity.css', import.meta.url), 'utf8');

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

test('the squad preview exits are real buttons, the profile one primary', () => {
  const panel = functionSource('buildTableExpandPanel');
  assert.match(panel, /class="texp-cta is-primary"[^>]*openAthleteFromTriage\('\$\{esc\(a\.id\)\}',\{tab:'overview'\}\)/);
  assert.match(panel, /class="texp-cta"[^>]*fpPlanWeek\(/);
  assert.doesNotMatch(panel, /class="fp-open-btn"/);
  assert.match(css, /\.texp-cta\s*\{[^}]*min-height: 42px/);
  assert.match(css, /\.texp-cta\.is-primary\s*\{[^}]*background: var\(--brand\)/);
});

test('every programmed session in the squad preview opens the Programming editor', () => {
  const panel = functionSource('buildTableExpandPanel');
  assert.match(panel, /squadOpenSession\('\$\{code\}','\$\{esc\(r\._sbId\)\}'\)/);
  // Logged days open the athlete's training ledger on that date; empty days add.
  assert.match(panel, /openAthleteFromTriage\('\$\{code\}',\{tab:'training',date:'\$\{iso\}'\}\)/);
  assert.match(panel, /squadBoardAdd\('\$\{code\}','\$\{iso\}'\)/);
  // Rows with no planned_sessions id (legacy Notion) are shown, never editable.
  assert.match(panel, /texp-sess is-static/);
});

test('opening a session from the squad follows the athlete into Programming first', () => {
  const calls = [];
  const context = vm.createContext({
    setProgAthlete: code => calls.push(['athlete', code]),
    openPlanSession: id => calls.push(['open', id]),
  });
  vm.runInContext(`${functionSource('squadOpenSession')}; squadOpenSession('THOMAS', 'abc-123'); squadOpenSession('', 'x');`, context);
  assert.deepEqual(calls, [['athlete', 'THOMAS'], ['open', 'abc-123']]);
});

test('closing the editor refreshes the squad preview from the saved rows', () => {
  assert.match(functionSource('closePlanSession'), /refreshSquadPlan\(\)/);
  const refresh = functionSource('refreshSquadPlan');
  assert.match(refresh, /_planRowsSB \|\| \[\]\)\.map\(planRowToNotionShape\)/);
  assert.match(refresh, /buildTableExpandPanel\(a\)/);

  const rebuilt = [];
  const context = vm.createContext({
    _allAthletes: [{ id: 'THOMAS', allPlan: [] }],
    _planRowsSB: [{ id: 'p1', athlete_code: 'THOMAS', title: 'Upper A', planned_date: '2026-09-21' }],
    planRowToNotionShape: r => ({ _sbId: r.id, Athlete: r.athlete_code, Session: r.title }),
    getPlanningAthleteId: r => r.Athlete,
    _expandedRows: new Set(['thomas']),
    buildTableExpandPanel: a => { rebuilt.push(a.allPlan.length); return 'panel'; },
    document: { getElementById: id => (id === 'texp-thomas' ? { querySelector: () => ({ set innerHTML(v) { rebuilt.push(v); } }) } : null) },
    _drawFP: () => {},
  });
  vm.runInContext(`${functionSource('refreshSquadPlan')}; refreshSquadPlan();`, context);
  assert.equal(context._allAthletes[0].allPlan.length, 1);
  assert.deepEqual(rebuilt, [1, 'panel']);
});

test('athlete tabs are a segmented control with a filled active tab', () => {
  assert.match(css, /\.fpa \.fpa-tab\s*\{[^}]*min-height: 42px[^}]*border: 1px solid var\(--border-mid\)[^}]*border-radius: 999px/);
  assert.match(css, /\.fpa \.fpa-tab\.is-active\s*\{[^}]*background: var\(--brand\)[^}]*color: var\(--readout-ink/);
  // Still a proper tablist.
  const bar = html.slice(html.indexOf('function buildAthleteTabBar('), html.indexOf('function buildAthleteHeader('));
  assert.match(bar, /role="tablist"/);
  assert.match(bar, /aria-selected="\$\{active\}"/);
});
