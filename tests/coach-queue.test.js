// The coach queue model (public/coach-queue.js): one item per athlete, four
// categories, one status hierarchy, and the Focus Mode walk. These run the
// real module, not a copy of its rules.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  athleteStatus,
  buildCoachQueue,
  classifyClientLine,
  filterItems,
  nextInSession,
  remainingInSession,
  STATUS,
} from '../public/coach-queue.js';

const server = (overrides = {}) => ({
  ok: true,
  counts: { active: 8, resolved: 0 },
  queue: [],
  resolved: [],
  review: { overdueAfterDays: 2, queue: [], counts: {} },
  ...overrides,
});

const pain = (code, name = code) => ({
  athleteCode: code, athleteName: name, flag: 'pain', severity: 'critical', priority: 10070,
  fingerprint: `pain|${code}`, signal: 'Pain 7/10 reported yesterday.',
  action: { type: 'open_athlete', label: 'Open session', athleteCode: code },
  evidence: { pain: { score: 7, location: 'right calf', coachAlert: true } },
});
const quiet = code => ({
  athleteCode: code, athleteName: code, flag: 'gone_quiet', severity: 'high', priority: 5000,
  fingerprint: `quiet|${code}`, signal: 'No completed session and no body log for at least 5 days.',
  action: { type: 'message', label: 'Check in', athleteCode: code },
});
const drift = code => ({
  athleteCode: code, athleteName: code, flag: 'compliance_drift', severity: 'medium', priority: 3000,
  fingerprint: `drift|${code}`, signal: 'Completed 2 of 5 sessions planned so far this week.',
  action: { type: 'review', label: 'Review plan', athleteCode: code },
});
const day = (code, date, days, names = ['Long run']) => ({
  athleteCode: code, athleteName: code, date, days, sessions: names.map(name => ({ name })),
});

// ── Grouping ────────────────────────────────────────────────────────────────

test('every source maps to one of four categories', () => {
  const { items, counts } = buildCoachQueue({
    server: server({
      queue: [pain('KAI'), quiet('ANNA'), drift('TOM')],
      review: { overdueAfterDays: 2, queue: [day('JAMES', '2026-10-11', 3)] },
    }),
    messages: [{ id: 'm1', athleteCode: 'SARAH', body: 'Can we move Thursday?', readAt: null }],
  });
  const byCode = Object.fromEntries(items.map(i => [i.code, i.category]));
  assert.deepEqual(byCode, { KAI: 'urgent', JAMES: 'review', ANNA: 'followup', SARAH: 'followup', TOM: 'plan' });
  assert.deepEqual(
    { all: counts.all, urgent: counts.urgent, review: counts.review, followup: counts.followup, plan: counts.plan },
    { all: 5, urgent: 1, review: 1, followup: 2, plan: 1 });
  // Ordered by category, then urgency inside it.
  assert.deepEqual(items.map(i => i.category), ['urgent', 'review', 'followup', 'followup', 'plan']);
});

test('an athlete appears once, with one primary reason and the rest summarised', () => {
  const { items } = buildCoachQueue({
    server: server({
      queue: [quiet('SARAH')],
      review: { overdueAfterDays: 2, queue: [day('SARAH', '2026-10-09', 5, ['Threshold']), day('SARAH', '2026-10-11', 3, ['Upper B', 'Easy 6km'])] },
    }),
    client: [{ athleteCode: 'SARAH', athleteName: 'Sarah Chen', flag: 'client_alert', priority: 1201, fingerprint: 'ack|s',
      lines: [{ text: 'Recovery 4/10, down 2 over two weeks.', critical: false }] }],
  });
  assert.equal(items.length, 1, 'one row per athlete');
  const [sarah] = items;
  // Overdue review leads every follow-up.
  assert.equal(sarah.category, 'review');
  assert.equal(sarah.status, 'Review overdue');
  assert.equal(sarah.summary, '3 sessions waiting · oldest 5 days');
  assert.deepEqual(sarah.additional.map(a => a.text), [
    'No completed session and no body log for at least 5 days.',
    'Recovery 4/10, down 2 over two weeks.',
  ]);
  assert.equal(sarah.primaryAction.type, 'open_review');
  assert.equal(sarah.primaryAction.date, '2026-10-09', 'opens the oldest day first');
  assert.equal(sarah.completion.label, 'Mark reviewed');
  assert.deepEqual(sarah.completion.dates.slice().sort(), ['2026-10-09', '2026-10-11']);
  assert.equal(sarah.name, 'Sarah Chen', 'a later source can supply the display name');
});

test('review work is never a second list: the server awaiting_review row folds in', () => {
  const { items } = buildCoachQueue({
    server: server({
      queue: [{ athleteCode: 'JAMES', athleteName: 'James', flag: 'awaiting_review', severity: 'medium', priority: 2030,
        fingerprint: 'review|x', signal: 'Long run submitted 3 days ago and not yet reviewed.',
        action: { type: 'open_review', label: 'Review session', athleteCode: 'JAMES', date: '2026-10-11' } }],
      review: { overdueAfterDays: 2, queue: [day('JAMES', '2026-10-11', 3)] },
    }),
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].signals.length, 1, 'one review signal, not the server row and the day again');
  assert.equal(items[0].signals[0].serverResolve.fingerprint, 'review|x');
});

test('a review that is not overdue yields to a follow-up, but outranks plan work', () => {
  const quietAndFresh = buildCoachQueue({
    server: server({ queue: [quiet('ANNA')], review: { overdueAfterDays: 2, queue: [day('ANNA', '2026-10-13', 1)] } }),
  }).items[0];
  assert.equal(quietAndFresh.category, 'followup');
  assert.deepEqual(quietAndFresh.additional.map(a => a.text), ['Review due']);

  const planAndFresh = buildCoachQueue({
    server: server({ queue: [drift('LUCA')], review: { overdueAfterDays: 2, queue: [day('LUCA', '2026-10-14', 0)] } }),
  }).items[0];
  assert.equal(planAndFresh.category, 'review');
  assert.equal(planAndFresh.status, 'Review due');
});

test('pain leads everything for its athlete and names the score', () => {
  const { items } = buildCoachQueue({
    server: server({ queue: [pain('KAI', 'Kai Tran')], review: { overdueAfterDays: 2, queue: [day('KAI', '2026-10-10', 4)] } }),
    messages: [{ id: '41', athleteCode: 'KAI', body: 'Calf tight', readAt: null }],
  });
  assert.equal(items[0].category, 'urgent');
  assert.equal(items[0].status, 'Pain 7/10');
  assert.equal(items[0].completion.kind, 'signal');
  assert.equal(items[0].completion.fingerprint, 'pain|KAI');
  assert.deepEqual(items[0].additional.map(a => a.text), ['Review overdue', 'Unread message']);
});

test('read messages are not work', () => {
  const { items } = buildCoachQueue({
    server: server(),
    messages: [{ id: '38', athleteCode: 'TOM', body: 'Thanks', readAt: '2026-10-10T00:00:00Z' }],
  });
  assert.equal(items.length, 0);
});

test('filters and counts mean the same thing', () => {
  const { items, counts } = buildCoachQueue({
    server: server({ queue: [pain('A'), quiet('B'), drift('C'), drift('D')], resolved: [{ athleteCode: 'E', flag: 'pain' }] }),
  });
  for (const key of ['urgent', 'review', 'followup', 'plan']) {
    assert.equal(filterItems(items, key).length, counts[key], key);
  }
  assert.equal(filterItems(items, 'all').length, counts.all);
  assert.equal(counts.urgent + counts.review + counts.followup + counts.plan, counts.all);
  assert.equal(counts.resolved, 1);
});

test('an unknown server flag still lands in the queue', () => {
  const { items } = buildCoachQueue({
    server: server({ queue: [{ athleteCode: 'X', flag: 'brand_new_signal', priority: 1, fingerprint: 'f', signal: 'Something new' }] }),
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'followup');
});

// ── Client alert classification ─────────────────────────────────────────────
// Every phrase buildActionList and derivedSignalsFor generate, against the
// category it must land in. If a generator's wording changes, this fails.

test('every generated client alert phrase lands in the right category', () => {
  const cases = [
    ['Run niggle: sharp pain in left knee', true, 'urgent'],
    ['Lift niggle: shoulder strain', true, 'urgent'],
    ['Run niggle: Right calf.', false, 'followup'],
    ['Stress 8/10 — manage load this week', true, 'followup'],
    ['Stress 6/10', false, 'followup'],
    ['Motivation 4/10 — check in personally', true, 'followup'],
    ['Sleep avg 5.2/10 over 7d', true, 'followup'],
    ['No check-in for 12d', true, 'followup'],
    ['Recovery 4/10, down 2 over two weeks.', true, 'followup'],
    ['This week compliance 40%', true, 'plan'],
    ['Calories -350 vs target — under-fuelling', true, 'plan'],
    ['Calories +150 vs target — over', false, 'plan'],
    ['Protein 110g vs 140g target', false, 'plan'],
    ['Weight +1.6kg over 14d', false, 'plan'],
    ['Volume 52km is 45% above the four-week baseline.', true, 'plan'],
    ['Volume 20km is 30% below the four-week baseline.', false, 'plan'],
    ['2 lifts stalled: Back Squat, Barbell Bench Press.', false, 'plan'],
    ['Romanian Deadlift done 1 of 4 times.', false, 'plan'],
    ['3 easy runs logged at RPE 7 or above in the last six sessions.', false, 'plan'],
  ];
  for (const [text, critical, expected] of cases) {
    assert.equal(classifyClientLine(text, critical), expected, text);
  }
});

test('the generators still use the phrasing the classifier was written for', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const phrase of ['Run niggle: ', 'Lift niggle: ', '— manage load this week', '— check in personally',
    'Sleep avg ', 'No check-in for ', 'This week compliance ', 'under-fuelling', 'Protein ', 'Weight ',
    'above the four-week baseline', 'lifts stalled', ' done ${', 'easy runs logged at RPE', 'Recovery ${']) {
    assert.ok(html.includes(phrase), `generator phrase missing: ${phrase}`);
  }
});

// ── Status hierarchy ─────────────────────────────────────────────────────────

test('the highest active state decides the status', () => {
  const item = signals => ({ signals: signals.map(category => ({ category })) });
  assert.equal(athleteStatus({ item: item(['plan', 'review', 'urgent']) }), STATUS.urgent);
  assert.equal(athleteStatus({ item: item(['review', 'followup']) }), STATUS.attention);
  assert.equal(athleteStatus({ item: item(['plan']) }), STATUS.attention);
  assert.equal(athleteStatus({ item: item(['review']) }), STATUS.review);
  assert.equal(athleteStatus({ item: null }), STATUS.ontrack);
  assert.equal(athleteStatus({ item: null, noData: true }), STATUS.nodata);
  // An open review outranks "no recent data".
  assert.equal(athleteStatus({ item: item(['review']), noData: true }), STATUS.review);
  assert.deepEqual(Object.values(STATUS).sort((a, b) => a.rank - b.rank).map(s => s.key),
    ['urgent', 'attention', 'review', 'ontrack', 'nodata']);
});

test('an unresolved alert or review can never read On track', () => {
  // The bug this replaces: Squad said "On track" for an athlete Today flagged.
  assert.notEqual(athleteStatus({ lines: [{ text: 'Run niggle: Right calf.', critical: false }] }).key, 'ontrack');
  assert.notEqual(athleteStatus({ item: { signals: [{ category: 'review' }] } }).key, 'ontrack');
  assert.equal(athleteStatus({ lines: [{ text: 'Run niggle: knee pain', critical: true }] }).key, 'urgent');
});

// ── Focus Mode sequencing ────────────────────────────────────────────────────

test('Focus Mode walks a fixed order and skips what has left the queue', () => {
  const live = codes => codes.map(code => ({ code }));
  const session = { order: ['A', 'B', 'C', 'D'], index: -1, done: [] };
  assert.equal(nextInSession(session, live(['A', 'B', 'C', 'D'])), 0);

  // A completed; B resolved elsewhere by the other coach; next is C.
  session.index = 0; session.done = ['A'];
  assert.equal(nextInSession(session, live(['B', 'C', 'D'].filter(c => c !== 'B'))), 2);

  // Order is not reshuffled by a reload that re-ranks the queue.
  assert.equal(nextInSession({ ...session, index: 2, done: ['A', 'C'] }, live(['D', 'C'])), 3);
  // Nothing left.
  assert.equal(nextInSession({ ...session, index: 3, done: ['A', 'C', 'D'] }, live([])), -1);
  assert.equal(remainingInSession({ order: ['A', 'B', 'C'], done: ['A'] }, live(['A', 'B'])), 1);
});

test('Focus Mode never completes an item on its own', () => {
  const triage = readFileSync(new URL('../public/triage.js', import.meta.url), 'utf8');
  const focusSource = triage.slice(triage.indexOf('// ── Focus Mode'), triage.indexOf('window.loadTriage = loadTriage'));
  // Completion only ever runs from a click on the completion control.
  const completions = [...focusSource.matchAll(/completeItem\(|resolveRow\(|markReviewed\(|markMessageRead\(/g)].length;
  const handlers = [...focusSource.matchAll(/target\.closest\('\[data-(focus-complete|triage-resolve|review-done|message-read)\]'\)/g)].length;
  assert.ok(completions > 0 && completions <= handlers + 1, 'every completion path is behind a coach click');
  assert.match(focusSource, /if \(target\.closest\('\[data-focus-complete\]'\)\) return completeFocus\(\);/);
  // And it confirms before moving on, with focus on Next.
  assert.match(focusSource, /focus\.view = 'done';/);
  assert.match(focusSource, /data-focus-next data-focus-autofocus/);
  // Keyboard: Escape closes, Tab is trapped in the dialog.
  assert.match(focusSource, /event\.key === 'Escape'/);
  assert.match(focusSource, /role="dialog" aria-modal="true" aria-labelledby="cq-focus-title"/);
});
