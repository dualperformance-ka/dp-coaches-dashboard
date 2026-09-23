import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bodyPainFields,
  buildTriageQueue,
  mapBody,
  parsePainScore,
  selectTriageBodyRows,
} from '../api/coach-data.js';

// The portal has always sent pain/painLocation/coachAlert inside the body log's
// raw_payload. The typed columns the Today queue read were never populated (and
// were never created live), so a 7/10 report was saved and never triaged.
// These tests pin both paths: typed columns when they exist, raw_payload when
// they do not.

const NOW = new Date('2026-09-23T00:30:00.000Z'); // Wednesday 10:00 Adelaide
const athletes = [
  { code: 'KNEE', name: 'Knee', active: true, archived_at: null },
  { code: 'CALM', name: 'Calm', active: true, archived_at: null },
];
const calmBody = { athlete_code: 'CALM', log_date: '2026-09-23', raw_payload: { pain: '0', coachAlert: false } };

test('a raw_payload-only 7/10 left-knee report reaches Today once, at the top', () => {
  const result = buildTriageQueue({
    now: NOW,
    athletes,
    bodyRows: [
      { athlete_code: 'KNEE', log_date: '2026-09-23', raw_payload: { pain: '7', painLocation: 'left knee', coachAlert: true, noteText: 'sharp on stairs' } },
      // An earlier, lower report for the same athlete must not add a second row.
      { athlete_code: 'KNEE', log_date: '2026-09-21', raw_payload: { pain: '5', painLocation: 'left knee', coachAlert: true } },
      calmBody,
    ],
    trainingRows: [{ athlete_code: 'CALM', session_date: '2026-09-22', session_name: 'Easy Run' }],
  });
  const rows = result.queue.filter(row => row.athleteCode === 'KNEE');
  assert.equal(rows.length, 1);
  assert.equal(result.queue[0].athleteCode, 'KNEE');
  assert.equal(rows[0].flag, 'pain');
  assert.equal(rows[0].severity, 'critical');
  assert.deepEqual(rows[0].evidence.pain, { date: '2026-09-23', score: 7, coachAlert: true, location: 'left knee' });
  assert.match(rows[0].signal, /Coach alert with pain 7\/10 \(left knee\) reported today/);
  assert.equal(result.queue.some(row => row.athleteCode === 'CALM'), false);
});

test('typed columns win over raw_payload, and a typed false alert stands', () => {
  const typed = { athlete_code: 'KNEE', log_date: '2026-09-23', pain: 3, pain_location: 'calf', coach_alert: false,
    raw_payload: { pain: '9', painLocation: 'hip', coachAlert: true } };
  assert.deepEqual(bodyPainFields(typed), { pain: 3, painLocation: 'calf', coachAlert: false, noteText: null });
  const result = buildTriageQueue({ now: NOW, athletes, bodyRows: [typed, calmBody],
    trainingRows: [{ athlete_code: 'CALM', session_date: '2026-09-22', session_name: 'Run' }] });
  assert.equal(result.queue.some(row => row.flag === 'pain'), false);
});

test('without an explicit alert, a raw_payload score of 5+ still raises one; zero does not', () => {
  assert.equal(bodyPainFields({ raw_payload: { pain: 6 } }).coachAlert, true);
  assert.equal(bodyPainFields({ raw_payload: { pain: '4' } }).coachAlert, false);
  assert.deepEqual(bodyPainFields({ raw_payload: { pain: '0', painLocation: '' } }),
    { pain: 0, painLocation: null, coachAlert: false, noteText: null });
  // Not reported is null, never zero.
  assert.equal(bodyPainFields({ raw_payload: { weight: 80 } }).pain, null);
  assert.equal(bodyPainFields({}).pain, null);
});

test('malformed pain values never raise or fake an alert', () => {
  for (const value of ['7/10', '', 'abc', '11', -1, 6.5, {}, [], true, null]) {
    assert.equal(parsePainScore(value), null, JSON.stringify(value));
  }
  assert.equal(bodyPainFields({ raw_payload: { pain: '7/10' } }).coachAlert, false);
  assert.equal(bodyPainFields({ raw_payload: 'not-an-object' }).pain, null);
});

test('mapBody exposes structured pain and the athlete note, never raw_payload', () => {
  const mapped = mapBody({
    athlete_code: 'KNEE', log_date: '2026-09-23', weight: 80, notes: 'Pain 7/10 · left knee · sharp on stairs',
    raw_payload: { pain: '7', painLocation: 'left knee', coachAlert: true, noteText: 'sharp on stairs', secret: 'x' },
  });
  assert.equal(mapped.Pain, 7);
  assert.equal(mapped['Pain Location'], 'left knee');
  assert.equal(mapped['Coach Alert'], true);
  assert.equal(mapped['Athlete Note'], 'sharp on stairs');
  assert.equal('raw_payload' in mapped, false);
  assert.equal(JSON.stringify(mapped).includes('secret'), false);
});

test('triage body read degrades column by column and keeps raw_payload', async () => {
  const seen = [];
  const select = async (table, params) => {
    seen.push(params.select);
    if (params.select.includes('pain_location')) throw new Error("Could not find the 'pain_location' column of 'daily_body_logs' in the schema cache");
    if (params.select.includes('pain')) throw new Error('column daily_body_logs.pain does not exist');
    return [{ athlete_code: 'KNEE', log_date: '2026-09-23', raw_payload: { pain: '7' } }];
  };
  const rows = await selectTriageBodyRows('2026-09-17', select);
  assert.equal(rows.length, 1);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(projection => projection.includes('raw_payload')));
  await assert.rejects(selectTriageBodyRows('2026-09-17', async () => { throw new Error('permission denied'); }), /permission denied/);
});
