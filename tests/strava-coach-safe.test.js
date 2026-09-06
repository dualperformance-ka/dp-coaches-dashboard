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
  assert.match(index, /Strava activity ·/);
  assert.match(index, /Athlete confirmed via Strava/);
  assert.match(index, /Matched and submitted by the athlete in the Dual Performance portal/);
  assert.match(index, /submittedStravaHtml/);
  assert.match(index, /<details class="wd-strava-act submitted">/);
  assert.match(index, /Prescribed workout/);
  assert.match(index, /Athlete feedback/);
  assert.match(index, /ask the athlete to upload the original FIT\/TCX\/GPX/);
  assert.match(index, /function renderImportedActivity/);
  assert.match(index, /Original athlete-consented workout file/);
});

// The 403 above is the server half of Rule 2. This is the client half.
//
// Until this test existed the dashboard shipped _stravaApiUrl, prefetchStravaKm,
// loadStravaData, refreshStravaData and an _stravaKmCache that fed Strava-derived
// weekly km into the squad km total and sort order, the programme volume "actual"
// bars, the weekly mileage chart and the athlete vitals. None of it could run,
// because api/strava.js refuses a coach, so the cluster sat unreachable while a
// "Strava actual" legend and a Strava badge advertised a series that could never
// fill. Enforcing the rule only at the server meant one relaxed status code would
// have turned coach screens into a Strava display with no other change.

test('the coaches dashboard never calls the Strava endpoint from the browser', () => {
  const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  // Comments are allowed to explain what was removed and why.
  const code = index
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

  assert.doesNotMatch(code, /['"`]\/api\/strava/,
    'the dashboard must not build a request to the athlete-only Strava endpoint');

  for (const symbol of [
    '_stravaKmCache', '_stravaKmByWeekEnd', 'applyStravaKm',
    'prefetchStravaKm', 'loadStravaData', 'refreshStravaData',
    '_stravaApiUrl', 'loadStravaActivityDetail',
  ]) {
    assert.doesNotMatch(code, new RegExp(symbol),
      `${symbol} reintroduces a coach-side read of Strava API data`);
  }

  // A legend or badge for a series the dashboard cannot legitimately populate
  // tells a coach the number came from somewhere it did not.
  assert.doesNotMatch(code, /Strava actual/,
    'no chart may advertise a Strava-sourced series to a coach');
  assert.doesNotMatch(code, /dp_strava_summaries/,
    'Strava summaries must not be cached in the coach browser');
});

test('athlete-owned provenance and uploaded activity files are still shown', () => {
  const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  // The submitted-log provenance is legitimate: it is built server-side in
  // api/coach-data.js from what the athlete themselves sent, carries no activity
  // id, route or payload, and is what tells a coach the session was confirmed
  // rather than typed. Removing the coach-side read must not remove this.
  assert.match(index, /_stravaConfirmed/);
  assert.match(index, /submittedStravaHtml/);
  assert.match(index, /Athlete confirmed via Strava/);
  assert.match(index, /function renderImportedActivity/);
});
