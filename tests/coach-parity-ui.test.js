import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { collectExerciseHistory } from '../public/strength-analysis.js';

const require = createRequire(import.meta.url);
require('../public/coach-parity.js');
const P = globalThis.DP_PARITY;
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('pain entries render score, location, alert and the athlete note, escaped', () => {
  const row = { Pain: 7, 'Pain Location': '<img src=x>knee', 'Coach Alert': true, 'Athlete Note': 'sharp <b>on</b> stairs' };
  const chip = P.painChipHtml(row);
  assert.match(chip, /is-alert/);
  assert.match(chip, /Pain <strong>7\/10<\/strong>/);
  assert.match(chip, /&lt;img src=x&gt;knee/);
  assert.doesNotMatch(chip, /<img/);
  assert.match(P.athleteNoteHtml(row), /sharp &lt;b&gt;on&lt;\/b&gt; stairs/);
  // Zero is a real answer; not reported shows nothing.
  assert.match(P.painChipHtml({ Pain: 0, 'Coach Alert': false }), /No pain/);
  assert.equal(P.painChipHtml({ Pain: null }), '');
});

test('call decision renders only when present and is escaped', () => {
  assert.equal(P.callDecisionHtml({ 'Call Decision': '' }), '');
  assert.equal(P.callDecisionHtml({ 'Call Decision': 'n/a' }), '');
  assert.match(P.callDecisionHtml({ 'Call Decision': 'Talk <taper>' }), /Talk &lt;taper&gt;/);
});

test('the goals panel shows the tracked lift and hides empty fields', () => {
  const goal = {
    strength_intent: 'Get Stronger', strength_priorities: 'Glutes, Calves & Achilles',
    strength_lift: 'Back Squat', strength_current_load: 80, strength_target_load: 100, strength_reps: 5,
    why: 'Sub 3 marathon', milestone_w4: '', milestone_w8: null, milestone_w12: 'Race',
  };
  const out = P.goalsPanelHtml(goal);
  assert.match(out, /Back Squat: 80 kg → 100 kg × 5/);
  assert.match(out, /Calves &amp; Achilles/);
  assert.match(out, /W12 milestone/);
  assert.doesNotMatch(out, /W4 milestone|W8 milestone/);
  assert.doesNotMatch(P.goalsPanelHtml(goal, { includeRationale: false }), /Sub 3 marathon/);
  assert.equal(P.goalsPanelHtml({ strength_lift: '' }), '');
  assert.equal(P.goalsPanelHtml(null), '');
});

test('queues have loading, error, empty and partial states and escape athlete text', () => {
  const state = P._state;
  state.loaded = false;
  assert.match(P.messagesHtml(), /Loading messages/);
  P.setOperations({ ok: true, contactMessages: [], dataRequests: [], notifyStatus: [], dataQuality: { missingSources: [] } }, []);
  assert.match(P.messagesHtml(), /No athlete messages/);
  assert.match(P.requestsHtml(), /No data requests/);
  P.setOperations({ ok: true, contactMessages: [], dataRequests: [], notifyStatus: [], dataQuality: { partial: true, missingSources: ['data_requests'] } }, []);
  assert.match(P.requestsHtml(), /could not be loaded/);
  assert.doesNotMatch(P.requestsHtml(), /No data requests/);
  P.setOperations({ ok: false }, []);
  assert.match(P.messagesHtml(), /could not be loaded/);

  P.setOperations({
    ok: true,
    contactMessages: [{ id: '1', athleteCode: 'KNEE', body: '<script>alert(1)</script>', createdAt: new Date().toISOString(), readAt: null }],
    dataRequests: [{ id: 'r1', athleteCode: 'KNEE', kind: 'account_deletion', requestedAt: '2026-08-01T00:00:00Z', dueAt: '2026-08-31T00:00:00Z', state: 'overdue', daysOpen: 53 }],
    notifyStatus: [{ athleteCode: 'KNEE', devices: 0, delivery: 'no_device', queued: 0, unread: 2 }],
    dataQuality: { missingSources: [] },
  }, [{ id: 'KNEE', name: 'Knee <Athlete>' }]);
  const messages = P.messagesHtml();
  assert.doesNotMatch(messages, /<script>/);
  assert.match(messages, /data-cp-action="message_read"/);
  assert.match(messages, /Knee &lt;Athlete&gt;/);
  const requests = P.requestsHtml();
  assert.match(requests, /Past 30 days/);
  assert.match(requests, /data-cp-action="data_request_acknowledge"/);
  assert.match(requests, /data-cp-action="data_request_complete"/);
  assert.match(P.notifyLineHtml(P.notifyFor('knee')), /No registered device: inbox only/);
});

test('the weekly review states its source and never implies Strava parity', () => {
  const out = P.summaryHtml({
    summary: {
      period: { label: 'Week 1', startDate: '2026-09-14', endDate: '2026-09-20', state: 'complete' },
      training: { plannedSessions: 3, completedSessions: 2, completionPercent: 67, byType: { running: { planned: 2, completed: 2 } }, missedSessions: [{ title: 'Lower A', date: '2026-09-16' }] },
      endurance: { running: { plannedDistanceKm: 18, actualSessions: 2, actualDistanceKm: 18, actualDurationMinutes: 93, actualSource: 'portal_logs', actualSourceLabel: 'Confirmed portal logs' } },
      strength: { plannedSessions: 1, completedSessions: 0, workingSets: 0, measurableVolumeKg: null, personalBests: [] },
      readiness: { average: null, daysLogged: 0, changeFromPreviousWeek: null },
      bodyweight: { lastKg: 79.4, changeKg: -0.6 },
      checkIn: { submitted: false },
      attention: [{ severity: 'high', message: 'Pain at <b>knee</b>' }],
      dataQuality: { partial: true, missingSources: ['session_logs'], warnings: [] },
    },
    navigation: { previousId: null, nextId: 'w2' },
  });
  assert.match(out, /Confirmed portal logs/);
  assert.match(out, /athlete's own card may show a different distance/);
  assert.match(out, /Partial data: session_logs/);
  // null renders as unavailable, not 0.
  assert.match(out, /Readiness<\/div><div class="cws-num"><span class="cws-na"/);
  assert.match(out, /Pain at &lt;b&gt;knee&lt;\/b&gt;/);
  assert.match(out, /-0\.6 kg over the week/);
  assert.match(out, /data-cws-week="w2"/);
});

test('the dashboard wires every parity surface in', () => {
  assert.match(html, /<script src="\/coach-parity\.js\?v=[\w-]+" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/coach-parity\.css\?v=[\w-]+">/);
  assert.match(html, /<div id="athlete-messages"><\/div>\s*<div id="data-requests"><\/div>/);
  assert.match(html, /<div id="notify-health"><\/div>/);
  assert.match(html, /window\.DP_PARITY\?\.setOperations\(coachDataSB, athletes\)/);
  assert.match(html, /training: \[weekStrip, window\.DP_PARITY\?\.weeklySummaryPlaceholder\(a\.id\)/);
  assert.match(html, /window\.DP_PARITY\?\.hydrate\(document\.getElementById\('fp-body'\)\)/);
  assert.match(html, /overview: \[[^\]]*goalsHtml, notifyHtml\]/);
  // Body ledger, week detail and the calendar session view.
  assert.equal((html.match(/DP_PARITY\?\.painChipHtml\(/g) || []).length, 3);
});

test('Today rows show the structured pain score and location', () => {
  const triage = readFileSync(new URL('../public/triage.js', import.meta.url), 'utf8');
  assert.match(triage, /function painDetail\(row\)/);
  assert.match(triage, /pain\.location/);
  assert.match(triage, /\$\{painDetail\(row\)\}/);
});

test('typed raw_sets win over the blob and the text parser for the same exercise-day', () => {
  const history = collectExerciseHistory(
    { s1: { 'Back Squat': [{ weight: 90, reps: 5 }] } },
    [{ id: 's1', date: '2026-09-16' }],
    [{ date: '2026-09-16', exerciseLog: 'Back Squat: Set 1: 70kg × 5reps' }],
    [{ date: '2026-09-16', exercise: 'Back Squat', sets: [{ weight: 100, reps: 5 }, { weight: 100, reps: 4 }] }],
  );
  const squat = history.get('back squat');
  assert.equal(squat.instances.length, 1, 'one instance per exercise-day, never double counted');
  assert.deepEqual(squat.instances[0].sets.map(s => s.weight), [100, 100]);
  // Without typed sets the older behaviour holds.
  const legacy = collectExerciseHistory({ s1: { 'Back Squat': [{ weight: 90, reps: 5 }] } }, [{ id: 's1', date: '2026-09-16' }], []);
  assert.equal(legacy.get('back squat').instances[0].sets[0].weight, 90);
});
