// Plan Session window: a running session and its Garmin steps saved once.
//
// The coach builds steps in Plan Session; the athlete-card text columns are
// written FROM the steps, and session + steps go through save_run_session()
// in one transaction. Also pins the plan_* scope checks: a coach can only
// insert, update, copy or delete sessions for athletes they may touch, and an
// update cannot move a session to another athlete.

import assert from 'node:assert/strict';
import test from 'node:test';

import '../public/run-workout.js';
import { cleanRunSessionFields, saveRunSession } from '../server/programming.js';
import athletesHandler from '../api/athletes.js';

const ADMIN = { id: 'c1', handle: 'KARL', role: 'admin' };
const SCOPED = { id: 'c2', handle: 'ALEX', role: 'coach' };
const SID = '11111111-1111-4111-8111-111111111111';

const FIXTURE = [
  { id: 'new-w', step_type: 'warmup', step_order: 0, end: 'time', durationText: '10:00', target: 'none' },
  { id: 'new-r', step_type: 'repeat', step_order: 1, repeat_count: 6 },
  { id: 'new-i', parent_step_id: 'new-r', step_type: 'interval', step_order: 0, end: 'distance', distance_km: 1, target: 'pace', pace_fast: '4:30', pace_slow: '4:45' },
  { id: 'new-j', parent_step_id: 'new-r', step_type: 'recovery', step_order: 1, end: 'time', durationText: '90s', target: 'none' },
  { id: 'new-c', step_type: 'cooldown', step_order: 2, end: 'time', durationText: '10:00', target: 'none' },
];

function fakeSb({ session = null, allowed = null, rpcError = null } = {}) {
  const calls = [];
  const sb = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (path.startsWith('planned_sessions?id=eq.')) return session ? [session] : [];
    if (path.startsWith('coach_athletes')) return allowed ? allowed.map((code) => ({ athlete_code: code })) : [];
    if (path === 'rpc/save_run_session') {
      if (rpcError) throw rpcError;
      const b = options.body;
      return { id: b.p_session_id || SID, athlete_code: b.p_athlete_code, title: b.p_fields.title || 'Session', planned_date: b.p_fields.planned_date || '2026-11-12', ...b.p_fields };
    }
    if (path === 'programme_change_log') return null;
    throw new Error('unexpected ' + path);
  };
  sb.calls = calls;
  return sb;
}
const rpcCall = (sb) => sb.calls.find((c) => c.path === 'rpc/save_run_session');
const writes = (sb) => sb.calls.filter((c) => c.method !== 'GET' && c.path !== 'programme_change_log');
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

test('a new running session and its steps are one call, with the card text written from the steps', async () => {
  const sb = fakeSb();
  const out = await saveRunSession({
    athlete_code: ' karl ',
    fields: {
      title: '6 x 1 km', session_type: 'Speed', planned_date: '2026-11-12', week_label: 'Week 6',
      run_details: 'Strong but controlled', notes: 'Hydrate',
      // Text the request tries to supply is ignored: it comes from the steps.
      intervals: 'FORGED', warm_up: 'FORGED',
    },
    steps: FIXTURE,
  }, sb, ADMIN, { uuid });

  assert.deepEqual(writes(sb).map((c) => c.path), ['rpc/save_run_session']);
  const { p_session_id, p_athlete_code, p_fields, p_steps } = rpcCall(sb).body;
  assert.equal(p_session_id, null);
  assert.equal(p_athlete_code, 'KARL');
  assert.deepEqual(
    { warm_up: p_fields.warm_up, intervals: p_fields.intervals, working_pace: p_fields.working_pace, target_pace: p_fields.target_pace, rest: p_fields.rest, cool_down: p_fields.cool_down },
    { warm_up: '10 min', intervals: '6 × 1 km', working_pace: '4:30–4:45 /km', target_pace: '4:30–4:45 /km', rest: '1 min 30 s', cool_down: '10 min' });
  assert.equal(p_fields.run_details, 'Strong but controlled');
  assert.equal(p_fields.distance_km, undefined, 'timed steps: no invented total');
  assert.equal(p_steps.length, 5);
  assert.ok(p_steps.every((r) => /^00000000-/.test(r.id)), 'server-assigned step ids');
  assert.equal(out.validation.garminReady, true);
  assert.equal(out.card.intervals, '6 × 1 km');
});

test('fields are allowlisted: publish state, athlete, ids and locks cannot be set from the request', () => {
  const clean = cleanRunSessionFields({
    title: 'T', publish_state: 'published', athlete_code: 'OTHER', notion_page_id: 'x', locked_at: 'now',
    prescription_mode: 'legacy', distance_km: '12.5', library_id: 'not-a-uuid',
  });
  assert.deepEqual(Object.keys(clean).sort(), ['distance_km', 'library_id', 'title']);
  assert.equal(clean.distance_km, 12.5);
  assert.equal(clean.library_id, null);
  assert.throws(() => cleanRunSessionFields({ planned_date: '2026-02-30' }), /valid date/);
});

test('distance: the coach’s total is kept; an all-distance workout fills it when blank', async () => {
  const track = [
    { id: 'a', step_type: 'warmup', step_order: 0, end: 'distance', distance_km: 2, target: 'none' },
    { id: 'b', step_type: 'run', step_order: 1, end: 'distance', distance_km: 6, target: 'none' },
  ];
  let sb = fakeSb();
  await saveRunSession({ athlete_code: 'KARL', fields: { planned_date: '2026-11-12' }, steps: track }, sb, ADMIN, { uuid });
  assert.equal(rpcCall(sb).body.p_fields.distance_km, 8);
  sb = fakeSb();
  await saveRunSession({ athlete_code: 'KARL', fields: { planned_date: '2026-11-12', distance_km: 10 }, steps: track }, sb, ADMIN, { uuid });
  assert.equal(rpcCall(sb).body.p_fields.distance_km, 10);
});

test('edits go to the canonical session; completed sessions and other coaches’ athletes are refused before any write', async () => {
  const session = { id: SID, athlete_code: 'KARL', title: 'Old', session_type: 'Speed', status: 'Planned', locked_at: null, publish_state: 'published', prescription_mode: 'structured' };
  let sb = fakeSb({ session });
  await saveRunSession({ id: SID, athlete_code: 'SOMEONE', fields: { title: 'New' }, steps: FIXTURE }, sb, ADMIN, { uuid });
  assert.equal(rpcCall(sb).body.p_session_id, SID);
  assert.equal(rpcCall(sb).body.p_athlete_code, 'KARL', 'a body athlete code cannot redirect an edit');

  for (const locked of [{ status: 'Completed', locked_at: null }, { locked_at: '2026-11-01T00:00:00Z' }]) {
    sb = fakeSb({ session: { ...session, ...locked } });
    await assert.rejects(saveRunSession({ id: SID, fields: {}, steps: FIXTURE }, sb, ADMIN, { uuid }), { status: 409 });
    assert.equal(writes(sb).length, 0);
  }

  sb = fakeSb({ session, allowed: ['KHANG'] });
  await assert.rejects(saveRunSession({ id: SID, fields: {}, steps: FIXTURE }, sb, SCOPED, { uuid }), { status: 403 });
  sb = fakeSb({ allowed: ['KHANG'] });
  await assert.rejects(saveRunSession({ athlete_code: 'KARL', fields: { planned_date: '2026-11-12' }, steps: FIXTURE }, sb, SCOPED, { uuid }), { status: 403 });
  assert.equal(writes(sb).length, 0);
});

test('invalid steps are refused in plain language and nothing is written', async () => {
  const sb = fakeSb();
  const bad = FIXTURE.map((s) => s.id === 'new-i' ? { ...s, pace_fast: 'fast' } : s);
  await assert.rejects(saveRunSession({ athlete_code: 'KARL', fields: { planned_date: '2026-11-12' }, steps: bad }, sb, ADMIN, { uuid }),
    (e) => e.status === 422 && /Step 2\.1 \(Interval\): pace “fast”/.test(e.message));
  assert.equal(writes(sb).length, 0);
  await assert.rejects(saveRunSession({ athlete_code: 'KARL', fields: {}, steps: FIXTURE }, fakeSb(), ADMIN, { uuid }), /valid date/);
});

test('before the migration is applied the save fails closed with the fix', async () => {
  const sb = fakeSb({ rpcError: Object.assign(new Error('Could not find the function public.save_run_session(p_athlete_code, p_fields, p_session_id, p_steps) in the schema cache'), { upstreamCode: 'PGRST202' }) });
  await assert.rejects(saveRunSession({ athlete_code: 'KARL', fields: { planned_date: '2026-11-12' }, steps: FIXTURE }, sb, ADMIN, { uuid }),
    (e) => e.status === 409 && /20261106000001/.test(e.message) && /Nothing was changed/.test(e.message));
});

// ── /api/athletes plan_* scope ──────────────────────────────────────────────

function recorder() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return v; }, end() {} };
}

async function callAs(handle, body, rows) {
  const env = { ...process.env };
  Object.assign(process.env, { DASHBOARD_ACCESS_KEY: 'k', COACH_NAMES: 'Karl,Alex', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 's' });
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const u = decodeURIComponent(String(url));
    requests.push({ url: u, method: options.method || 'GET' });
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/coaches?')) return json([{ id: handle === 'ALEX' ? 'c2' : 'c1', handle, name: handle, role: handle === 'ALEX' ? 'coach' : 'admin', enabled: true }]);
    if (u.includes('/coach_athletes?')) return json(handle === 'ALEX' ? [{ athlete_code: 'KHANG' }] : []);
    if (u.includes('/planned_sessions?') && u.includes('select=athlete_code')) {
      const owner = rows.find((r) => u.includes(r.id));
      return json(owner ? [{ athlete_code: owner.athlete_code }] : []);
    }
    if (u.includes('/planned_sessions')) return json([{ id: 'x', athlete_code: 'KARL' }]);
    return json([]);
  };
  const res = recorder();
  try {
    await athletesHandler({ method: 'POST', query: {}, headers: { 'x-dashboard-key': 'k', 'x-coach-name': handle }, body }, res);
  } finally {
    global.fetch = original;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
  return { res, writes: requests.filter((r) => r.method !== 'GET' && r.url.includes('/planned_sessions')) };
}

const ROWS = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', athlete_code: 'KARL' }, { id: 'aaaaaaaa-0000-4000-8000-000000000002', athlete_code: 'KHANG' }];

test('plan_update / plan_delete / plan_insert are scoped to the coach’s athletes', async () => {
  // Alex is scoped to KHANG only.
  let r = await callAs('ALEX', { action: 'plan_update', id: ROWS[0].id, fields: { planned_date: '2026-11-20' } }, ROWS);
  assert.equal(r.res.statusCode, 403); assert.equal(r.writes.length, 0);
  r = await callAs('ALEX', { action: 'plan_delete', id: ROWS[0].id }, ROWS);
  assert.equal(r.res.statusCode, 403); assert.equal(r.writes.length, 0);
  r = await callAs('ALEX', { action: 'plan_insert', row: { athlete_code: 'KARL', planned_date: '2026-11-20', title: 'X' } }, ROWS);
  assert.equal(r.res.statusCode, 403); assert.equal(r.writes.length, 0);
  r = await callAs('ALEX', { action: 'plan_insert', row: { athlete_code: 'KHANG', planned_date: '2026-11-20', title: 'X' }, copy_from: ROWS[0].id }, ROWS);
  assert.equal(r.res.statusCode, 403, 'copying another athlete’s prescription is refused'); assert.equal(r.writes.length, 0);

  r = await callAs('ALEX', { action: 'plan_update', id: ROWS[1].id, fields: { planned_date: '2026-11-20' } }, ROWS);
  assert.equal(r.res.statusCode, 200); assert.equal(r.writes.length, 1);
});

test('plan_update cannot move a session to a different athlete', async () => {
  let r = await callAs('KARL', { action: 'plan_update', id: ROWS[1].id, fields: { athlete_code: 'KARL', title: 'Mine now' } }, ROWS);
  assert.equal(r.res.statusCode, 400); assert.equal(r.writes.length, 0);
  r = await callAs('KARL', { action: 'plan_update', id: ROWS[1].id, fields: { athlete_code: 'khang', title: 'Same athlete' } }, ROWS);
  assert.equal(r.res.statusCode, 200); assert.equal(r.writes.length, 1);
});
