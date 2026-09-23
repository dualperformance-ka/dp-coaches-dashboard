import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { mapBody, mapGoal, mapSession, mapWeekly, safeRawSets, weeklyFingerprint } from '../api/coach-data.js';

// The shared Supabase contract, dashboard side. Each entry is a column the
// athlete portal writes (dp-athlete-portal api/ingest.js) and the dashboard
// field it must surface as. If the portal adds a coach-relevant column, add it
// here and to docs/INTEGRATION.md; the test then fails until a mapper carries it.
const CONTRACT = {
  daily_body_logs: {
    mapper: mapBody,
    row: { athlete_code: 'A', log_date: '2026-09-23', pain: 7, pain_location: 'left knee', coach_alert: true, raw_payload: { noteText: 'stairs' } },
    fields: { Pain: 7, 'Pain Location': 'left knee', 'Coach Alert': true, 'Athlete Note': 'stairs' },
  },
  weekly_checkins: {
    mapper: mapWeekly,
    row: { athlete_code: 'A', week_ending: '2026-09-20', call_decision: 'Talk about race week taper' },
    fields: { 'Call Decision': 'Talk about race week taper' },
  },
  athlete_goals: {
    mapper: mapGoal,
    row: {
      athlete_code: 'A', strength_intent: 'Get Stronger', strength_priorities: 'Glutes, Core',
      strength_lift: 'Back Squat', strength_current_load: '80', strength_target_load: 100, strength_reps: 5,
      why: 'Sub 3', milestone_w4: 'Consistent', milestone_w8: 'Long run 30k', milestone_w12: 'Race',
    },
    fields: {
      strength_intent: 'Get Stronger', strength_priorities: 'Glutes, Core', strength_lift: 'Back Squat',
      strength_current_load: 80, strength_target_load: 100, strength_reps: 5,
      why: 'Sub 3', milestone_w4: 'Consistent', milestone_w8: 'Long run 30k', milestone_w12: 'Race',
    },
  },
  training_session_logs: {
    mapper: mapSession,
    row: {
      athlete_code: 'A', session_name: 'Tempo', session_category: 'Run', session_date: '2026-09-22',
      distance_km: '10.5', duration_min: 48, pace: '4:34/km', rpe: 7, feel: 4,
      raw_sets: [{ weight: '100', reps: 5, rpe: 8, done: true, effort: 'on_target', token: 'nope' }],
      raw_payload: { stravaActivityId: '1', access_token: 'secret' },
    },
    fields: {
      'Distance KM': 10.5, 'Duration Min': 48, Pace: '4:34/km', RPE: 7, Feel: 4,
      'Raw Sets': [{ weight: 100, reps: 5, rpe: 8, done: true, effort: 'on_target' }],
    },
  },
};

for (const [table, spec] of Object.entries(CONTRACT)) {
  test(`every coach-relevant ${table} column the portal writes is surfaced`, () => {
    const mapped = spec.mapper(spec.row);
    for (const [field, expected] of Object.entries(spec.fields)) {
      assert.deepEqual(mapped[field], expected, `${table} -> ${field}`);
    }
    assert.equal('raw_payload' in mapped, false, `${table} must not return raw_payload`);
    assert.equal(JSON.stringify(mapped).includes('secret'), false);
  });
}

test('empty typed values stay null, not zero', () => {
  const run = mapSession({ athlete_code: 'A', session_name: 'Run', distance_km: null, duration_min: '', rpe: 'abc' });
  assert.equal(run['Distance KM'], null);
  assert.equal(run['Duration Min'], null);
  assert.equal(run.RPE, null);
  assert.equal(run['Raw Sets'], null);
  const zero = mapSession({ athlete_code: 'A', session_name: 'Run', distance_km: 0 });
  assert.equal(zero['Distance KM'], 0);
  const goal = mapGoal({ athlete_code: 'A' });
  assert.equal(goal.strength_current_load, null);
  assert.equal(mapWeekly({ athlete_code: 'A' })['Call Decision'], null);
});

test('raw sets pass through numeric set fields only, capped', () => {
  assert.equal(safeRawSets('not-an-array'), null);
  assert.equal(safeRawSets([{ nothing: 1 }]), null);
  const many = Array.from({ length: 50 }, () => ({ reps: 1 }));
  assert.equal(safeRawSets(many).length, 30);
  assert.deepEqual(safeRawSets([{ repsLeft: '8', repsRight: 7, note: '<script>' }]), [{ repsLeft: 8, repsRight: 7 }]);
});

test('call decision is part of the weekly identity fingerprint', () => {
  const base = { week_ending: '2026-09-20', run_completed: 3, call_decision: 'Discuss taper' };
  assert.notEqual(weeklyFingerprint(base), weeklyFingerprint({ ...base, call_decision: 'Discuss nutrition' }));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  // The client-side merge fingerprint mirrors the server one.
  const merge = html.slice(html.indexOf('function mergeWeekly('), html.indexOf('// ── Build ──'));
  assert.match(merge, /normText\(row\['Call Decision'\]\)/);
});

test('call decision is rendered in every weekly view and leads call prep, never triage', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const sites = html.match(/DP_PARITY\?\.callDecisionHtml\((w|pw)/g) || [];
  // athlete card, full athlete view, previous check-ins history, table view.
  assert.equal(sites.length, 4);
  const prep = html.slice(html.indexOf('function buildCallPrep(a)'), html.indexOf('// ── Exercise log renderer'));
  assert.match(prep, /if \(isBad\(w\['Call Decision'\]\)\) ask\.push\('Call decision: '/);
  assert.doesNotMatch(prep, /issues\.push\([^)]*Call Decision/);
  const server = readFileSync(new URL('../api/coach-data.js', import.meta.url), 'utf8');
  const triage = server.slice(server.indexOf('export function buildTriageQueue'), server.indexOf('function isMissingTriageColumn'));
  assert.doesNotMatch(triage, /call_decision|Call Decision/);
});

test('analysis prefers typed run metrics and raw sets before parsing text', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const runs = html.slice(html.indexOf('function athleteRunSessions(a)'), html.indexOf('function buildLoadChart('));
  assert.match(runs, /const typed = typedRunMetrics\(session\)/);
  assert.match(runs, /typed\.distanceKm \?\? text\.distanceKm/);
  const strength = html.slice(html.indexOf('function athleteStrengthHistory(a)'), html.indexOf('function prescribedExercises('));
  assert.match(strength, /collectExerciseHistory\(.*, textLogs, structuredLogs\)/);
});

test('the shared contract is documented for every surfaced column', () => {
  const doc = readFileSync(new URL('../docs/INTEGRATION.md', import.meta.url), 'utf8');
  for (const column of ['pain_location', 'coach_alert', 'call_decision', 'strength_intent', 'strength_reps',
    'raw_sets', 'contact_messages', 'data_requests', 'notify_status', 'weekly_review', 'strava_activities']) {
    assert.ok(doc.includes(column), `docs/INTEGRATION.md does not mention ${column}`);
  }
});
