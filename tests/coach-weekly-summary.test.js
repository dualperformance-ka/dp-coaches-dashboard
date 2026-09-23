import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  aggregateCoachEndurance,
  chooseWeek,
  loadCoachWeeklySummary,
} from '../server/coach-weekly-summary.js';

// The pure metric rules are a verbatim copy of the portal's
// api/_lib/performance-summary.js (everything above its DATABASE divider). The
// portal pins the same hash in tests/coach-summary-mirror.test.js, so a rule
// change on either side fails until both copies match again.
export const SHARED_RULES_SHA256 = 'd7ac7726980e156b023b846fa6fba5ac8a08c6bce7120781a0adb4692f253ee1';

test('the shared metric rules match the portal copy byte for byte', () => {
  const source = readFileSync(new URL('../server/performance-summary-core.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export const SUMMARY_VERSION')).trimEnd() + '\n';
  assert.equal(createHash('sha256').update(body).digest('hex'), SHARED_RULES_SHA256,
    'server/performance-summary-core.js drifted from the portal; copy the portal block again');
  assert.doesNotMatch(body, /\bimport\b/);
});

const WEEK = { start: '2026-09-14', end: '2026-09-20' };

test('uploads and portal logs are never double-counted for the same sport-day', () => {
  const out = aggregateCoachEndurance({
    startDate: WEEK.start, endDate: WEEK.end,
    trainingLogs: [
      { session_date: '2026-09-15', session_category: 'Run', session_name: 'Easy', distance_km: 8, duration_min: 45 },
      { session_date: '2026-09-17', session_category: 'Run', session_name: 'Tempo', distance_km: 10, duration_min: 48 },
      { session_date: '2026-09-17', session_category: 'Strength', session_name: 'Lower A' },
    ],
    uploads: [
      // Same day as the Tempo log: the file is the measurement, the log is not added.
      { activity_date: '2026-09-17', sport_type: 'running', summary: { distanceM: 10200, movingTimeS: 2880 }, coach_access_granted_at: '2026-09-17T00:00:00Z' },
      // No consent timestamp: never counted.
      { activity_date: '2026-09-18', sport_type: 'running', summary: { distanceM: 5000 }, coach_access_granted_at: null },
    ],
  });
  assert.equal(out.running.actualSessions, 2);
  assert.equal(out.running.actualDistanceKm, 18.2);
  assert.equal(out.running.actualDurationMinutes, 93);
  assert.equal(out.running.actualSource, 'portal_logs+activity_uploads');
  assert.equal(out.cycling.actualSessions, 0);
  assert.equal(out.cycling.actualDistanceKm, null, 'no measured distance is null, not 0 km');
});

test('an unreadable source is unavailable, never a verified zero', () => {
  const out = aggregateCoachEndurance({ startDate: WEEK.start, endDate: WEEK.end, trainingLogs: null, uploads: null });
  assert.equal(out.running.actualSessions, null);
  assert.equal(out.running.actualSource, 'unavailable');
});

test('week selection defaults to the current programme week and never the future', () => {
  const weeks = [
    { id: 'a', startDate: '2026-09-07' }, { id: 'b', startDate: '2026-09-14' }, { id: 'c', startDate: '2026-09-21' }, { id: 'd', startDate: '2026-09-28' },
  ];
  assert.equal(chooseWeek(weeks, '', '2026-09-23').id, 'c');
  assert.equal(chooseWeek(weeks, 'a', '2026-09-23').id, 'a');
  assert.equal(chooseWeek(weeks, 'zzz', '2026-09-23'), null);
});

const PROG = '11111111-1111-4111-8111-111111111111';
const W1 = '22222222-2222-4222-8222-222222222222';
const W2 = '33333333-3333-4333-8333-333333333333';

function fakeSelect(overrides = {}) {
  const tables = [];
  const select = async (table, params) => {
    tables.push(table);
    if (overrides[table]) return overrides[table](params);
    switch (table) {
      case 'athlete_programmes': return [{ id: PROG }];
      case 'athlete_programme_weeks': return [
        { id: W1, programme_id: PROG, week_number: 1, week_label: 'Week 1', start_date: '2026-09-14' },
        { id: W2, programme_id: PROG, week_number: 2, week_label: 'Week 2', start_date: '2026-09-21' },
      ];
      case 'planned_sessions': return [
        { id: 'p1', title: 'Easy Run', planned_date: '2026-09-15', session_type: 'Run', status: null },
        { id: 'p2', title: 'Lower A', planned_date: '2026-09-16', session_type: 'Strength', status: null },
        { id: 'p3', title: 'Tempo Run', planned_date: '2026-09-17', session_type: 'Run', status: null, distance_km: 10 },
      ];
      case 'session_logs': return [{ session_key: 'p1' }, { session_key: 'p3' }];
      case 'training_session_logs': return [
        { session_date: '2026-09-15', session_category: 'Run', session_name: 'Easy Run', distance_km: 8, duration_min: 45 },
        { session_date: '2026-09-17', session_category: 'Run', session_name: 'Tempo Run', distance_km: 10, duration_min: 48 },
      ];
      case 'daily_body_logs': return params.select.includes('weight')
        ? [{ log_date: '2026-09-15', weight: 80, sleep: 7, energy: 7, stress: 3, soreness: 3, raw_payload: { pain: '7', painLocation: 'left knee' } },
          { log_date: '2026-09-19', weight: 79.4, sleep: 8, energy: 8, stress: 2, soreness: 2 }]
        : [];
      case 'weekly_checkins': return [];
      case 'athlete_activity_uploads': return [];
      case 'workout_splits': return [{ name: 'Lower A' }];
      default: throw new Error(`unexpected table ${table}`);
    }
  };
  return { select, tables };
}

test('the coach summary uses coach-safe sources only and never reads strava_activities', async () => {
  const { select, tables } = fakeSelect();
  const result = await loadCoachWeeklySummary({ code: 'knee', programmeWeekId: W1, select, now: new Date('2026-09-23T00:30:00Z') });
  assert.equal(tables.includes('strava_activities'), false);
  const source = readFileSync(new URL('../server/coach-weekly-summary.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /strava_activities/);

  const s = result.summary;
  assert.equal(result.athleteCode, 'KNEE');
  assert.equal(s.audience, 'coach');
  assert.equal(s.dataQuality.stravaExcluded, true);
  assert.equal(s.dataQuality.partial, false);
  assert.equal(s.training.plannedSessions, 3);
  assert.equal(s.training.completedSessions, 2);
  assert.equal(s.training.completionPercent, 67);
  assert.deepEqual(s.training.missedSessions.map(m => m.title), ['Lower A']);
  assert.equal(s.endurance.running.actualDistanceKm, 18);
  assert.equal(s.endurance.running.actualSource, 'portal_logs');
  assert.equal(s.endurance.running.actualSourceLabel, 'Confirmed portal logs');
  assert.equal(s.bodyweight.changeKg, -0.6);
  assert.equal(s.checkIn.submitted, false);
  assert.ok(s.attention.some(a => a.code === 'pain_reported'));
  assert.equal(result.navigation.currentId, W1);
  assert.equal(result.navigation.nextId, W2);
  assert.equal(result.navigation.previousId, null);
});

test('a failed optional source marks the summary partial and nulls, not zeros, the metric', async () => {
  const { select } = fakeSelect({ training_session_logs: () => { throw new Error('boom'); } });
  const { summary } = await loadCoachWeeklySummary({ code: 'KNEE', programmeWeekId: W1, select, now: new Date('2026-09-23T00:30:00Z') });
  assert.equal(summary.dataQuality.partial, true);
  assert.ok(summary.dataQuality.missingSources.includes('training_session_logs'));
  assert.equal(summary.endurance.running.actualSource, 'unavailable');
  assert.equal(summary.endurance.running.actualDistanceKm, null);
});

test('inputs are validated and a week from another athlete is not found', async () => {
  const { select } = fakeSelect();
  await assert.rejects(loadCoachWeeklySummary({ code: 'bad code!', select }), e => e.status === 400);
  await assert.rejects(loadCoachWeeklySummary({ code: 'KNEE', programmeWeekId: 'nope', select }), e => e.status === 400);
  await assert.rejects(loadCoachWeeklySummary({ code: 'KNEE', programmeWeekId: '44444444-4444-4444-8444-444444444444', select }), e => e.status === 404);
  const none = fakeSelect({ athlete_programmes: () => [] });
  await assert.rejects(loadCoachWeeklySummary({ code: 'KNEE', select: none.select }), e => e.status === 404);
});
