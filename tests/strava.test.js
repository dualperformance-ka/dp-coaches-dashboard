import test from 'node:test';
import assert from 'node:assert/strict';

import { unavailableActivitiesResponse } from '../api/strava.js';

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
