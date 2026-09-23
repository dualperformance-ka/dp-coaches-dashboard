import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

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

const between = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));

test('clicking a calendar session opens the view first, not the editor', () => {
  const board = between('function renderSquadBoard(', 'function squadBoardAdd(');
  assert.match(board, /class="sb-session[^"]*"[\s\S]{0,200}onclick="openSessionPeek\('\$\{esc\(code\)\}','\$\{r\.id\}'\)"/);
  assert.doesNotMatch(board, /onclick="openPlanSession\('\$\{r\.id\}'\)"/);
  // Empty cells still add straight away.
  assert.match(board, /squadBoardAdd\('\$\{esc\(code\)\}','\$\{day\.iso\}'\)/);
});

test('the view is a real dialog that closes on backdrop and Escape', () => {
  assert.match(html, /<div class="po-overlay po-drawer hidden" id="sp-overlay" role="dialog" aria-modal="true" aria-labelledby="sp-title" onclick="if\(event\.target===this\)closeSessionPeek\(\)">/);
  assert.match(html, /const peek = document\.getElementById\('sp-overlay'\);\s*if \(peek && !peek\.classList\.contains\('hidden'\)\) \{\s*if \(e\.key === 'Escape' && !_isTyping\(\)\) closeSessionPeek\(\);/);
});

test('the view shows logged, body, planned and feedback, with the same log renderer', () => {
  const render = functionSource('renderSessionPeek');
  for (const part of ['_peekLoggedHtml(ctx)', '_peekBodyHtml(ctx.body)', '_peekPlannedHtml(ctx.row)', '_peekFeedbackHtml(ctx, code, sessionId)']) {
    assert.ok(render.includes(part), part);
  }
  assert.match(render, /peekToggleReview\(\)/);
  assert.match(render, /peekEditSession\(\)/);
  assert.match(render, /peekOpenAthlete\(\)/);
  assert.match(functionSource('_peekLoggedHtml'), /renderExerciseLog\(exLog, s\._isRun, priorBests, plannedExs, s\._swaps\)/);
  // Everything athlete-authored is escaped.
  assert.match(functionSource('_peekLoggedHtml'), /esc\(s\.Notes\)/);
});

test('logged sessions are matched to the planned one by date, then by name', () => {
  const context = vm.createContext({
    _allAthletes: [{ id: 'THOMAS', sessions: [
      { _d: '2026-09-21', Session: 'Upper A', _isStr: true },
      { _d: '2026-09-21', Session: 'Easy run', _isRun: true },
      { _d: '2026-09-22', Session: 'Upper A', _isStr: true },
    ], activities: [], body: [{ Date: '2026-09-21', Energy: 8 }] }],
    _planRowsSB: [
      { id: 'p1', athlete_code: 'THOMAS', title: 'Upper A', planned_date: '2026-09-21', session_type: 'Strength' },
      { id: 'p2', athlete_code: 'THOMAS', title: 'Lower A', planned_date: '2026-09-23', session_type: 'Strength' },
      { id: 'p3', athlete_code: 'THOMAS', title: 'Recovery Shakeout', planned_date: '2026-09-22', session_type: 'Run' },
    ],
    localDateStr: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    nid: v => String(v || '').trim().toUpperCase(),
  });
  vm.runInContext(`${functionSource('_peekContext')}; this.a = _peekContext('THOMAS','p1'); this.b = _peekContext('THOMAS','p3');`, context);
  assert.deepEqual(context.a.logs.map(l => l.Session), ['Upper A']);
  assert.equal(context.a.matchedByName, true);
  assert.equal(context.a.body.Energy, 8);
  // Logged under a different name that day: still shown, flagged as unmatched.
  assert.deepEqual(context.b.logs.map(l => l.Session), ['Upper A']);
  assert.equal(context.b.matchedByName, false);
  assert.equal(context.a.planned, 3);
  assert.equal(context.a.done, 2);
});

test('feedback uses the existing notify pipeline and reports push vs inbox honestly', () => {
  const send = functionSource('sendSessionFeedback');
  assert.match(send, /fetch\('\/api\/notify',/);
  assert.match(send, /'x-admin-key': key/);
  assert.match(send, /JSON\.stringify\(\{ code, title, message \}\)/);
  assert.match(send, /Number\(data\.athletes\) > 0/);
  assert.match(send, /Not pushed to a phone/);
  assert.match(send, /button\.disabled = true/);
  assert.match(html, /id="sp-fb-msg" class="po-input" rows="3" maxlength="500"/);
  assert.match(html, /id="sp-fb-title-input" class="po-input" type="text" maxlength="80"/);
});

test('feedback templates are in house voice: no em dashes, filled from the session', () => {
  const start = html.indexOf('const PEEK_FEEDBACK_TEMPLATES = [');
  const block = html.slice(start, html.indexOf('];', start) + 2);
  assert.doesNotMatch(block, /—/);
  const context = vm.createContext({});
  vm.runInContext(`${block}; this.t = PEEK_FEEDBACK_TEMPLATES;`, context);
  const vars = { session: 'Upper A', planned: 5, done: 4 };
  assert.equal(context.t.length, 4);
  assert.match(context.t[0].text(vars), /Nailed Upper A/);
  assert.match(context.t[1].text(vars), /4 of 5 sessions done this week/);
  assert.doesNotMatch(context.t[1].text({ session: 'x', planned: 0, done: 0 }), /0 of 0/);
  // Never praise a week with nothing done as "consistency".
  assert.doesNotMatch(context.t[1].text({ session: 'x', planned: 2, done: 0 }), /0 of 2/);
});

test('edit from the view goes through the Programming editor path', () => {
  assert.match(functionSource('peekEditSession'), /closeSessionPeek\(\);\s*squadOpenSession\(code, sessionId\)/);
  assert.match(functionSource('peekOpenAthlete'), /openAthleteFromTriage\(code, \{ tab: 'training', date \}\)/);
  assert.match(functionSource('peekToggleReview'), /await toggleDayReview\(_peek\.code, _peek\.date\);\s*renderSessionPeek\(\)/);
});
