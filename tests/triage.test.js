import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import handler, { buildTriageQueue } from '../api/coach-data.js';

const NOW = new Date('2026-08-05T00:30:00.000Z'); // Wednesday 10:00 in Adelaide, week day 3
const THURSDAY = new Date('2026-08-06T00:30:00.000Z'); // week day 4, the first day compliance is eligible

// Six prescriptions across the Mon–Thu window. Two land on the Monday so the
// per-date consumption logic is actually exercised.
function sixPlanned(code) {
  return [
    { athlete_code: code, planned_date: '2026-08-03', title: 'Lower Strength', status: null },
    { athlete_code: code, planned_date: '2026-08-03', title: 'Easy Run', status: null },
    { athlete_code: code, planned_date: '2026-08-04', title: 'Tempo Run', status: null },
    { athlete_code: code, planned_date: '2026-08-04', title: 'Upper Strength', status: null },
    { athlete_code: code, planned_date: '2026-08-05', title: 'Easy Run', status: null },
    { athlete_code: code, planned_date: '2026-08-06', title: 'Intervals', status: null },
  ];
}

// Compliance is suppressed for anyone already flagged as gone quiet, so these
// athletes need one recent body log to stay out of that branch.
function loggingBody(code) {
  return { athlete_code: code, log_date: '2026-08-05', pain: null, coach_alert: false };
}

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

test('triage ranks coach alerts and pain above gone-quiet athletes', () => {
  const result = buildTriageQueue({
    now: NOW,
    athletes: [
      { code: 'ALICE', name: 'Alice', active: true, archived_at: null },
      { code: 'BOB', name: 'Bob', active: true, archived_at: null },
      { code: 'DANI', name: 'Dani', active: true, archived_at: null },
      { code: 'EVE', name: 'Eve', active: true, archived_at: null },
      { code: 'PAUSED', name: 'Paused', active: false, archived_at: null },
    ],
    bodyRows: [
      { athlete_code: 'ALICE', log_date: '2026-08-04', pain: 7, coach_alert: false },
      { athlete_code: 'DANI', log_date: '2026-08-02', pain: null, coach_alert: true },
      { athlete_code: 'EVE', log_date: '2026-08-05', pain: 1, coach_alert: false },
      { athlete_code: 'PAUSED', log_date: '2026-08-05', pain: 10, coach_alert: true },
    ],
    trainingRows: [
      { athlete_code: 'ALICE', session_date: '2026-08-04', session_name: 'Easy Run' },
    ],
    plannedRows: [
      { athlete_code: 'DANI', planned_date: '2026-08-06', title: 'Tempo Run', status: null },
    ],
  });

  assert.deepEqual(result.queue.map(row => row.athleteCode), ['DANI', 'ALICE', 'BOB']);
  assert.match(result.queue[0].signal, /Coach alert raised.*Tempo Run prescribed tomorrow/);
  assert.match(result.queue[1].signal, /Pain 7\/10.*after Easy Run/);
  assert.equal(result.queue[2].flag, 'gone_quiet');
  assert.match(result.queue[2].signal, /at least 5 days/);
  assert.deepEqual(result.counts, { active: 4, flagged: 3, critical: 2, high: 1, medium: 0, clear: 1 });
});

test('gone quiet requires both completion and body sources to be stale', () => {
  const result = buildTriageQueue({
    now: NOW,
    athletes: [
      { code: 'BODY', name: 'Recent body', active: true, archived_at: null },
      { code: 'SESSION', name: 'Recent session', active: true, archived_at: null },
      { code: 'BOUNDARY', name: 'Five days', active: true, archived_at: null },
    ],
    bodyRows: [
      { athlete_code: 'BODY', log_date: '2026-08-04' },
      { athlete_code: 'BOUNDARY', log_date: '2026-07-31' },
    ],
    sessionRows: [
      { athlete_code: 'SESSION', logged_at: '2026-08-04T00:30:00Z' },
    ],
  });

  assert.deepEqual(result.queue.map(row => row.athleteCode), ['BOUNDARY']);
  assert.equal(result.queue[0].evidence.goneQuiet.days, 5);
  assert.equal(result.counts.clear, 2);
});

test('triage mode is fail-closed before making Supabase requests', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DASHBOARD_ACCESS_KEY;
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';
  let requested = false;
  global.fetch = async () => { requested = true; throw new Error('must not fetch'); };

  try {
    const req = { method: 'GET', query: { mode: 'triage' }, headers: { 'x-dashboard-key': 'wrong' } };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(requested, false);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DASHBOARD_ACCESS_KEY;
    else process.env.DASHBOARD_ACCESS_KEY = originalKey;
  }
});

test('triage mode reads only the bounded coach snapshot sources', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    DASHBOARD_ACCESS_KEY: process.env.DASHBOARD_ACCESS_KEY,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';
  const requested = [];

  global.fetch = async url => {
    const value = String(url);
    requested.push(value);
    let rows = [];
    if (value.includes('/athletes?')) rows = [{ code: 'ALICE', name: 'Alice', active: true, archived_at: null }];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const req = {
      method: 'GET',
      query: { mode: 'triage' },
      headers: { 'x-dashboard-key': 'dashboard-key' },
    };
    const res = responseRecorder();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.queue[0].flag, 'gone_quiet');
    assert.equal(requested.length, 5);
    assert.equal(requested.some(url => url.includes('/weekly_checkins?')), false);
    assert.equal(requested.some(url => url.includes('/daily_nutrition_logs?')), false);
    assert.equal(requested.some(url => url.includes('/session_logs?')), true);
    assert.equal(requested.some(url => url.includes('/coach_triage_last_activity?')), false);
  } finally {
    global.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('triage keeps gone-quiet working before pain columns are migrated', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    DASHBOARD_ACCESS_KEY: process.env.DASHBOARD_ACCESS_KEY,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';

  global.fetch = async url => {
    const value = String(url);
    if (value.includes('/athletes?')) {
      return new Response(JSON.stringify([{ code: 'ALICE', name: 'Alice', active: true, archived_at: null }]), { status: 200 });
    }
    if (value.includes('/daily_body_logs?') && value.includes('pain')) {
      return new Response(JSON.stringify({ message: "column daily_body_logs.pain does not exist" }), { status: 400 });
    }
    return new Response('[]', { status: 200 });
  };

  try {
    const req = {
      method: 'GET',
      query: { mode: 'triage' },
      headers: { 'x-dashboard-key': 'dashboard-key' },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.queue[0].flag, 'gone_quiet');
  } finally {
    global.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('compliance drift stays silent until the week is half elapsed', () => {
  const result = buildTriageQueue({
    now: NOW, // Wednesday, week day 3
    athletes: [{ code: 'DRIFT', name: 'Drift', active: true, archived_at: null }],
    bodyRows: [loggingBody('DRIFT')],
    plannedRows: sixPlanned('DRIFT').filter(row => row.planned_date <= '2026-08-05'),
  });

  assert.equal(result.week.dayIndex, 3);
  assert.equal(result.week.halfElapsed, false);
  assert.deepEqual(result.queue, []);
  assert.equal(result.counts.clear, 1);
});

test('compliance drift fires below 60 percent and not at or above it', () => {
  const done = (rows, count) => rows.map((row, index) => (
    index < count ? { ...row, status: 'done' } : row
  ));

  const result = buildTriageQueue({
    now: THURSDAY,
    athletes: [
      { code: 'DRIFT', name: 'Drift', active: true, archived_at: null },
      { code: 'STEADY', name: 'Steady', active: true, archived_at: null },
    ],
    bodyRows: [loggingBody('DRIFT'), loggingBody('STEADY')],
    plannedRows: [
      ...done(sixPlanned('DRIFT'), 2),   // 2 of 6 = 0.33
      ...done(sixPlanned('STEADY'), 4),  // 4 of 6 = 0.67
    ],
  });

  assert.equal(result.week.start, '2026-08-03');
  assert.equal(result.week.dayIndex, 4);
  assert.deepEqual(result.queue.map(row => row.athleteCode), ['DRIFT']);

  const row = result.queue[0];
  assert.equal(row.flag, 'compliance_drift');
  assert.equal(row.severity, 'medium');
  assert.equal(row.action.type, 'review');
  assert.equal(row.action.label, 'Review');
  assert.equal(row.signal, 'Completed 2 of 6 sessions planned so far this week, with four days elapsed.');
  assert.equal(row.evidence.compliance.planned, 6);
  assert.equal(row.evidence.compliance.completed, 2);
  assert.deepEqual(row.evidence.compliance.sources, ['planned_sessions', 'training_session_logs']);
  assert.equal(result.counts.medium, 1);
});

test('compliance drift ignores athletes with nothing prescribed', () => {
  const result = buildTriageQueue({
    now: THURSDAY,
    athletes: [{ code: 'UNPLANNED', name: 'Unplanned', active: true, archived_at: null }],
    bodyRows: [loggingBody('UNPLANNED')],
    plannedRows: [],
  });

  assert.deepEqual(result.queue, []);
  assert.equal(result.counts.clear, 1);
});

test('compliance drift is suppressed when pain or gone-quiet already fires', () => {
  const result = buildTriageQueue({
    now: THURSDAY,
    athletes: [
      { code: 'PAINY', name: 'Painy', active: true, archived_at: null },
      { code: 'QUIET', name: 'Quiet', active: true, archived_at: null },
    ],
    bodyRows: [{ athlete_code: 'PAINY', log_date: '2026-08-05', pain: 7, coach_alert: false }],
    plannedRows: [...sixPlanned('PAINY'), ...sixPlanned('QUIET')],
  });

  assert.deepEqual(result.queue.map(row => row.flag), ['pain', 'gone_quiet']);
  assert.equal(result.queue[0].evidence.compliance, null);
  assert.equal(result.queue[1].evidence.compliance, null);
  assert.equal(result.counts.medium, 0);
});

test('a multi-exercise strength session counts as one completion, not one per exercise', () => {
  const result = buildTriageQueue({
    now: THURSDAY,
    athletes: [{ code: 'LIFTER', name: 'Lifter', active: true, archived_at: null }],
    bodyRows: [loggingBody('LIFTER')],
    // reconSessionShape writes one training_session_logs row per exercise. Counting
    // raw rows would read this as 5 of 6 (0.83) and suppress a real drift row.
    trainingRows: [
      { athlete_code: 'LIFTER', session_date: '2026-08-03', session_name: 'Lower Strength' },
      { athlete_code: 'LIFTER', session_date: '2026-08-03', session_name: 'Lower Strength' },
      { athlete_code: 'LIFTER', session_date: '2026-08-03', session_name: 'Lower Strength' },
      { athlete_code: 'LIFTER', session_date: '2026-08-03', session_name: 'Lower Strength' },
      { athlete_code: 'LIFTER', session_date: '2026-08-03', session_name: 'Lower Strength' },
    ],
    plannedRows: sixPlanned('LIFTER'),
  });

  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].evidence.compliance.completed, 1);
  assert.match(result.queue[0].signal, /Completed 1 of 6 sessions/);
});

test('the worst compliance drift still ranks below gone quiet', () => {
  const result = buildTriageQueue({
    now: THURSDAY,
    athletes: [
      { code: 'DRIFT', name: 'Drift', active: true, archived_at: null },
      { code: 'QUIET', name: 'Quiet', active: true, archived_at: null },
    ],
    bodyRows: [loggingBody('DRIFT')],
    plannedRows: sixPlanned('DRIFT'), // 0 of 6 = the largest possible shortfall
  });

  assert.deepEqual(result.queue.map(row => row.athleteCode), ['QUIET', 'DRIFT']);
  assert.equal(result.queue[0].priority, 5000);
  assert.ok(result.queue[1].priority < 5000, 'compliance must stay inside its band');
  assert.equal(result.queue[1].evidence.compliance.completed, 0);
});

test('Today is the default coach screen and owns the operational dashboard', () => {
  const source = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /class="tab active" id="tab-triage-btn"/);
  assert.match(source, /id="tab-athletes-content" style="display:none"/);
  const todayStart = source.indexOf('id="tab-triage-content"');
  const athletesStart = source.indexOf('id="tab-athletes-content"');
  const commandCenter = source.indexOf('id="command-center"');
  const coachingActions = source.indexOf('id="coaching-actions"');
  assert.ok(todayStart >= 0 && athletesStart > todayStart);
  assert.ok(commandCenter > todayStart && commandCenter < athletesStart);
  assert.ok(coachingActions > todayStart && coachingActions < athletesStart);
  assert.match(source, /await window\.DP_COACH_AUTH\?\.ready;\s*await load\(\);\s*startSharedResolutionSync\(\);/);
  assert.match(source, /Paired signals that need a coaching decision\./);
  assert.doesNotMatch(source, /<header class="triage-hero">/);
});
