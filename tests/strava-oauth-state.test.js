import test from 'node:test';
import assert from 'node:assert/strict';

import { createStravaState, verifyStravaState } from '../server/strava-oauth-state.js';

test('Strava OAuth state is signed, canonical and expires', () => {
  const previous = process.env.STRAVA_STATE_SECRET;
  process.env.STRAVA_STATE_SECRET = 'test-only-secret-with-enough-entropy';
  try {
    const issuedAt = Date.parse('2026-08-21T00:00:00Z');
    const state = createStravaState('  benny-1 ', issuedAt);
    assert.equal(verifyStravaState(state, issuedAt + 60_000)?.code, 'BENNY-1');
    assert.equal(verifyStravaState(`${state}tampered`, issuedAt + 60_000), null);
    assert.equal(verifyStravaState(state, issuedAt + 16 * 60_000), null);
  } finally {
    if (previous == null) delete process.env.STRAVA_STATE_SECRET;
    else process.env.STRAVA_STATE_SECRET = previous;
  }
});
