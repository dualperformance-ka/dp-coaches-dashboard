import assert from 'node:assert/strict';
import test from 'node:test';

import { weeklyStats } from '../api/strava.js';

test('returns current and previous Monday-to-Sunday run totals', () => {
  const activities = [
    { type: 'Run', start_date_local: '2026-07-29T06:00:00Z', distance: 19700 },
    { type: 'Run', start_date_local: '2026-07-20T06:00:00Z', distance: 10000 },
    { type: 'Run', start_date_local: '2026-07-22T06:00:00Z', distance: 12000 },
    { type: 'Run', start_date_local: '2026-07-25T06:00:00Z', distance: 10070 },
    { type: 'Run', start_date_local: '2026-07-26T06:00:00Z', distance: 16000 },
    { type: 'Ride', start_date_local: '2026-07-24T06:00:00Z', distance: 50000 },
    { type: 'Run', start_date_local: '2026-07-19T06:00:00Z', distance: 9000 },
  ];

  const stats = weeklyStats(activities, new Date('2026-07-31T00:00:00Z'));

  assert.equal(stats.weeklyKm, 19.7);
  assert.equal(stats.weeklyRuns, 1);
  assert.equal(stats.lastWeekKm, 48.1);
  assert.equal(stats.lastWeekRuns, 4);
  assert.deepEqual(stats.weeklyHistory, [
    { weekStart: '2026-07-13', weekEnd: '2026-07-19', km: 9, runs: 1 },
    { weekStart: '2026-07-20', weekEnd: '2026-07-26', km: 48.1, runs: 4 },
    { weekStart: '2026-07-27', weekEnd: '2026-08-02', km: 19.7, runs: 1 },
  ]);
});

test('uses the activity local date at week boundaries', () => {
  const activities = [
    {
      type: 'Run',
      start_date: '2026-07-26T14:45:00Z',
      start_date_local: '2026-07-27T00:15:00Z',
      distance: 5000,
    },
  ];

  const stats = weeklyStats(activities, new Date('2026-07-27T12:00:00Z'));

  assert.equal(stats.weeklyKm, 5);
  assert.equal(stats.lastWeekKm, 0);
});

test('starts a new week on Adelaide Monday even while the server is on UTC Sunday', () => {
  const activities = [
    {
      type: 'Run',
      start_date: '2026-07-26T15:45:00Z',
      start_date_local: '2026-07-27T01:15:00Z',
      distance: 8000,
    },
  ];

  const stats = weeklyStats(activities, new Date('2026-07-26T15:45:00Z'));

  assert.equal(stats.weeklyKm, 8);
  assert.equal(stats.lastWeekKm, 0);
});

test('keeps weekly aggregates beyond a 12-week block', () => {
  const stats = weeklyStats([
    {
      type: 'Run',
      start_date: '2026-03-30T20:30:00Z',
      start_date_local: '2026-03-31T07:00:00Z',
      distance: 18000,
    },
    {
      type: 'Run',
      start_date: '2026-07-29T20:30:00Z',
      start_date_local: '2026-07-30T06:00:00Z',
      distance: 10000,
    },
  ], new Date('2026-07-31T00:00:00Z'));

  assert.deepEqual(stats.weeklyHistory, [
    { weekStart: '2026-03-30', weekEnd: '2026-04-05', km: 18, runs: 1 },
    { weekStart: '2026-07-27', weekEnd: '2026-08-02', km: 10, runs: 1 },
  ]);
});
