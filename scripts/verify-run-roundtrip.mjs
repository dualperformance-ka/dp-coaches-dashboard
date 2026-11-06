#!/usr/bin/env node
// End-to-end check of the structured run path against a real Postgres:
//
//   coach builder input → saveRunSteps()/setPublishState() (server/programming.js)
//   → replace_run_steps() in the database → the portal's own read query
//   → the portal's own converter (tests/fixtures/portal-garmin-workouts.js)
//
// Needs a scratch database with the programming fixture and migrations
// applied (see docs/garmin-run-builder.md, "Checks"). NEVER point it at
// production: it creates and deletes sessions for athlete code RTEST.
//
//   PSQL="psql -h localhost -U postgres -d dp_migration_test" node scripts/verify-run-roundtrip.mjs
//
// The database is reached through psql, so the script adds no dependency.
// A tiny PostgREST stand-in translates the handful of request shapes the
// server code makes; anything else throws so a new call cannot slip past.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import '../public/run-workout.js';
import { copyPrescription, readPrescription, saveRunSession, saveRunSteps, setPublishState } from '../server/programming.js';
import { buildRunningWorkout } from '../tests/fixtures/portal-garmin-workouts.js';

const R = globalThis.DPRunWorkout;
const PSQL = (process.env.PSQL || 'psql -h /tmp -p 5544 -U postgres -d dp_rt').split(/\s+/);
const FIXTURE = JSON.parse(readFileSync(new URL('../tests/fixtures/garmin-acceptance-fixture.json', import.meta.url), 'utf8'));
const ATHLETE = 'RTEST';
const OTHER = 'RTEST2';

function sql(query) {
  const out = execFileSync(PSQL[0], [...PSQL.slice(1), '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim();
}
const lit = (value) => value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`;
const json = (value) => `$j$${JSON.stringify(value)}$j$::jsonb`;
const rows = (query) => JSON.parse(sql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t`) || '[]');

// ── PostgREST stand-in ───────────────────────────────────────────────────────
function where(params) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit'].includes(key)) continue;
    if (key === 'or') {
      const parts = raw.replace(/^\(|\)$/g, '').split(',').map((p) => {
        const [col, op, ...rest] = p.split('.');
        assert.equal(op, 'eq'); return `${col}::text = ${lit(rest.join('.'))}`;
      });
      clauses.push(`(${parts.join(' or ')})`); continue;
    }
    const [op, ...rest] = raw.split('.'); const value = rest.join('.');
    if (op === 'eq') clauses.push(`${key}::text = ${lit(value)}`);
    else if (op === 'is' && value === 'null') clauses.push(`${key} is null`);
    else if (op === 'in') clauses.push(`${key}::text in (${value.replace(/^\(|\)$/g, '').split(',').map(lit).join(',')})`);
    else throw new Error(`unsupported filter ${key}=${raw}`);
  }
  return clauses.length ? ` where ${clauses.join(' and ')}` : '';
}

const calls = [];
let failNextRpc = false;
async function sb(path, options = {}) {
  const method = options.method || 'GET';
  calls.push(`${method} ${path.split('?')[0]}`);
  const [table, qs = ''] = path.split('?');
  const params = [...new URLSearchParams(qs)];
  const get = (k) => (params.find(([key]) => key === k) || [])[1];

  if (table === 'rpc/save_run_session') {
    const b = options.body;
    let steps = b.p_steps;
    // Simulates the database failing part-way: the last row breaks a CHECK
    // constraint after earlier writes in the same call already ran.
    if (failNextRpc) { failNextRpc = false; steps = steps.map((s, i) => i === steps.length - 1 ? { ...s, step_type: 'bogus' } : s); }
    try {
      return JSON.parse(sql(`select public.save_run_session(${lit(b.p_session_id)}::uuid, ${lit(b.p_athlete_code)}, ${json(b.p_fields)}, ${json(steps)})`));
    } catch (error) {
      const message = (String(error.stderr || error.message).match(/ERROR:\s+(.*)/) || [])[1] || 'database error';
      throw Object.assign(new Error(message), { status: 400 });
    }
  }
  if (table === 'rpc/replace_run_steps') {
    let steps = options.body.p_steps;
    // Simulates the database failing part-way through the call: the last row
    // breaks a CHECK constraint after the delete and earlier inserts ran.
    if (failNextRpc) { failNextRpc = false; steps = steps.map((s, i) => i === steps.length - 1 ? { ...s, step_type: 'bogus' } : s); }
    try {
      return JSON.parse(sql(`select public.replace_run_steps(${lit(options.body.p_session_id)}::uuid, ${json(steps)}, ${lit(options.body.p_publish_state)})`));
    } catch (error) {
      // PostgREST returns the error's message only (no CONTEXT lines).
      const message = (String(error.stderr || error.message).match(/ERROR:\s+(.*)/) || [])[1] || 'database error';
      throw Object.assign(new Error(message), { status: 400 });
    }
  }
  if (method === 'GET') {
    const select = (get('select') || '*').split(',').join(', ');
    const order = get('order') ? ` order by ${get('order').replace('.asc', ' asc').replace('.desc', ' desc')}` : '';
    const limit = get('limit') ? ` limit ${Number(get('limit'))}` : '';
    if (table === 'workout_splits' || table === 'garmin_workout_deliveries') return [];
    return rows(`select ${select} from public.${table}${where(params)}${order}${limit}`);
  }
  if (method === 'PATCH') {
    const sets = Object.entries(options.body).map(([k, v]) => `${k} = ${lit(v)}`).join(', ');
    sql(`update public.${table} set ${sets}${where(params)}`); return [];
  }
  if (method === 'POST' && table === 'programme_change_log') return null;
  throw new Error(`unexpected ${method} ${path}`);
}

// ── Setup ────────────────────────────────────────────────────────────────────
sql(`create table if not exists public.athlete_data (athlete_code text, key text, value jsonb, primary key (athlete_code, key))`);
sql(`delete from public.planned_sessions where athlete_code in (${lit(ATHLETE)}, ${lit(OTHER)})`);
sql(`delete from public.athlete_data where athlete_code = ${lit(ATHLETE)}`);
const NOTION = 'abcdef0123456789abcdef0123456789';
const LEGACY = { warm_up: '2km easy', intervals: '6x1km @ 4:30-4:45', rest: '90s jog', cool_down: '2km easy' };
const sessionId = sql(`insert into public.planned_sessions (athlete_code, title, session_type, planned_date, status, publish_state, prescription_mode, notion_page_id, warm_up, intervals, rest, cool_down)
  values (${lit(ATHLETE)}, ${lit(FIXTURE.session.title)}, ${lit(FIXTURE.session.session_type)}, '2026-11-12', 'Planned', 'draft', 'legacy', ${lit(NOTION)},
  ${lit(LEGACY.warm_up)}, ${lit(LEGACY.intervals)}, ${lit(LEGACY.rest)}, ${lit(LEGACY.cool_down)}) returning id`).split('\n')[0];
const otherId = sql(`insert into public.planned_sessions (athlete_code, title, session_type, planned_date, status, publish_state, prescription_mode)
  values (${lit(OTHER)}, 'Other athlete', 'Tempo', '2026-11-12', 'Planned', 'published', 'legacy') returning id`).split('\n')[0];

const ADMIN = { id: '00000000-0000-4000-8000-0000000000a1', handle: 'KARL', role: 'admin' };
const SCOPED = { id: '00000000-0000-4000-8000-0000000000c2', handle: 'COACH2', role: 'coach' };
sql(`insert into public.athletes (code, name) values (${lit(ATHLETE)}, 'Round trip test'), (${lit(OTHER)}, 'Round trip other') on conflict do nothing`);
sql(`insert into public.coaches (id, handle, name, role, enabled) values (${lit(SCOPED.id)}, 'COACH2', 'Coach Two', 'coach', true) on conflict do nothing`);
sql(`insert into public.coach_athletes (coach_id, athlete_code) values (${lit(SCOPED.id)}, ${lit(OTHER)}) on conflict do nothing`);

// The portal's loadWorkoutPrescription(), same filters and columns.
function portalLoad(key) {
  const session = rows(`select id, notion_page_id, title, session_type, planned_date, prescription_mode from public.planned_sessions
    where athlete_code = ${lit(ATHLETE)} and publish_state = 'published' and (id::text = ${lit(key)} or notion_page_id = ${lit(key)}) limit 1`)[0];
  if (!session) return null;
  const steps = rows(`select id, parent_step_id, step_order, step_type, repeat_count, distance_km, duration_sec, intensity_type, pace_min, pace_max, hr_zone, rpe, effort, instructions
    from public.run_steps where planned_session_id = ${lit(session.id)} order by step_order asc limit 101`);
  return { session, steps, workout: buildRunningWorkout(session, steps) };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', name, error.message.split('\n').slice(0, 6).join('\n')]); }
}

// ── Checks ───────────────────────────────────────────────────────────────────
await check('draft save: athlete cannot see it; card text now written from the steps', async () => {
  const out = await saveRunSteps({ session_id: sessionId, steps: FIXTURE.builderSteps }, sb, ADMIN);
  assert.equal(out.publish_state, 'draft');
  assert.equal(portalLoad(sessionId), null, 'a draft must not reach the portal');
  const row = rows(`select prescription_mode, warm_up, intervals, rest, cool_down from public.planned_sessions where id = ${lit(sessionId)}`)[0];
  assert.equal(row.prescription_mode, 'structured');
  // Whichever window saves the steps, the athlete card is written from them,
  // so the portal card and Garmin always describe the same workout.
  assert.deepEqual({ warm_up: row.warm_up, intervals: row.intervals, rest: row.rest, cool_down: row.cool_down },
    { warm_up: '10 min', intervals: '6 × 1 km', rest: '1 min 30 s', cool_down: '10 min' });
});

await check('publish → portal converter output equals the acceptance fixture exactly', async () => {
  await setPublishState({ session_ids: [sessionId], publish_state: 'published' }, sb, ADMIN);
  const loaded = portalLoad(sessionId);
  assert.ok(loaded, 'published session is visible to the portal');
  assert.deepEqual(loaded.workout, FIXTURE.expectedGarminWorkout);
});

await check('the portal finds the same workout by notion_page_id; run_steps hang off the canonical id', async () => {
  const byNotion = portalLoad(NOTION);
  assert.equal(byNotion.session.id, sessionId);
  assert.deepEqual(byNotion.workout, FIXTURE.expectedGarminWorkout);
  assert.ok(byNotion.steps.length === 5);
});

await check('save and reload: the coach builder reads back the same steps', async () => {
  const data = await readPrescription(sessionId, sb);
  const reloaded = data.runSteps.map(R.fromRow);
  const report = R.validate(data.session, reloaded);
  assert.equal(report.garminReady, true);
  assert.equal(report.expandedSteps, FIXTURE.expectedCounts.expandedGarminSteps);
  assert.ok(data.legacyRun.some((r) => r.value === '6 × 1 km'), 'the card text shown beside the builder is the text written from the steps');
  // Save what was reloaded, unchanged: the portal output must not move.
  await saveRunSteps({ session_id: sessionId, steps: reloaded }, sb, ADMIN);
  assert.deepEqual(portalLoad(sessionId).workout, FIXTURE.expectedGarminWorkout);
});

await check('failed save (database error part-way): the last published workout is intact', async () => {
  const before = portalLoad(sessionId);
  const edited = FIXTURE.builderSteps.map((s) => s.id === 'new-r' ? { ...s, repeat_count: 8 } : s);
  failNextRpc = true;
  await assert.rejects(saveRunSteps({ session_id: sessionId, steps: edited }, sb, ADMIN), /run_steps_step_type_check|bogus|violates/);
  const after = portalLoad(sessionId);
  assert.deepEqual(after.workout, before.workout);
  assert.deepEqual(after.steps, before.steps, 'same rows, same ids');
});

await check('failed save (invalid input): refused before the database, nothing changes', async () => {
  const before = portalLoad(sessionId);
  const bad = FIXTURE.builderSteps.map((s) => s.id === 'new-i' ? { ...s, pace_fast: 'fast' } : s);
  const n = calls.length;
  await assert.rejects(saveRunSteps({ session_id: sessionId, steps: bad }, sb, ADMIN), (e) => e.status === 422 && /isn’t minutes:seconds/.test(e.message));
  assert.ok(!calls.slice(n).some((c) => c.includes('rpc/')), 'no database write attempted');
  assert.deepEqual(portalLoad(sessionId).steps, before.steps);
});

await check('edit a published run: 5 × 1 km @ 4:20–4:35 is live for the next send', async () => {
  const edited = FIXTURE.builderSteps.map((s) => s.id === 'new-r' ? { ...s, repeat_count: 5 }
    : s.id === 'new-i' ? { ...s, pace_fast: '4:20', pace_slow: '4:35' } : s);
  await saveRunSteps({ session_id: sessionId, steps: edited }, sb, ADMIN);
  const w = portalLoad(sessionId).workout.segments[0].steps;
  assert.equal(w[1].repeatValue, 5);
  assert.equal(w[1].steps[0].targetValueLow, 1000 / 275);
  assert.equal(w[1].steps[0].targetValueHigh, 1000 / 260);
  assert.equal(rows(`select publish_state from public.planned_sessions where id = ${lit(sessionId)}`)[0].publish_state, 'published');
  await saveRunSteps({ session_id: sessionId, steps: FIXTURE.builderSteps }, sb, ADMIN); // restore
});

await check('continuous run, HR target and lap-button step through the database', async () => {
  await saveRunSteps({ session_id: sessionId, steps: [
    { id: 'a', step_type: 'run', step_order: 0, end: 'distance', distance_km: 1.609, target: 'hr', hr_zone: '2', instructions: 'Steady', coach_notes: 'PRIVATE' },
    { id: 'b', step_type: 'run', step_order: 1, end: 'lap', target: 'effort', effort: 'Strides' },
  ] }, sb, ADMIN);
  const [run, open] = portalLoad(sessionId).workout.segments[0].steps;
  assert.deepEqual([run.durationType, run.durationValue, run.targetType, run.targetValue, run.description], ['DISTANCE', 1609, 'HEART_RATE', 2, 'Steady']);
  assert.deepEqual([open.durationType, open.durationValue, open.targetType, open.description], ['OPEN', null, 'OPEN', 'Strides']);
  assert.ok(!JSON.stringify(portalLoad(sessionId)).includes('PRIVATE'), 'coach note is not in what the portal reads');
  assert.equal(rows(`select coach_notes from public.run_steps where planned_session_id = ${lit(sessionId)} and coach_notes is not null`)[0].coach_notes, 'PRIVATE');
  await saveRunSteps({ session_id: sessionId, steps: FIXTURE.builderSteps }, sb, ADMIN);
});

await check('move to draft hides it from the portal; republish brings back the same workout', async () => {
  await setPublishState({ session_ids: [sessionId], publish_state: 'draft' }, sb, ADMIN);
  assert.equal(portalLoad(sessionId), null);
  assert.equal(portalLoad(NOTION), null);
  await setPublishState({ session_ids: [sessionId], publish_state: 'published' }, sb, ADMIN);
  assert.deepEqual(portalLoad(sessionId).workout, FIXTURE.expectedGarminWorkout);
});

await check('forged requests: a scoped coach cannot read-modify another athlete’s run or publish it', async () => {
  const before = portalLoad(sessionId);
  await assert.rejects(saveRunSteps({ session_id: sessionId, steps: FIXTURE.builderSteps.slice(0, 1) }, sb, SCOPED), { status: 403 });
  await assert.rejects(setPublishState({ session_ids: [otherId, sessionId], publish_state: 'draft' }, sb, SCOPED), { status: 403 });
  // Body fields cannot redirect a save: planned_session_id/parent ids in steps are ignored.
  const forged = FIXTURE.builderSteps.map((s) => ({ ...s, planned_session_id: otherId }));
  await saveRunSteps({ session_id: sessionId, steps: forged }, sb, ADMIN);
  assert.equal(rows(`select count(*)::int n from public.run_steps where planned_session_id = ${lit(otherId)}`)[0].n, 0);
  assert.deepEqual(portalLoad(sessionId).workout, before.workout);
  assert.equal(rows(`select publish_state from public.planned_sessions where id = ${lit(otherId)}`)[0].publish_state, 'published');
});

await check('a completed session cannot be overwritten', async () => {
  sql(`update public.planned_sessions set status = 'Completed' where id = ${lit(sessionId)}`);
  await assert.rejects(saveRunSteps({ session_id: sessionId, steps: FIXTURE.builderSteps.slice(0, 1) }, sb, ADMIN), { status: 409 });
  sql(`update public.planned_sessions set status = 'Planned', locked_at = null where id = ${lit(sessionId)}`);
  assert.deepEqual(portalLoad(sessionId).workout, FIXTURE.expectedGarminWorkout);
});

await check('duplicating a nested repeat copies every level atomically and converts identically', async () => {
  const nested = [
    { id: 'o', step_type: 'repeat', step_order: 0, repeat_count: 3 },
    { id: 'i', parent_step_id: 'o', step_type: 'repeat', step_order: 0, repeat_count: 4 },
    { id: 'x', parent_step_id: 'i', step_type: 'interval', step_order: 0, end: 'distance', distance_km: 0.2, target: 'pace', pace_fast: '3:30', pace_slow: '3:40' },
    { id: 'y', parent_step_id: 'i', step_type: 'recovery', step_order: 1, end: 'time', durationText: '60s', target: 'none' },
    { id: 'z', parent_step_id: 'o', step_type: 'rest', step_order: 1, end: 'time', durationText: '3:00', target: 'none' },
  ];
  await saveRunSteps({ session_id: sessionId, steps: nested }, sb, ADMIN);
  const copyId = sql(`insert into public.planned_sessions (athlete_code, title, session_type, planned_date, status, publish_state, prescription_mode)
    values (${lit(ATHLETE)}, 'Copy', 'Speed', '2026-11-19', 'Planned', 'published', 'legacy') returning id`).split('\n')[0];
  const out = await copyPrescription(sessionId, copyId, sb);
  assert.equal(out.copiedSteps, 5);
  const original = portalLoad(sessionId).workout.segments;
  const copy = portalLoad(copyId);
  assert.deepEqual(copy.workout.segments, original);
  assert.equal(copy.session.prescription_mode, 'structured');
  const ids = new Set(rows(`select id from public.run_steps where planned_session_id = ${lit(sessionId)}`).map((r) => r.id));
  assert.ok(copy.steps.every((r) => !ids.has(r.id)), 'copy has its own ids');
  await saveRunSteps({ session_id: sessionId, steps: FIXTURE.builderSteps }, sb, ADMIN);
});

await check('Plan Session save: new session + steps in one call → card text from the steps → portal converter = fixture', async () => {
  const out = await saveRunSession({ athlete_code: ATHLETE, fields: { title: FIXTURE.session.title, session_type: 'Speed', planned_date: '2026-11-20', week_label: 'Week 6' }, steps: FIXTURE.builderSteps }, sb, ADMIN);
  const id = out.row.id;
  const row = rows(`select warm_up, intervals, working_pace, rest, cool_down, target_pace, publish_state, prescription_mode from public.planned_sessions where id = ${lit(id)}`)[0];
  assert.deepEqual(row, { warm_up: '10 min', intervals: '6 × 1 km', working_pace: '4:30–4:45 /km', rest: '1 min 30 s', cool_down: '10 min', target_pace: '4:30–4:45 /km', publish_state: 'published', prescription_mode: 'structured' });
  assert.deepEqual(portalLoad(id).workout, FIXTURE.expectedGarminWorkout);
  // A failing step save leaves the session row exactly as it was.
  const before = rows(`select title, planned_date, intervals from public.planned_sessions where id = ${lit(id)}`)[0];
  failNextRpc = false;
  await assert.rejects(saveRunSession({ id, fields: { title: 'Changed', planned_date: '2026-11-22' }, steps: [{ id: 'x', step_type: 'repeat', step_order: 0, repeat_count: 2 }] }, sb, ADMIN), { status: 422 });
  assert.deepEqual(rows(`select title, planned_date, intervals from public.planned_sessions where id = ${lit(id)}`)[0], before);
});

// ── Report ───────────────────────────────────────────────────────────────────
sql(`delete from public.planned_sessions where athlete_code in (${lit(ATHLETE)}, ${lit(OTHER)})`);
for (const [status, name, detail] of results) console.log(`${status}  ${name}${detail ? `\n      ${detail}` : ''}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nALL ${results.length} ROUND-TRIP CHECKS PASSED`);
process.exit(failed ? 1 : 0);
