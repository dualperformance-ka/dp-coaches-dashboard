import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import handler, { buildTriageQueue } from '../api/coach-data.js';

const NOW = new Date('2026-08-05T00:30:00.000Z'); // 10:00 in Adelaide

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
  assert.deepEqual(result.counts, { active: 4, flagged: 3, critical: 2, high: 1, clear: 1 });
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

test('Today is the default coach screen and defers the Strava-heavy roster load', () => {
  const source = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(source, /class="tab active" id="tab-triage-btn"/);
  assert.match(source, /id="tab-athletes-content" style="display:none"/);
  assert.match(source, /if \(!document\.getElementById\('tab-triage-btn'\)\?\.classList\.contains\('active'\)\) load\(\);/);
  assert.match(source, /Only paired signals that lead to a coaching action\./);
  assert.doesNotMatch(source, /<header class="triage-hero">/);
});
