import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { applyAthleteReschedules } from '../api/coach-data.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../api/coach-data.js', import.meta.url), 'utf8');

test('athlete reschedules become the effective planning date and retain the coach date', () => {
  const original = [{
    id: 'database-id',
    notion_page_id: 'session-one',
    athlete_code: 'ALVIN',
    planned_date: '2026-10-05',
    title: 'Easy Run',
  }];

  const result = applyAthleteReschedules(original, [{
    athlete_code: 'ALVIN',
    key: 'reschedules',
    value: JSON.stringify({ 'session-one': '2026-10-08' }),
  }]);

  assert.equal(result[0].planned_date, '2026-10-08');
  assert.equal(result[0].coach_planned_date, '2026-10-05');
  assert.equal(result[0].athlete_rescheduled, true);
  assert.equal(original[0].planned_date, '2026-10-05', 'source rows are not mutated');
});

test('reschedules are athlete-scoped and malformed dates are ignored', () => {
  const rows = [
    { id: 'same-id', athlete_code: 'ALVIN', planned_date: '2026-10-05' },
    { id: 'same-id', athlete_code: 'BETTY', planned_date: '2026-10-06' },
  ];
  const settings = [
    { athlete_code: 'ALVIN', key: 'reschedules', value: { 'same-id': 'not-a-date' } },
    { athlete_code: 'BETTY', key: 'reschedules', value: { 'same-id': '2026-10-09' } },
  ];

  const result = applyAthleteReschedules(rows, settings);
  assert.equal(result[0].planned_date, '2026-10-05');
  assert.equal(result[0].athlete_rescheduled, undefined);
  assert.equal(result[1].planned_date, '2026-10-09');
});

test('dashboard requests and renders the portal booking and reschedule contracts', () => {
  assert.match(server, /reschedules/);
  assert.match(server, /key\.like\.call_booked_\*/);
  assert.match(html, /function useCallBookingRows\(/);
  assert.match(html, /function callBookingHtml\(/);
  assert.equal((html.match(/\$\{callBookingHtml\(a\.id\)\}/g) || []).length, 2);
  assert.doesNotMatch(html, /callBookingHtml[\s\S]{0,1200}(eventId|calendarId)/);
});
