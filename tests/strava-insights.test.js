import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aerobicDecoupling,
  aggregateZoneDistribution,
  analyseLapExecution,
  buildCoachingInsights,
  detectPersonalBests,
  gearMileage,
} from '../server/strava-insights.js';

test('aggregates HR buckets into an 80/20 coaching audit', () => {
  const result = aggregateZoneDistribution([
    { hr_zones: [{ time: 600 }, { time: 3000 }, { time: 300 }, { time: 500 }, { time: 100 }] },
    { hr_zones: [{ time: 300 }, { time: 600 }, { time: 0 }, { time: 0 }, { time: 0 }] },
  ]);
  assert.equal(result.totalSeconds, 5400);
  assert.equal(result.easyPercent, 83.3);
  assert.equal(result.greyPercent, 5.6);
  assert.equal(result.hardPercent, 11.1);
});

test('rep execution reports late-session pace decay and consistency', () => {
  const result = analyseLapExecution({ id: 7, laps: [
    { average_speed: 4.2 }, { average_speed: 4.1 }, { average_speed: 3.8 }, { average_speed: 3.7 },
  ] });
  assert.equal(result.activityId, 7);
  assert.equal(result.lapCount, 4);
  assert.equal(result.paceDecayPercent, 9.6);
  assert.ok(result.consistencyCvPercent > 5);
});

test('detects first-ranked best efforts as PBs', () => {
  const pbs = detectPersonalBests([{ id: 9, name: 'Sunday long run', start_date_local: '2026-08-16T07:00:00', best_efforts: [
    { name: '5K', pr_rank: 1, moving_time: 1200 },
    { name: '10K', pr_rank: 2, moving_time: 2600 },
  ] }]);
  assert.deepEqual(pbs.map(pb => pb.effort), ['5K']);
});

test('uses Strava gear odometer and warns at 650km', () => {
  const gear = gearMileage([{ id: 1, distance: 10000, gear: { id: 'g1', name: 'Daily Trainer', distance: 680000 } }]);
  assert.equal(gear[0].km, 680);
  assert.equal(gear[0].retirementWarning, true);
});

test('computes aerobic efficiency drift from HR and velocity streams', () => {
  const streams = { heartrate: [], velocity_smooth: [] };
  for (let index = 0; index < 20; index += 1) {
    streams.heartrate.push(index < 10 ? 140 : 150);
    streams.velocity_smooth.push(3);
  }
  const result = aerobicDecoupling(streams);
  assert.equal(result.percent, 6.7);
  assert.equal(result.ready, false);
});

test('builds GAP progression points for route-independent pace trending', () => {
  const insights = buildCoachingInsights([{ id: 1, start_date_local: '2026-08-10', average_grade_adjusted_speed: 3.2 }]);
  assert.deepEqual(insights.gapProgression, [{ activityId: 1, date: '2026-08-10', speed: 3.2 }]);
});
