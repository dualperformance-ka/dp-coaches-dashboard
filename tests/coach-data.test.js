import assert from 'node:assert/strict';
import test from 'node:test';

import handler from '../api/coach-data.js';

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

test('protected coach-data returns every dashboard data collection', async () => {
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
    if (url.includes('/daily_body_logs?')) return [];
    if (url.includes('/daily_nutrition_logs?')) return [];
    if (url.includes('/training_session_logs?')) return [];
    if (url.includes('/weekly_checkins?')) return [];
    if (url.includes('/athlete_goals?')) return [];
    if (url.includes('/nutrition_plans?')) return [{ id: 'nutrition-one', athlete_code: 'ALVIN', week_label: 'Week 1', calories: 2400 }];
    if (url.includes('/athlete_data?')) return [
      { athlete_code: 'ALVIN', key: 'programme_weeks', value: 12 },
      { athlete_code: 'ALVIN', key: 'call_notes', value: 'Follow up' },
      { athlete_code: 'ALVIN', key: 'ack_alert', value: { sig: '123' } },
      { athlete_code: 'ALVIN', key: 'ticked', value: { 'session-one': true } },
      { athlete_code: 'ALVIN', key: 'logs', value: { 'session-one': { distance: 5 } } },
    ];
    if (url.includes('/session_library?')) return [
      { id: 'library-one', name: 'Tempo', archived: false },
      { id: 'library-archived', name: 'Old', archived: true },
    ];
    if (url.includes('/workout_splits?')) return [{ id: 'split-one', name: 'Lower A', archived: false }];
    if (url.includes('/application_decisions?')) return [{ notion_id: 'application-one', decision: 'accepted' }];
    if (url.includes('/planned_sessions?')) return [{ id: 'session-one', athlete_code: 'ALVIN', planned_date: '2026-08-03', title: 'Run' }];
    if (url.includes('/athletes?')) return [{ code: 'ALVIN', name: 'Alvin' }];
    throw new Error(`Unexpected Supabase request: ${url}`);
  };

  global.fetch = async url => new Response(JSON.stringify(rowsFor(String(url))), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const req = { method: 'GET', headers: { 'x-dashboard-key': 'dashboard-key', 'x-coach-name': 'Karl' } };
    const res = responseRecorder();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.nutritionPlans.length, 1);
    assert.equal(res.body.nutritionPlans[0].calories, 2400);
    assert.equal(res.body.sessionState.length, 2);
    assert.equal(res.body.sessionLibrary.length, 1);
    assert.equal(res.body.workoutSplits.length, 1);
    assert.equal(res.body.applicationDecisions.length, 1);
    assert.equal(res.body.athleteSettings.some(row => row.key === 'call_notes'), true);
    assert.equal(res.body.athleteSettings.some(row => row.key === 'ack_alert'), true);
  } finally {
    global.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
