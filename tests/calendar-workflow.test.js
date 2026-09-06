import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/programming.css', import.meta.url), 'utf8');

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

// planned_sessions.status is coach-set free text. What the athlete actually did
// lives in the ticked/logs blobs and training_session_logs, so the calendar
// could read "Planned" across a week every session of which was submitted.

function runPlanState({ row, submitted = false, ticked = false, sessions = [], today = '2026-09-09' }) {
  const context = vm.createContext({
    nid: value => String(value || '').trim().toUpperCase() || null,
    isSessionSubmitted: () => submitted,
    isSessionTicked: () => ticked,
    _allAthletes: [{ id: 'SARAH', sessions }],
    _coaches: [],
    _isoDate: () => today,
    result: null,
  });
  vm.runInContext(`${functionSource('planSessionState')}; result = planSessionState(${JSON.stringify(row)});`, context);
  return context.result;
}

test('a submitted session outranks whatever the coach typed in status', () => {
  const row = { athlete_code: 'SARAH', id: '1', planned_date: '2026-09-08', status: 'Planned' };
  assert.equal(runPlanState({ row, submitted: true }).key, 'submitted');
});

test('completed and submitted stay separate states', () => {
  const row = { athlete_code: 'SARAH', id: '1', planned_date: '2026-09-08', status: 'Planned' };
  // Ticked the box but sent no data.
  const ticked = runPlanState({ row, ticked: true });
  assert.equal(ticked.key, 'completed');
  assert.match(ticked.label, /no data/i);
  // Sent a log with data.
  assert.equal(runPlanState({ row, submitted: true }).key, 'submitted');
});

test('a log on the day counts even when the portal did not write the id back', () => {
  const row = { athlete_code: 'SARAH', id: '1', planned_date: '2026-09-08', status: 'Planned' };
  assert.equal(runPlanState({ row, sessions: [{ _d: '2026-09-08' }] }).key, 'submitted');
  assert.equal(runPlanState({ row, sessions: [{ _d: '2026-09-01' }] }).key, 'open');
});

test('a past session with nothing logged reads differently from a future one', () => {
  const base = { athlete_code: 'SARAH', id: '1', status: 'Planned' };
  assert.equal(runPlanState({ row: { ...base, planned_date: '2026-09-05' } }).key, 'open');
  assert.equal(runPlanState({ row: { ...base, planned_date: '2026-09-12' } }).key, 'planned');
});

test('missed and sick are honoured over any derived state', () => {
  const base = { athlete_code: 'SARAH', id: '1', planned_date: '2026-09-08' };
  for (const status of ['missed', 'skipped', 'sick']) {
    assert.equal(runPlanState({ row: { ...base, status }, submitted: true }).key, 'missed', status);
  }
});

test('the calendar renders derived state, not the raw status field', () => {
  const grid = functionSource('renderPlanGrid');
  assert.match(grid, /planStateBadge\(r\)/);
  assert.match(grid, /const state = planSessionState\(r\)/);
  assert.doesNotMatch(grid, /plan-card-status/);
  // Submitted work that has not been reviewed is flagged where a coach is
  // already looking, not only in the review queue.
  assert.match(grid, /needsReview/);
  assert.match(grid, /isDayReviewed\(r\.athlete_code, r\.planned_date\)/);
});

test('the session editor is a drawer so the calendar stays visible', () => {
  assert.match(html, /<div class="po-overlay po-drawer hidden" id="ps-overlay"/);
  assert.match(css, /\.po-overlay\.po-drawer\s*\{[^}]*justify-content: flex-end/s);
  assert.match(css, /\.po-overlay\.po-drawer > \.po-modal\s*\{[^}]*height: 100%/s);
});

test('move and duplicate exist and only apply to a saved session', () => {
  assert.match(html, /id="ps-move"/);
  assert.match(html, /id="ps-duplicate"/);
  const open = functionSource('openPlanSession');
  assert.match(open, /getElementById\('ps-duplicate'\)\.style\.display = row \? '' : 'none'/);
  assert.match(open, /getElementById\('ps-move'\)\.style\.display = row \? '' : 'none'/);

  // A move must re-label the week, or a session dragged into the next calendar
  // week keeps the old programme week number.
  const move = functionSource('movePlanSession');
  assert.match(move, /_weekLabelForDate\(row\.athlete_code, date\)/);
  assert.match(move, /action: 'plan_update'/);

  // A duplicate carries the prescription but never the athlete's own state.
  const duplicate = functionSource('duplicatePlanSession');
  assert.match(duplicate, /status: 'Planned'/);
  assert.match(duplicate, /action: 'plan_insert'/);
  for (const field of ['distance_km', 'target_pace', 'warm_up', 'intervals', 'working_pace', 'rest', 'cool_down', 'notes']) {
    assert.match(duplicate, new RegExp(`${field}: row\\.${field}`), `${field} travels with the copy`);
  }
});

test('the squad board covers the roster without the single-athlete controls', () => {
  assert.match(html, /id="prog-view-squad"/);
  assert.match(html, /id="prog-squad-body"/);
  const board = functionSource('renderSquadBoard');
  // Coaches train too, but the board is the athlete roster.
  assert.match(board, /_progAthleteCodes\(\)\.filter\(code => !COACHES\.has\(code\)\)/);
  assert.match(board, /planWeekSummary\(weekRows\)/);
  assert.match(board, /squadBoardAdd\(/);

  // Copy week, add session and the library act on the selected athlete.
  const render = functionSource('renderProgramming');
  assert.match(render, /\['plan-copy-btn', 'plan-add-btn', 'plan-lib-btn'\]/);
  assert.match(render, /button\.hidden = _progView === 'squad'/);
});

test('adding from the board targets the athlete whose row was clicked', () => {
  const calls = [];
  const context = vm.createContext({
    setProgAthlete: code => calls.push(['athlete', code]),
    openPlanSession: (id, date) => calls.push(['open', id, date]),
  });
  vm.runInContext(`${functionSource('squadBoardAdd')}; squadBoardAdd('JAMES', '2026-09-10');`, context);
  assert.deepEqual(calls, [['athlete', 'JAMES'], ['open', null, '2026-09-10']]);
});

test('the expanded squad row is a preview, not a second athlete profile', () => {
  const panel = functionSource('buildTableExpandPanel');
  // Three things only: why they are flagged, the week, and the ways out.
  assert.match(panel, /texp-signal/);
  assert.match(panel, /texp-week-strip/);
  assert.match(panel, /openAthleteFromTriage\(/);
  assert.match(panel, /fpPlanWeek\(/);
  // The mini-profile it used to render belongs to the workspace.
  for (const gone of ['texp-daily-row', 'texp-ci-header', 'texp-bar-row', 'texp-action-ribbon', 'texp-week-btn']) {
    assert.doesNotMatch(panel, new RegExp(gone), `${gone} should have moved to the athlete workspace`);
  }
  assert.ok(panel.split('\n').length < 90, 'the preview must stay short');
});

// ── Programme week rollover ───────────────────────────────────────────────────
// A start date is stored as 'YYYY-MM-DD'. Passing that straight to new Date()
// parses it as UTC midnight, which is 09:30 the same morning in Adelaide, so an
// athlete's programme week used to advance mid-Monday instead of at midnight.

function evalHelpers(names, expression) {
  const context = vm.createContext({ result: null });
  vm.runInContext(`${names.map(functionSource).join('\n')}; result = (${expression});`, context);
  return context.result;
}

function inTimezone(zone, run) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('the programme week rolls over at local midnight, not at 09:30', () => {
  inTimezone('Australia/Adelaide', () => {
    const start = '2026-08-31'; // Monday, day 0 of the discovery week

    // The bug, stated as the expression that caused it: one minute into Monday
    // the athlete has completed 7 days, but UTC parsing counts only 6.
    const justAfterMidnight = new Date(2026, 8, 7, 0, 1);
    assert.equal(
      Math.floor((justAfterMidnight - new Date(start)) / 86400000), 6,
      'the old UTC-parsed expression is what put the athlete a day behind',
    );

    const days = (date) => evalHelpers(
      ['localMidnight', 'daysBetweenLocal'],
      `daysBetweenLocal('${start}', new Date(${date.getTime()}))`,
    );
    assert.equal(days(new Date(2026, 8, 6, 23, 59)), 6, 'Sunday night is still day 6');
    assert.equal(days(justAfterMidnight), 7, 'Monday 00:01 is day 7, so Week 1');
    assert.equal(days(new Date(2026, 8, 7, 8, 0)), 7, 'and it does not change at 09:30');

    assert.equal(Math.floor(days(new Date(2026, 8, 6, 23, 59)) / 7), 0, 'Discovery');
    assert.equal(Math.floor(days(justAfterMidnight) / 7), 1, 'Week 1');
  });
});

test('a daylight saving changeover still counts as one day', () => {
  inTimezone('Australia/Adelaide', () => {
    // Adelaide moves to daylight time on Sunday 4 October 2026: a 23-hour day.
    const days = evalHelpers(
      ['localMidnight', 'daysBetweenLocal'],
      `daysBetweenLocal('2026-10-03', '2026-10-05')`,
    );
    assert.equal(days, 2, 'the short day must not swallow a programme day');
  });
});

test('calcWeekNum counts whole local days from the start date', () => {
  const source = functionSource('calcWeekNum');
  assert.match(source, /daysBetweenLocal\(sd, new Date\(\)\)/);
  assert.doesNotMatch(source, /new Date\(sd\)/, 'a bare new Date(sd) is a UTC parse');
});

// ── Squad board: the row describes the week on screen ─────────────────────────

test('the squad row shows the week being viewed, not the week it is today', () => {
  const board = functionSource('renderSquadBoard');
  assert.match(board, /currentWeekNum \+ _progWeekOffset/, 'the label follows the visible week');
  assert.match(board, /squadRaceCountdown\(race, ws\)/, 'so does the countdown');
  assert.doesNotMatch(board, /raceCountdownLabel\(race\)/, 'that one is pinned to today');
  // Browsing back before an athlete joined must not print a negative week.
  assert.match(board, /weekNum === null \|\| weekNum < 0 \? '—'/);
});

test('the squad countdown is measured from the week on screen to race week', () => {
  const countdown = (weekStart) => evalHelpers(
    ['localMidnight', 'squadRaceCountdown'],
    `squadRaceCountdown({ raceDate: '2026-09-20' }, localMidnight('${weekStart}'))`,
  );
  assert.equal(countdown('2026-08-31'), '2 weeks out');
  assert.equal(countdown('2026-09-07'), '1 week out', 'singular, not "1 weeks out"');
  assert.equal(countdown('2026-09-14'), 'Race week', 'race day falls inside this week');
  assert.equal(countdown('2026-09-21'), null, 'no stale countdown on later weeks');
});
