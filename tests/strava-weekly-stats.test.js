import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activitiesInLocalDateRange,
  activityLocalDate,
  mergeActivityDetail,
  weeklyStats,
} from '../api/strava.js';

test('matches an historical selected week using the athlete local date', () => {
  const activities = [
    { id: 1, start_date: '2026-07-26T14:45:00Z', start_date_local: '2026-07-27T00:15:00Z' },
    { id: 2, start_date_local: '2026-08-02T23:50:00Z' },
    { id: 3, start_date_local: '2026-08-03T06:00:00Z' },
  ];

  assert.equal(activityLocalDate(activities[0]), '2026-07-27');
  assert.deepEqual(
    activitiesInLocalDateRange(activities, '2026-07-27', '2026-08-02').map(activity => activity.id),
    [1, 2]
  );
});

test('keeps detailed coaching metrics when an activity is enriched', () => {
  const merged = mergeActivityDetail(
    { id: 42, type: 'Ride', average_speed: 8.1, start_date_local: '2026-07-28T06:00:00Z' },
    {
      id: 42,
      elapsed_time: 4200,
      moving_time: 3600,
      average_cadence: 88,
      average_watts: 214,
      weighted_average_watts: 231,
      max_watts: 645,
      kilojoules: 802,
      average_temp: 17,
      calories: 730,
      laps: [{ id: 1 }],
      segment_efforts: [{ id: 10 }, { id: 11 }],
      best_efforts: [{ name: '20 min', moving_time: 1200, elapsed_time: 1200, distance: 10000 }],
    },
    [{ min: 120, max: 140, time: 900 }]
  );

  assert.equal(merged.elapsed_time, 4200);
  assert.equal(merged.average_cadence, 88);
  assert.equal(merged.weighted_average_watts, 231);
  assert.equal(merged.max_watts, 645);
  assert.equal(merged.segment_effort_count, 2);
  assert.equal(merged.laps.length, 1);
  assert.equal(merged.hr_zones[0].time, 900);
});

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
