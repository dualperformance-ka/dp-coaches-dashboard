import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import handler from '../api/strava.js';

const root = fileURLToPath(new URL('..', import.meta.url));

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

test('coach Strava endpoint remains blocked while safe submitted-log provenance is visible', async () => {
  const originalKey = process.env.DASHBOARD_ACCESS_KEY;
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';
  try {
    const req = {
      method: 'GET',
      query: { athlete: 'ALVIN' },
      headers: { 'x-dashboard-key': 'dashboard-key', 'x-coach-name': 'Karl' },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'strava_athlete_only');
  } finally {
    if (originalKey === undefined) delete process.env.DASHBOARD_ACCESS_KEY;
    else process.env.DASHBOARD_ACCESS_KEY = originalKey;
  }

  const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  assert.match(index, /Strava-confirmed training/);
  assert.match(index, /Athlete confirmed via Strava/);
  assert.match(index, /raw Strava activity data remains private to the athlete/);
});
