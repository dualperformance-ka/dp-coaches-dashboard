import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanPlannedSessionFields,
  cleanNutritionPlanFields,
  cleanLibraryFields,
  archiveLibraryRecord,
  acknowledgeAlert,
  buildAlertAcknowledgement,
  deleteAthleteSetting,
  deleteNutritionPlan,
  deletePlannedSession,
  insertPlannedSessions,
  isIsoCalendarDate,
  programmeRestartDates,
  programmeWeekForDate,
  relabelNutritionPlan,
  restartProgramme,
  restoreAlert,
  shiftIsoDate,
  saveLibraryRecord,
  upsertAthleteSetting,
  upsertNutritionPlan,
  upsertApplicationDecision,
  updatePlannedSession,
} from '../api/athletes.js';

test('restarts Week 1 on the chosen Monday using the prior Monday as its anchor', () => {
  assert.deepEqual(programmeRestartDates('2026-08-03', 1), {
    effectiveDate: '2026-08-03',
    startWeek: 1,
    anchorDate: '2026-07-27',
    weekEndDate: '2026-08-09',
  });
});

test('restarts Discovery Week on the chosen Monday without shifting the anchor', () => {
  assert.deepEqual(programmeRestartDates('2026-08-03', 0), {
    effectiveDate: '2026-08-03',
    startWeek: 0,
    anchorDate: '2026-08-03',
    weekEndDate: '2026-08-09',
  });
});

test('rejects non-Monday restart dates and unsupported week numbers', () => {
  assert.throws(
    () => programmeRestartDates('2026-08-04', 1),
    /must begin on a Monday/
  );
  assert.throws(
    () => programmeRestartDates('2026-08-03', 2),
    /Week 0 or Week 1/
  );
});

test('validates and shifts calendar dates without timezone drift', () => {
  assert.equal(isIsoCalendarDate('2028-02-29'), true);
  assert.equal(isIsoCalendarDate('2027-02-29'), false);
  assert.equal(isIsoCalendarDate('03-08-2026'), false);
  assert.equal(shiftIsoDate('2026-01-01', -7), '2025-12-25');
});

test('renumbers future planned session dates from the new block start', () => {
  assert.equal(programmeWeekForDate('2026-08-03', 1, '2026-08-03'), 1);
  assert.equal(programmeWeekForDate('2026-08-03', 1, '2026-08-09'), 1);
  assert.equal(programmeWeekForDate('2026-08-03', 1, '2026-08-10'), 2);
  assert.equal(programmeWeekForDate('2026-08-03', 0, '2026-08-17'), 2);
});

test('writes restart metadata and relabels scheduled sessions through the protected API flow', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('athlete_data?athlete_code=')) return [{ value: '2026-06-01' }];
    if (path.startsWith('athletes?code=')) return [{ start_date: '2026-05-25' }];
    if (path.includes('select=id,planned_date')) {
      return [
        { id: 'session-one', planned_date: '2026-08-03' },
        { id: 'session-two', planned_date: '2026-08-10' },
      ];
    }
    return [];
  };

  const result = await restartProgramme(' alex ', '2026-08-03', 1, request);

  assert.equal(result.athleteCode, 'ALEX');
  assert.equal(result.anchorDate, '2026-07-27');
  assert.equal(result.updatedSessions, 2);

  const settingsWrite = calls.find(call => call.path === 'athlete_data?on_conflict=athlete_code,key');
  assert.equal(settingsWrite.options.method, 'POST');
  assert.deepEqual(
    settingsWrite.options.body.map(row => [row.key, row.value]),
    [
      ['start_date_override', '2026-07-27'],
      ['programme_restart', result.restart],
    ]
  );

  const sessionWrites = calls.filter(call => call.path.startsWith('planned_sessions?id=in.'));
  assert.deepEqual(
    sessionWrites.map(call => call.options.body.week_label),
    ['Week 1', 'Week 2']
  );
});

test('proxies planned-session writes with an allowlisted payload', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === 'DELETE') return [{ id: 'session-one' }];
    return [{ id: 'session-one', ...(options.body || {}) }];
  };

  assert.deepEqual(
    cleanPlannedSessionFields({ title: 'Easy run', planned_date: '2026-08-03', forbidden: 'drop me' }),
    { title: 'Easy run', planned_date: '2026-08-03' }
  );

  await insertPlannedSessions({
    athlete_code: 'ALEX',
    planned_date: '2026-08-03',
    title: 'Week 1 run',
    forbidden: 'drop me',
  }, request);
  await updatePlannedSession('session-one', { title: 'Updated', id: 'cannot-change-id' }, request);
  await deletePlannedSession('session-one', request);

  assert.equal(calls[0].path, 'planned_sessions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body.forbidden, undefined);
  assert.match(calls[1].path, /^planned_sessions\?or=/);
  assert.deepEqual(calls[1].options.body, { title: 'Updated' });
  assert.equal(calls[2].options.method, 'DELETE');
});

test('proxies nutrition prescriptions without exposing browser table access', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    return [{ id: 'plan-one', ...(options.body || {}) }];
  };

  assert.deepEqual(
    cleanNutritionPlanFields({ athlete_code: 'ALVIN', week_label: 'Week 1', calories: '2400', forbidden: 'drop me' }),
    { athlete_code: 'ALVIN', week_label: 'Week 1', calories: '2400' }
  );

  await upsertNutritionPlan({
    athlete_code: ' alvin ', week_label: 'Week 1', calories: '2400', forbidden: 'drop me',
  }, request);
  await deleteNutritionPlan('alvin', 'Week 1', request);

  assert.equal(calls[0].path, 'nutrition_plans?on_conflict=athlete_code,week_label');
  assert.equal(calls[0].options.body.athlete_code, 'ALVIN');
  assert.equal(calls[0].options.body.forbidden, undefined);
  assert.match(calls[1].path, /athlete_code=eq\.ALVIN&week_label=eq\.Week%201/);
  assert.equal(calls[1].options.method, 'DELETE');
});

test('relabels a nutrition week in place and blocks duplicate programme weeks', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.includes('week_label=eq.Week%208') && path.includes('select=id')) return [];
    return [{ id: 'plan-one', athlete_code: 'ALVIN', week_label: options.body?.week_label }];
  };

  const result = await relabelNutritionPlan(' alvin ', 'Week 3', 'Week 8', request);
  assert.equal(result.rows[0].week_label, 'Week 8');
  assert.match(calls[0].path, /athlete_code=eq\.ALVIN&week_label=eq\.Week%208&select=id/);
  assert.match(calls[1].path, /athlete_code=eq\.ALVIN&week_label=eq\.Week%203/);
  assert.equal(calls[1].options.method, 'PATCH');
  assert.equal(calls[1].options.body.week_label, 'Week 8');

  await assert.rejects(
    relabelNutritionPlan('ALVIN', 'Week 3', 'Week 8', async () => [{ id: 'already-there' }]),
    /already has nutrition targets for Week 8/
  );
});

test('proxies only allowlisted programme settings', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    return [{ ...(options.body || {}) }];
  };

  await upsertAthleteSetting('alvin', 'programme_weeks', 16, request);
  await upsertAthleteSetting('alvin', 'call_notes', 'Follow up Tuesday', request);
  await assert.rejects(
    upsertAthleteSetting('alvin', 'ack_alert', { sig: '1' }, request),
    /Unsupported athlete setting/
  );
  await deleteAthleteSetting('alvin', 'start_date_override', request);
  await assert.rejects(
    upsertAthleteSetting('alvin', 'strava_tokens', 'blocked', request),
    /Unsupported athlete setting/
  );

  assert.equal(calls[0].path, 'athlete_data?on_conflict=athlete_code,key');
  assert.equal(calls[0].options.body.value, 16);
  assert.equal(calls[1].options.body.key, 'call_notes');
  assert.match(calls[2].path, /key=eq\.start_date_override/);
  assert.equal(calls.length, 3);
});

test('alert acknowledgements are stamped by the authenticated coach and shared in Supabase', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    return [{ ...(options.body || {}) }];
  };
  const now = new Date('2026-08-10T06:45:00.000Z');

  assert.deepEqual(buildAlertAcknowledgement('-123', 'Karl', now), {
    sig: '-123',
    at: '2026-08-10T06:45:00.000Z',
    by: 'KARL',
  });

  const saved = await acknowledgeAlert(' alvin ', '-123', 'Karl', request, now);
  assert.equal(saved.acknowledgement.by, 'KARL');
  assert.equal(calls[0].path, 'athlete_data?on_conflict=athlete_code,key');
  assert.equal(calls[0].options.body.athlete_code, 'ALVIN');
  assert.deepEqual(JSON.parse(calls[0].options.body.value), saved.acknowledgement);

  await restoreAlert('alvin', request);
  assert.match(calls[1].path, /athlete_code=eq\.ALVIN&key=eq\.ack_alert/);
  assert.equal(calls[1].options.method, 'DELETE');
});

test('proxies programming-library records with table-specific allowlists', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    return [{ id: 'record-one', ...(options.body || {}) }];
  };

  assert.deepEqual(
    cleanLibraryFields('session', { name: 'Tempo', target_pace: '4:30', exercises: ['blocked'] }),
    { name: 'Tempo', target_pace: '4:30' }
  );
  await saveLibraryRecord('split', null, {
    name: 'Lower A', athlete_code: ' alvin ', exercises: [{ exercise: 'Squat' }], forbidden: true,
  }, request);
  await archiveLibraryRecord('session', 'record-one', request);

  assert.equal(calls[0].path, 'workout_splits');
  assert.equal(calls[0].options.body.athlete_code, 'ALVIN');
  assert.equal(calls[0].options.body.forbidden, undefined);
  assert.equal(calls[1].path, 'session_library?id=eq.record-one');
  assert.equal(calls[1].options.body.archived, true);
});

test('proxies application decisions through the coach API', async () => {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    return [{ ...(options.body || {}) }];
  };

  await upsertApplicationDecision({
    notion_id: 'notion-one', decision: 'accepted', decided_by: 'karl', decided_at: '2026-08-02T12:00:00Z',
  }, request);
  await assert.rejects(
    upsertApplicationDecision({ notion_id: 'notion-two', decision: 'maybe' }, request),
    /invalid/
  );

  assert.equal(calls[0].path, 'application_decisions?on_conflict=notion_id');
  assert.equal(calls[0].options.body.decided_by, 'KARL');
  assert.equal(calls.length, 1);
});
