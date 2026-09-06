import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paceToSeconds, secondsToPace, paceTarget,
  parseRunLog,
  flattenRunSteps, lapsAreStructured, matchLapsToSteps,
  weeklyLoad,
  classifySession, adherenceByType,
  progressionSeries, mondayOf, trendOf,
} from '../public/run-analysis.js';

// ── Pace ─────────────────────────────────────────────────────────────────────

test('pace parsing accepts what coaches actually type, and rejects what is not a pace', () => {
  assert.equal(paceToSeconds('4:00'), 240);
  assert.equal(paceToSeconds('4:00 /km'), 240);
  assert.equal(paceToSeconds('RPE 8 - 5:20/km'), 320);
  assert.equal(paceToSeconds('easy'), null);
  assert.equal(paceToSeconds(''), null);
  assert.equal(paceToSeconds(null), null);
  // 4:65 is not a time; a lax regex would read it as 4 minutes 65 seconds.
  assert.equal(paceToSeconds('4:65'), null);
  assert.equal(secondsToPace(242), '4:02');
  assert.equal(secondsToPace(0), null);
});

test('a single target pace becomes a band only when a tolerance is asked for', () => {
  const single = paceTarget({ pace_min: '4:00' });
  assert.equal(single.low, 240);
  assert.equal(single.high, 240);
  assert.equal(single.isBand, false);

  const band = paceTarget({ pace_min: '4:00', pace_max: '4:10' });
  assert.equal(band.low, 240);
  assert.equal(band.high, 250);
  assert.equal(band.isBand, true);

  assert.equal(paceTarget({ pace_min: '4:00' }, 3).low, 237);
  assert.equal(paceTarget({}), null);
});

// ── Run log ──────────────────────────────────────────────────────────────────

test('the portal run log parses, including a clock that contains a colon', () => {
  const parsed = parseRunLog('Distance: 8.4 km | Time: 41:12 | Pace: 4:54 | RPE: 9');
  assert.equal(parsed.distanceKm, 8.4);
  assert.equal(parsed.durationSec, 2472);
  assert.equal(parsed.paceSecPerKm, 294);
  assert.equal(parsed.rpe, 9);
});

test('pace is derived when the athlete did not record one', () => {
  const parsed = parseRunLog('Distance: 10 km | Time: 50:00');
  assert.equal(parsed.paceSecPerKm, 300);
  assert.equal(parseRunLog(''), null);
});

// ── Prescription structure ───────────────────────────────────────────────────

const steps = [
  { id: 'w', step_order: 0, step_type: 'warmup', distance_km: 2 },
  { id: 'r', step_order: 1, step_type: 'repeat', repeat_count: 5 },
  { id: 'i', step_order: 0, step_type: 'interval', distance_km: 1, pace_min: '4:00', parent_step_id: 'r' },
  { id: 'j', step_order: 1, step_type: 'recovery', duration_sec: 90, parent_step_id: 'r' },
  { id: 'c', step_order: 2, step_type: 'cooldown', distance_km: 2 },
];

test('a repeat block expands into the sequence the athlete actually ran', () => {
  const flat = flattenRunSteps(steps);
  // warm up, 5 × (interval + recovery), cool down.
  assert.equal(flat.length, 12);
  assert.equal(flat[0].type, 'warmup');
  assert.equal(flat[1].type, 'interval');
  assert.equal(flat[1].repeatIndex, 1);
  assert.equal(flat[9].repeatIndex, 5);
  assert.equal(flat.at(-1).type, 'cooldown');
  assert.match(flat[1].label, /rep 1/);
});

test('auto-lapped kilometres are recognised as a distance readout, not structure', () => {
  const auto = Array.from({ length: 8 }, () => ({ distanceM: 1000 })).concat({ distanceM: 420 });
  assert.equal(lapsAreStructured(auto), false);
  const pressed = [{ distanceM: 2000 }, { distanceM: 1000 }, { distanceM: 340 }, { distanceM: 1000 }];
  assert.equal(lapsAreStructured(pressed), true);
});

// ── Prescribed vs actual ─────────────────────────────────────────────────────

const lap = (distanceM, paceSec, extra = {}) => ({
  distanceM,
  avgSpeedMps: 1000 / paceSec,
  ...extra,
});

test('5 x 1km at 4:00 lines up against the laps, signed against the target', () => {
  const laps = [
    lap(2000, 330),                 // warm up
    lap(1000, 237, { avgHr: 168 }), // 3:57
    lap(400, 420),                  // recovery
    lap(1000, 241, { avgHr: 174 }), // 4:01
    lap(400, 420),
    lap(1000, 242, { avgHr: 179 }), // 4:02
    lap(400, 420),
    lap(1000, 244, { avgHr: 182 }), // 4:04
    lap(400, 420),
    lap(1000, 248, { avgHr: 184 }), // 4:08
    lap(2000, 340),                 // cool down
  ];
  const match = matchLapsToSteps(steps, laps);

  assert.equal(match.mode, 'steps');
  assert.equal(match.rows.length, 5);
  assert.deepEqual(match.rows.map(r => r.actualPaceSec), [237, 241, 242, 244, 248]);
  // 3:57 is three seconds faster than a 4:00 target; 4:08 is eight slower.
  assert.deepEqual(match.rows.map(r => r.deltaSec), [-3, 1, 2, 4, 8]);
  assert.deepEqual(match.rows.map(r => r.status), ['faster', 'slower', 'slower', 'slower', 'slower']);
  assert.equal(match.rows[0].avgHr, 168);
  // Fading across the set is the coaching observation, so it is computed.
  assert.equal(match.summary.driftSec, 11);
  assert.equal(match.summary.total, 5);
});

test('being inside a target band counts as on target, not as a miss', () => {
  const banded = [
    { id: 'r', step_order: 0, step_type: 'repeat', repeat_count: 2 },
    { id: 'i', step_order: 0, step_type: 'interval', distance_km: 1, pace_min: '4:00', pace_max: '4:10', parent_step_id: 'r' },
  ];
  // A warm-up lap makes the list structured; two bare 1km laps are
  // indistinguishable from auto-lapping and are correctly refused.
  const match = matchLapsToSteps(banded, [lap(2400, 330), lap(1000, 245), lap(400, 420), lap(1000, 248)]);
  assert.equal(match.mode, 'steps');
  assert.deepEqual(match.rows.map(r => r.status), ['on', 'on']);
  assert.equal(match.summary.onTarget, 2);
});

test('an unmatchable session degrades to totals and says why', () => {
  // Every lap is an auto-lapped kilometre.
  const auto = Array.from({ length: 10 }, () => lap(1000, 300));
  const autoMatch = matchLapsToSteps(steps, auto);
  assert.equal(autoMatch.mode, 'session');
  assert.equal(autoMatch.confidence, 'auto-lap');
  assert.match(autoMatch.reason, /auto-lapped/);

  // Structured laps, but the athlete ran three reps instead of five.
  const short = [lap(2000, 330), lap(1000, 240), lap(400, 420), lap(1000, 242), lap(400, 420), lap(1000, 244)];
  const shortMatch = matchLapsToSteps(steps, short);
  assert.equal(shortMatch.mode, 'session');
  assert.equal(shortMatch.confidence, 'lap-count-mismatch');
  assert.match(shortMatch.reason, /5 work steps but found 3/);
});

test('nothing to compare is reported as nothing, not as a zero-row match', () => {
  assert.equal(matchLapsToSteps([], [lap(1000, 240)]).mode, 'none');
  assert.equal(matchLapsToSteps(steps, []).mode, 'none');
});

// ── Weekly load ──────────────────────────────────────────────────────────────

test('the four-week baseline uses completed weeks only and needs two of them', () => {
  const weeks = weeklyLoad([
    { week: 1, planned: 40, actual: 40 },
    { week: 2, planned: 45, actual: 44 },
    { week: 3, planned: 50, actual: 48 },
    { week: 4, planned: 55, actual: 68 },
  ]);

  assert.equal(weeks[0].rolling, null, 'the first week has no history to compare against');
  assert.equal(weeks[0].isSpike, false);
  // One prior week is not a baseline.
  assert.equal(weeks[1].rollingWeeks, 1);
  assert.equal(weeks[1].isSpike, false);

  assert.equal(weeks[3].rolling, 44);
  assert.equal(weeks[3].deltaPct, 55);
  assert.equal(weeks[3].isSpike, true);
  assert.equal(weeks[3].adherencePct, 124);
});

test('a partial current week does not drag the baseline down', () => {
  const weeks = weeklyLoad([
    { week: 1, actual: 50 }, { week: 2, actual: 50 }, { week: 3, actual: 50 },
    { week: 4, actual: 12, isCurrent: true },
  ]);
  // Week 4's own low figure is excluded from its own baseline.
  assert.equal(weeks[3].rolling, 50);
  assert.equal(weeks[3].isDrop, true);
});

// ── Session type ─────────────────────────────────────────────────────────────

test('sessions classify by what they are for', () => {
  assert.equal(classifySession('Long run 26km', 'Long Run'), 'long');
  assert.equal(classifySession('Threshold 5x1km', 'Tempo'), 'quality');
  assert.equal(classifySession('Easy 8km', 'Easy Effort'), 'easy');
  assert.equal(classifySession('Lower A', 'Strength'), 'strength');
  assert.equal(classifySession('', ''), 'other');
});

test('adherence is reported per session type, worst first', () => {
  const planned = [
    { date: '2026-09-01', name: 'Easy 8km', type: 'Easy Effort' },
    { date: '2026-09-02', name: 'Threshold 5x1km', type: 'Tempo' },
    { date: '2026-09-04', name: 'Threshold 3x2km', type: 'Tempo' },
    { date: '2026-09-06', name: 'Long run', type: 'Long Run' },
  ];
  const done = new Set(['2026-09-01', '2026-09-06']);
  const rows = adherenceByType(planned, row => done.has(row.date));

  assert.equal(rows[0].key, 'quality', 'the group being skipped comes first');
  assert.equal(rows[0].pct, 0);
  assert.deepEqual(rows[0].missed, ['2026-09-02', '2026-09-04']);
  assert.equal(rows.find(r => r.key === 'easy').pct, 100);
});

// ── Progression ──────────────────────────────────────────────────────────────

test('long-run progression takes the longest run of each week', () => {
  const series = progressionSeries([
    { date: '2026-08-31', name: 'Long run', type: 'Long Run', distanceKm: 18 },
    { date: '2026-09-06', name: 'Long run', type: 'Long Run', distanceKm: 22 },
    { date: '2026-09-05', name: 'Long run', type: 'Long Run', distanceKm: 20 },
  ], 'long', { metric: 'distance' });

  // 31 August is a Monday, so 5 and 6 September fall in the same week.
  assert.equal(series.length, 1);
  assert.equal(series[0].week, '2026-08-31');
  assert.equal(series[0].value, 22, 'the longest run of the week is the point');
  assert.equal(series[0].sessions, 3);
});

test('quality progression averages the week rather than taking the best rep', () => {
  const series = progressionSeries([
    { date: '2026-09-01', name: 'Threshold', type: 'Tempo', paceSecPerKm: 250 },
    { date: '2026-09-03', name: 'Threshold', type: 'Tempo', paceSecPerKm: 240 },
  ], 'quality', { metric: 'pace' });
  assert.equal(series.length, 1);
  assert.equal(series[0].value, 245);
});

test('mondayOf anchors every week the same way the rest of the product does', () => {
  assert.equal(mondayOf('2026-09-09'), '2026-09-07');
  assert.equal(mondayOf('2026-09-07'), '2026-09-07');
  assert.equal(mondayOf('2026-09-13'), '2026-09-07', 'Sunday belongs to the week that started');
});

test('a trend needs enough points before it claims a direction', () => {
  assert.equal(trendOf([{ value: 300 }, { value: 280 }]).direction, 'flat');
  assert.equal(trendOf([{ value: 300 }, { value: 280 }]).confident, false);

  const faster = trendOf([300, 295, 288, 282, 275].map(value => ({ value })));
  assert.equal(faster.direction, 'down');
  assert.equal(faster.confident, true);

  const flat = trendOf([300, 300, 301, 300, 299].map(value => ({ value })));
  assert.equal(flat.direction, 'flat');
});
