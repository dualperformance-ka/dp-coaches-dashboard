import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchKey,
  parseExerciseLogText,
  estimate1RM,
  collectExerciseHistory,
  summariseExercises,
  weeklyStrengthVolume,
} from '../public/strength-analysis.js';
import { mondayOf } from '../public/run-analysis.js';

const sessions = [
  { id: 's1', date: '2026-07-06' },
  { id: 's2', date: '2026-07-13' },
  { id: 's3', date: '2026-07-20' },
  { id: 's4', date: '2026-07-27' },
];

test('exercise identity survives capitalisation and spacing', () => {
  assert.equal(matchKey('Back Squat'), 'back squat');
  assert.equal(matchKey('back  squat'), 'back squat');
  assert.equal(matchKey('Back-Squat'), 'back squat');
  assert.equal(matchKey(''), '');
});

test('the free-text log parses into sets when the structured blob is missing', () => {
  const parsed = parseExerciseLogText(
    'Back squat: Set 1: 92.5kg × 5 @ RPE 8 | Set 2: 92.5kg × 5 @ RPE 8.5\n'
    + 'Romanian DL: Set 1: 100kg × 8 @ RPE 7'
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].exercise, 'Back squat');
  assert.deepEqual(parsed[0].sets, [
    { weight: 92.5, reps: 5, rpe: 8 },
    { weight: 92.5, reps: 5, rpe: 8.5 },
  ]);
  assert.equal(parsed[1].sets[0].weight, 100);
});

test('a saved-but-empty log yields no sets rather than a phantom session', () => {
  assert.deepEqual(parseExerciseLogText('Back squat: Set 1: —kg × — reps'), []);
  assert.deepEqual(parseExerciseLogText(''), []);
  // A note line without the "Set" marker is not an exercise.
  assert.deepEqual(parseExerciseLogText('Felt strong today'), []);
});

test('the estimator matches the one the PR badge already uses', () => {
  // Epley: w × (1 + r/30).
  assert.equal(Math.round(estimate1RM(100, 5) * 10) / 10, 116.7);
  assert.equal(estimate1RM(100, 0), null);
  assert.equal(estimate1RM(null, 5), null);
});

test('history is collected from the structured blob, oldest first', () => {
  const logs = {
    s2: { 'Back squat': [{ weight: 92.5, reps: 5, rpe: 8 }] },
    s1: { 'Back squat': [{ weight: 90, reps: 5, rpe: 8 }] },
    __savedAt: 12345,
  };
  const history = collectExerciseHistory(logs, sessions, []);
  const entry = history.get('back squat');
  assert.equal(entry.instances.length, 2);
  assert.deepEqual(entry.instances.map(i => i.date), ['2026-07-06', '2026-07-13']);
});

test('unilateral work is scored on the weaker side', () => {
  const logs = { s1: { 'Bulgarian split squat': [{ weight: 22, repsLeft: 8, repsRight: 6 }] } };
  const history = collectExerciseHistory(logs, sessions, []);
  assert.equal(history.get('bulgarian split squat').instances[0].sets[0].reps, 6);
});

test('a day logged in both places is not counted twice', () => {
  const logs = { s1: { 'Back squat': [{ weight: 90, reps: 5 }] } };
  const textLogs = [
    { date: '2026-07-06', exerciseLog: 'Back squat: Set 1: 90kg × 5' },   // same day as s1
    { date: '2026-07-13', exerciseLog: 'Back squat: Set 1: 92.5kg × 5' }, // only in text
  ];
  const history = collectExerciseHistory(logs, sessions, textLogs);
  assert.equal(history.get('back squat').instances.length, 2);
});

test('a skipped exercise is the row a coach is scanning for', () => {
  const logs = {
    s1: { 'Bulgarian split squat': [{ weight: 22, reps: 8 }] },
    s2: { 'Back squat': [{ weight: 90, reps: 5 }] },
    s3: { 'Back squat': [{ weight: 92.5, reps: 5 }] },
  };
  const history = collectExerciseHistory(logs, sessions, []);
  // Counts cover sessions already reached, so back squat is 2 of 3 and the
  // split squat is 1 of 8.
  const rows = summariseExercises(history, {
    prescribedCounts: new Map([['bulgarian split squat', 8], ['back squat', 3]]),
  });

  // Skipped sorts to the top regardless of name.
  assert.equal(rows[0].name, 'Bulgarian split squat');
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].prescribed, 8);
  assert.equal(rows[0].isSkipped, true);
  assert.equal(rows[0].adherencePct, 13);

  const squat = rows.find(r => r.key === 'back squat');
  assert.equal(squat.isSkipped, false, 'two of three is showing up, not avoiding it');
});

test('a rarely prescribed exercise is never called skipped', () => {
  const logs = { s1: { 'Calf raise': [{ weight: 40, reps: 12 }] } };
  const history = collectExerciseHistory(logs, sessions, []);
  const rows = summariseExercises(history, { prescribedCounts: new Map([['calf raise', 2]]) });
  // One of two looks bad as a ratio but is far too little evidence to act on.
  assert.equal(rows[0].isSkipped, false);
});

test('load change is reported against the first logged session', () => {
  const logs = {
    s1: { 'Bench press': [{ weight: 60, reps: 6 }] },
    s4: { 'Bench press': [{ weight: 70, reps: 6 }] },
  };
  const rows = summariseExercises(collectExerciseHistory(logs, sessions, []), {});
  assert.equal(rows[0].latest.topWeight, 70);
  assert.equal(rows[0].changeKg, 12, 'e1RM moved from 72 to 84');
  assert.equal(rows[0].series.length, 2);
});

test('the overload engine runs only where the coach prescribed a rep range', () => {
  // Same load and reps at a high RPE, week after week.
  const logs = Object.fromEntries(sessions.map(s => [
    s.id, { 'Bench press': [{ weight: 70, reps: 6, rpe: 9 }, { weight: 70, reps: 6, rpe: 9 }] },
  ]));
  const history = collectExerciseHistory(logs, sessions, []);

  const withPrescription = summariseExercises(history, {
    prescriptions: new Map([['bench press', { repRange: '5-6', workingSets: 2 }]]),
  })[0];
  assert.equal(withPrescription.inferred, false, 'a known rep range means the engine decides');
  assert.ok(withPrescription.coaching, 'the engine supplies coaching copy');
  assert.ok(withPrescription.target?.weight, 'and a load to go to next');

  const without = summariseExercises(history, {})[0];
  assert.equal(without.inferred, true, 'no rep range means the reading is observed, not decided');
  assert.equal(without.coaching, null, 'an observation must not borrow the engine wording');
  assert.equal(without.target, null);
  assert.equal(without.status, 'stalled', 'flat loads at RPE 9 for three sessions is a stall');
  assert.equal(without.changeKg, 0);
});

test('an unprescribed lift that is clearly rising is not reported as holding', () => {
  // The bug this guards: assuming an 8-12 rep range made every 5-rep lift read
  // as "hold" even while the load climbed every week.
  const logs = {
    s1: { 'Back squat': [{ weight: 85, reps: 5, rpe: 8 }] },
    s2: { 'Back squat': [{ weight: 90, reps: 5, rpe: 8 }] },
    s3: { 'Back squat': [{ weight: 95, reps: 5, rpe: 8 }] },
    s4: { 'Back squat': [{ weight: 100, reps: 5, rpe: 8 }] },
  };
  const row = summariseExercises(collectExerciseHistory(logs, sessions, []), {})[0];
  assert.equal(row.status, 'progress_load');
  assert.equal(row.inferred, true);
  assert.ok(row.changeKg > 15);
});

test('an observed stall needs three flat sessions at a genuinely hard effort', () => {
  // Flat, but easy: nothing to act on, so it must not be called a stall.
  const easy = {
    s1: { Row: [{ weight: 60, reps: 10, rpe: 6 }] },
    s2: { Row: [{ weight: 60, reps: 10, rpe: 6 }] },
    s3: { Row: [{ weight: 60, reps: 10, rpe: 6 }] },
  };
  assert.equal(summariseExercises(collectExerciseHistory(easy, sessions, []), {})[0].status, 'hold');

  // Two sessions is not yet a pattern.
  const short = {
    s1: { Row: [{ weight: 60, reps: 10, rpe: 9 }] },
    s2: { Row: [{ weight: 60, reps: 10, rpe: 9 }] },
  };
  assert.equal(summariseExercises(collectExerciseHistory(short, sessions, []), {})[0].status, 'hold');
});

test('a malformed log does not take the whole tab down', () => {
  const logs = { s1: { 'Odd lift': [{ weight: 'heavy', reps: 'lots' }] } };
  const history = collectExerciseHistory(logs, sessions, []);
  // Nothing numeric, so nothing to summarise, and no throw.
  assert.doesNotThrow(() => summariseExercises(history, {}));
});

test('weekly tonnage puts strength on the same axis as run volume', () => {
  const logs = {
    s1: { 'Back squat': [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }] },  // 1000kg
    s2: { 'Back squat': [{ weight: 100, reps: 5 }] },                            // 500kg
  };
  const weeks = weeklyStrengthVolume(collectExerciseHistory(logs, sessions, []), mondayOf);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].volume, 1000);
  assert.equal(weeks[0].sets, 2);
  assert.equal(weeks[1].volume, 500);
  assert.deepEqual(weeks.map(w => w.week), ['2026-07-06', '2026-07-13']);
});
