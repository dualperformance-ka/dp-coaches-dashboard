import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAdmin,
  assertAthleteAllowed,
  authorisedAthleteCodes,
  resolveCoachIdentity,
  resolveScope,
} from '../server/coach-scope.js';

const ADMIN = { id: 'c-karl', handle: 'KARL', name: 'Karl', role: 'admin' };
const COACH = { id: 'c-alex', handle: 'ALEX', name: 'Alex', role: 'coach' };

function fakeSb(routes) {
  return async function sb(path) {
    for (const [pattern, value] of routes) {
      if (path.includes(pattern)) return typeof value === 'function' ? value(path) : value;
    }
    return [];
  };
}

// ── Identity ─────────────────────────────────────────────────────────────────

test('a valid key alone is not enough — the coach must be registered', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  const req = { headers: { 'x-dashboard-key': 'test-key', 'x-coach-name': 'Karl' } };

  await assert.rejects(
    () => resolveCoachIdentity(req, fakeSb([['coaches?handle', []]])),
    (error) => error.status === 403 && /not registered/.test(error.message)
  );
});

test('a disabled coach is refused even with the right key', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  const req = { headers: { 'x-dashboard-key': 'test-key', 'x-coach-name': 'Alex' } };

  await assert.rejects(
    () => resolveCoachIdentity(req, fakeSb([
      ['coaches?handle', [{ id: 'c-alex', handle: 'ALEX', name: 'Alex', role: 'coach', enabled: false }]],
    ])),
    (error) => error.status === 403 && /disabled/.test(error.message)
  );
});

test('a wrong key never reaches the coaches table', async () => {
  process.env.DASHBOARD_ACCESS_KEY = 'test-key';
  let queried = false;
  const req = { headers: { 'x-dashboard-key': 'wrong', 'x-coach-name': 'Karl' } };
  await assert.rejects(
    () => resolveCoachIdentity(req, async () => { queried = true; return []; }),
    (error) => error.status === 401
  );
  assert.equal(queried, false);
});

// ── Athlete scope ────────────────────────────────────────────────────────────

test('an admin is unrestricted', async () => {
  const codes = await authorisedAthleteCodes(ADMIN, fakeSb([]));
  assert.equal(codes, null, 'null means no restriction');
  await assertAthleteAllowed(ADMIN, 'JORDAN', fakeSb([]));
});

test('a coach with no explicit assignments keeps working as they do today', async () => {
  // Opt-in narrowing: no coach_athletes rows means nothing changes for them.
  const sb = fakeSb([['coach_athletes', []]]);
  assert.equal(await authorisedAthleteCodes(COACH, sb), null);
  await assertAthleteAllowed(COACH, 'JORDAN', sb);
});

test('a coach with assignments is limited to exactly those athletes', async () => {
  const sb = fakeSb([['coach_athletes', [{ athlete_code: 'NATE' }, { athlete_code: 'THOMAS' }]]]);
  await assertAthleteAllowed(COACH, 'nate', sb); // case-insensitive
  await assert.rejects(
    () => assertAthleteAllowed(COACH, 'JORDAN', sb),
    (error) => error.status === 403
  );
});

test('an unauthorised athlete and a non-existent one fail identically', async () => {
  // Otherwise the error text is a roster enumeration oracle.
  const sb = fakeSb([['coach_athletes', [{ athlete_code: 'NATE' }]]]);
  const a = await assertAthleteAllowed(COACH, 'JORDAN', sb).catch((e) => e.message);
  const b = await assertAthleteAllowed(COACH, 'NOBODY-AT-ALL', sb).catch((e) => e.message);
  assert.equal(a, b);
});

test('destructive actions require an admin', () => {
  assert.doesNotThrow(() => assertAdmin(ADMIN));
  assert.throws(() => assertAdmin(COACH), (error) => error.status === 403);
});

// ── Edit scope (§18) ─────────────────────────────────────────────────────────

const SESSION = {
  id: 'sess-1',
  athlete_code: 'JORDAN',
  title: 'Upper A',
  planned_date: '2026-08-17',
  locked_at: null,
  status: 'Planned',
  programme_week_id: null,
  prescription_mode: 'structured',
};

test('the default scope touches exactly one session', async () => {
  const result = await resolveScope(SESSION, 'session', fakeSb([]));
  assert.equal(result.appliedScope, 'session');
  assert.deepEqual(result.sessions.map((s) => s.id), ['sess-1']);
});

test('an unknown scope value falls back to this session only', async () => {
  const result = await resolveScope(SESSION, 'everything-everywhere', fakeSb([]));
  assert.equal(result.appliedScope, 'session');
  assert.equal(result.sessions.length, 1);
});

test('a completed session is refused outright', async () => {
  await assert.rejects(
    () => resolveScope({ ...SESSION, locked_at: '2026-08-17T09:00:00Z' }, 'session', fakeSb([])),
    (error) => error.status === 409
  );
});

test('a session completed before locking existed is refused too', async () => {
  // 1,168 live rows predate locked_at. Status is the only thing marking them.
  await assert.rejects(
    () => resolveScope({ ...SESSION, status: 'Completed', locked_at: null }, 'session', fakeSb([])),
    (error) => error.status === 409 && /Completed/.test(error.message)
  );
});

test('Missed and Sick sessions are history too', async () => {
  for (const status of ['Missed', 'Sick']) {
    await assert.rejects(
      () => resolveScope({ ...SESSION, status, locked_at: null }, 'session', fakeSb([])),
      (error) => error.status === 409
    );
  }
});

test('future scope excludes completed sessions in the query itself', async () => {
  let requested = '';
  await resolveScope(SESSION, 'future', async (path) => { requested = path; return []; });

  assert.ok(requested.includes('locked_at=is.null'), 'must exclude locked sessions');
  // Allowlist, not denylist: planned_sessions.status is constrained to
  // Planned | Completed | Missed | Sick, so anything that is not Planned is a
  // record of what happened and must never be rewritten.
  assert.ok(requested.includes('status=eq.Planned'), 'must only touch Planned sessions');
  assert.ok(requested.includes('planned_date=gte.2026-08-17'), 'must start at this session');
  assert.ok(requested.includes('athlete_code=eq.JORDAN'), 'must stay on this athlete');
  assert.ok(requested.includes('title=eq.Upper%20A'), 'must stay on this session name');
});

test('block scope degrades to future, and says so, when no programme block exists', async () => {
  const result = await resolveScope(SESSION, 'block', fakeSb([['planned_sessions', [SESSION]]]));
  assert.equal(result.appliedScope, 'future');
  assert.match(result.note, /No programme block/);
});

test('block scope uses the real block when the session belongs to one', async () => {
  const paths = [];
  const sb = async (path) => {
    paths.push(path);
    if (path.includes('athlete_programme_weeks?id=eq.')) return [{ block_id: 'blk-1', programme_id: 'prg-1' }];
    if (path.includes('athlete_programme_weeks?block_id=eq.')) return [{ id: 'wk-4' }, { id: 'wk-5' }];
    return [{ id: 'sess-1' }, { id: 'sess-9' }];
  };

  const result = await resolveScope({ ...SESSION, programme_week_id: 'wk-4' }, 'block', sb);
  assert.equal(result.appliedScope, 'block');
  assert.equal(result.note, '');
  assert.equal(result.sessions.length, 2);

  const query = paths[paths.length - 1];
  assert.ok(query.includes('programme_week_id=in.(wk-4,wk-5)'));
  assert.ok(query.includes('locked_at=is.null'), 'block scope still protects completed sessions');
});
