import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import handler from '../api/coach-data.js';

// Athletes can substitute any exercise for a same-muscle alternative in the
// portal. Sets are logged under what they actually performed, so the dashboard
// needs the programmed slot to avoid two failure modes: the substituted lift
// reading as though it was prescribed, and its slot being flagged "Not done"
// on a session that was completed in full.

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return value; },
    end() { return undefined; },
  };
}

const swappedRow = {
  client_write_id: 'w-swap',
  athlete_code: 'ALVIN',
  athlete_name: 'Alvin',
  session_name: 'Upper A',
  session_category: 'Strength',
  session_date: '2026-08-10',
  exercise_log: 'T-Bar Row: Set 1: 40kg × 10reps',
  exercise_name: 'T-Bar Row',
  programmed_exercise: 'Low Machine Row',
  muscle_group: 'Upper back — horizontal row',
  is_swap: true,
  rep_mode: 'reps',
};

test('the swap fields reach the dashboard payload', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    DASHBOARD_ACCESS_KEY: process.env.DASHBOARD_ACCESS_KEY,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';

  const rowsFor = url => {
    if (url.includes('/training_session_logs?')) return [swappedRow];
    if (url.includes('/athletes?')) return [{ code: 'ALVIN', name: 'Alvin' }];
    return [];
  };
  global.fetch = async url => new Response(JSON.stringify(rowsFor(String(url))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const res = responseRecorder();
    await handler({ method: 'GET', headers: { 'x-dashboard-key': 'dashboard-key', 'x-coach-name': 'Karl' } }, res);
    assert.equal(res.statusCode, 200);
    const session = res.body.sessions.find(s => s['Exercise Name'] === 'T-Bar Row');
    assert.ok(session, 'the swapped session should be present');
    assert.equal(session['Programmed Exercise'], 'Low Machine Row');
    assert.equal(session['Muscle Group'], 'Upper back — horizontal row');
    assert.equal(session['Is Swap'], true);
    assert.equal(session['Rep Mode'], 'reps');
    // The log text itself must stay clean — the exercise name parser and PB
    // history both key off everything before ": Set ".
    assert.match(session['Exercise Log'], /^T-Bar Row: Set 1:/);
  } finally {
    global.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

// renderExerciseLog lives inline in index.html, so it is lifted out and run in
// a sandbox rather than duplicated here.
function loadRenderer() {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function renderExerciseLog(');
  assert.ok(start > 0, 'renderExerciseLog should exist in index.html');
  const marker = '\n// ── Full-page Card';
  const end = html.indexOf(marker, start);
  assert.ok(end > start, 'renderExerciseLog should be followed by the full-page card section');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}\n' +
    html.slice(start, end) +
    '\nthis.renderExerciseLog=renderExerciseLog;',
    context
  );
  return context.renderExerciseLog;
}

const renderExerciseLog = loadRenderer();
const plannedUpperA = [
  { exercise: 'Low Machine Row' },
  { exercise: 'Pec Dec' },
];
const swaps = {
  't-bar row': {
    performed: 'T-Bar Row',
    programmed: 'Low Machine Row',
    muscleGroup: 'Upper back — horizontal row',
  },
};

test('a swapped exercise is not double counted as missing plus unplanned', () => {
  const log = 'T-Bar Row: Set 1: 40kg × 10reps\nPec Dec: Set 1: 50kg × 12reps';
  const html = renderExerciseLog(log, false, null, plannedUpperA, swaps);
  assert.ok(!html.includes('Not done'), 'the replaced slot must not be flagged as skipped');
  assert.ok(html.includes('T-Bar Row'));
  assert.ok(html.includes('swapped for Low Machine Row'));
});

test('the swapped lift holds the slot position it replaced', () => {
  const log = 'Pec Dec: Set 1: 50kg × 12reps\nT-Bar Row: Set 1: 40kg × 10reps';
  const html = renderExerciseLog(log, false, null, plannedUpperA, swaps);
  assert.ok(html.indexOf('T-Bar Row') < html.indexOf('Pec Dec'), 'portal order should put the row slot first');
});

test('a genuinely skipped exercise is still flagged', () => {
  const html = renderExerciseLog('T-Bar Row: Set 1: 40kg × 10reps', false, null, plannedUpperA, swaps);
  assert.ok(html.includes('Not done'));
  assert.ok(html.includes('Pec Dec'));
});

test('sessions without swap data render exactly as before', () => {
  const log = 'Low Machine Row: Set 1: 60kg × 10reps';
  const withUndefined = renderExerciseLog(log, false, null, plannedUpperA, undefined);
  const withEmpty = renderExerciseLog(log, false, null, plannedUpperA, {});
  assert.equal(withUndefined, withEmpty);
  assert.ok(!withUndefined.includes('swapped for'));
  assert.ok(withUndefined.includes('Low Machine Row'));
});

test('PB detection still keys on the exercise actually performed', () => {
  const priorBests = { 't-bar row': { e1rm: 40 } };
  const html = renderExerciseLog('T-Bar Row: Set 1: 60kg × 10reps', false, priorBests, plannedUpperA, swaps);
  assert.ok(html.includes('PB'), 'a heavy swapped lift should still register against its own history');
});
