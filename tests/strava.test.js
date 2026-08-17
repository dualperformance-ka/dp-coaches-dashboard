import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRefreshedTokens, unavailableActivitiesResponse } from '../api/strava.js';
import { canonicalAthleteCode } from '../server/strava-cache.js';

test('Strava rate limits do not hide a valid connection', () => {
  assert.deepEqual(unavailableActivitiesResponse({ status: 429 }), {
    connected: true,
    activities: [],
    activitiesAvailable: false,
    warning: 'strava_rate_limited',
  });
});

test('non-rate-limit activity errors are not masked', () => {
  assert.equal(unavailableActivitiesResponse({ status: 401 }), null);
  assert.equal(unavailableActivitiesResponse(new Error('network error')), null);
});

test('token refresh persists Strava refresh-token rotation', () => {
  assert.deepEqual(mergeRefreshedTokens(
    { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 1, athlete_name: 'Test' },
    { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 2 },
  ), {
    access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 2, athlete_name: 'Test',
  });
});

test('OAuth callback and coach reads share canonical athlete-code casing', () => {
  assert.equal(canonicalAthleteCode('  JayDon-1 '), 'JAYDON-1');
});
