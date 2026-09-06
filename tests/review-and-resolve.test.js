import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReviewQueue,
  buildTriageQueue,
  signalFingerprint,
} from '../api/coach-data.js';

// Wednesday 9 September 2026, 09:00 Adelaide.
const NOW = new Date('2026-09-08T23:30:00Z');
const TODAY = '2026-09-09';

const athlete = (code, name) => ({ code, name, active: true, archived_at: null });
const log = (code, date, name, category = 'Run') => ({
  athlete_code: code, session_date: date, session_name: name, session_category: category,
});

// Keeps an athlete out of the gone-quiet band so review behaviour can be tested
// on its own.
const recentBody = code => ({ athlete_code: code, log_date: TODAY, pain: null, coach_alert: false });

test('the review queue groups a day of training into one entry', () => {
  const result = buildReviewQueue({
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah')],
    trainingRows: [
      // A strength session writes one row per exercise.
      log('SARAH', '2026-09-07', 'Lower A', 'Strength'),
      log('SARAH', '2026-09-07', 'Lower A', 'Strength'),
      log('SARAH', '2026-09-07', 'Lower A', 'Strength'),
      log('SARAH', '2026-09-07', 'Easy 8km', 'Run'),
    ],
    reviewRows: [],
  });

  assert.equal(result.queue.length, 1, 'one athlete-day, not one per log row');
  assert.equal(result.queue[0].date, '2026-09-07');
  assert.deepEqual(result.queue[0].sessions.map(s => s.name).sort(), ['Easy 8km', 'Lower A']);
  assert.equal(result.counts.pending, 1);
});

test('a reviewed day leaves the queue', () => {
  const trainingRows = [log('SARAH', '2026-09-07', 'Lower A', 'Strength')];
  const before = buildReviewQueue({ now: NOW, athletes: [athlete('SARAH', 'Sarah')], trainingRows, reviewRows: [] });
  const after = buildReviewQueue({
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah')],
    trainingRows,
    reviewRows: [{ athlete_code: 'SARAH', session_date: '2026-09-07', reviewed_by: 'KARL' }],
  });

  assert.equal(before.counts.pending, 1);
  assert.equal(after.counts.pending, 0);
});

test('the queue is oldest first and counts overdue separately', () => {
  const result = buildReviewQueue({
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah'), athlete('JAMES', 'James')],
    trainingRows: [
      log('SARAH', TODAY, 'Tempo 8km'),          // today — pending, not overdue
      log('JAMES', '2026-09-05', 'Long run'),    // four days ago — overdue
    ],
    reviewRows: [],
  });

  assert.deepEqual(result.queue.map(entry => entry.date), ['2026-09-05', TODAY]);
  assert.equal(result.counts.pending, 2);
  assert.equal(result.counts.overdue, 1, 'only submissions past the turnaround window are overdue');
});

test('training outside the window is history, not queue', () => {
  const result = buildReviewQueue({
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah')],
    trainingRows: [log('SARAH', '2026-08-01', 'Long run')],
    reviewRows: [],
  });
  assert.equal(result.counts.pending, 0);
});

test('unreviewed training raises a triage row once it is overdue', () => {
  const base = {
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah')],
    bodyRows: [recentBody('SARAH')],
    sessionRows: [{ athlete_code: 'SARAH', logged_at: '2026-09-08T02:00:00Z' }],
    plannedRows: [],
    reviewRows: [],
  };

  const fresh = buildTriageQueue({ ...base, trainingRows: [log('SARAH', TODAY, 'Tempo 8km')] });
  assert.equal(fresh.queue.length, 0, 'a submission from today is normal turnaround');
  assert.equal(fresh.counts.reviewPending, 1);

  const stale = buildTriageQueue({ ...base, trainingRows: [log('SARAH', '2026-09-05', 'Long run')] });
  assert.equal(stale.queue.length, 1);
  assert.equal(stale.queue[0].flag, 'awaiting_review');
  assert.equal(stale.queue[0].action.type, 'open_review');
  assert.equal(stale.queue[0].action.date, '2026-09-05');
  assert.match(stale.queue[0].signal, /Long run submitted 4 days ago and not yet reviewed/);
});

test('awaiting review never outranks a louder signal on the same athlete', () => {
  const result = buildTriageQueue({
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah')],
    // Pain and stale unreviewed training at once.
    bodyRows: [{ athlete_code: 'SARAH', log_date: '2026-09-08', pain: 7, coach_alert: false }],
    sessionRows: [{ athlete_code: 'SARAH', logged_at: '2026-09-08T02:00:00Z' }],
    trainingRows: [log('SARAH', '2026-09-05', 'Long run')],
    plannedRows: [],
    reviewRows: [],
  });

  assert.equal(result.queue.length, 1, 'one row per athlete');
  assert.equal(result.queue[0].flag, 'pain');
  // The review backlog is still reported, just not as a second queue row.
  assert.equal(result.counts.reviewPending, 1);
});

test('a resolved signal stays out of the queue until its fingerprint moves', () => {
  const base = {
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah')],
    sessionRows: [{ athlete_code: 'SARAH', logged_at: '2026-09-08T02:00:00Z' }],
    trainingRows: [],
    plannedRows: [],
    reviewRows: [],
  };
  const painRow = { athlete_code: 'SARAH', log_date: '2026-09-08', pain: 7, coach_alert: false };

  const raised = buildTriageQueue({ ...base, bodyRows: [painRow] });
  assert.equal(raised.queue.length, 1);
  const { fingerprint } = raised.queue[0];
  assert.ok(fingerprint, 'every queue row carries the fingerprint it was raised on');

  const resolvedRows = [{
    athlete_code: 'SARAH', signal_type: 'pain', fingerprint,
    resolved_by: 'KARL', resolved_at: '2026-09-09T00:00:00Z',
  }];

  const cleared = buildTriageQueue({ ...base, bodyRows: [painRow], resolvedRows });
  assert.equal(cleared.queue.length, 0);
  assert.equal(cleared.counts.resolved, 1);
  assert.equal(cleared.resolved[0].resolvedBy, 'KARL');
  // Resolved is not the same as clear — a coach dealt with this athlete today.
  assert.equal(cleared.counts.clear, 0);

  // Pain worsens: same athlete, same signal type, different fingerprint.
  const worse = buildTriageQueue({
    ...base,
    bodyRows: [{ ...painRow, pain: 9 }],
    resolvedRows,
  });
  assert.equal(worse.queue.length, 1, 'the row returns when the situation moves');
  assert.equal(worse.counts.resolved, 0);
});

test('fingerprints are stable per signal and change with the values behind them', () => {
  const evidence = { pain: { date: '2026-09-08', score: 7, coachAlert: false } };
  assert.equal(
    signalFingerprint('pain', evidence),
    signalFingerprint('pain', { pain: { ...evidence.pain } })
  );
  assert.notEqual(
    signalFingerprint('pain', evidence),
    signalFingerprint('pain', { pain: { ...evidence.pain, score: 9 } })
  );
  // Gone quiet is scoped to the week, so resolving it holds until next Monday.
  assert.equal(
    signalFingerprint('gone_quiet', {}, { weekStart: '2026-09-07' }),
    'quiet|2026-09-07'
  );
  assert.notEqual(
    signalFingerprint('gone_quiet', {}, { weekStart: '2026-09-07' }),
    signalFingerprint('gone_quiet', {}, { weekStart: '2026-09-14' })
  );
});

test('resolving one signal type does not silence another', () => {
  const result = buildTriageQueue({
    now: NOW,
    athletes: [athlete('SARAH', 'Sarah')],
    bodyRows: [{ athlete_code: 'SARAH', log_date: '2026-09-08', pain: 7, coach_alert: false }],
    sessionRows: [{ athlete_code: 'SARAH', logged_at: '2026-09-08T02:00:00Z' }],
    trainingRows: [],
    plannedRows: [],
    reviewRows: [],
    // A stale resolution for a different signal on the same athlete.
    resolvedRows: [{
      athlete_code: 'SARAH', signal_type: 'gone_quiet', fingerprint: 'quiet|2026-09-07',
      resolved_by: 'KARL', resolved_at: '2026-09-09T00:00:00Z',
    }],
  });
  assert.equal(result.queue.length, 1);
  assert.equal(result.queue[0].flag, 'pain');
});
