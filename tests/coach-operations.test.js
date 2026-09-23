import assert from 'node:assert/strict';
import test from 'node:test';

// api/athletes.js reads SUPABASE_URL once at import, so the environment is
// set before the handlers are loaded.
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'service-key';
const { default: athletesHandler } = await import('../api/athletes.js');
const { default: coachDataHandler } = await import('../api/coach-data.js');
import {
  loadOperations,
  mapDataRequest,
  mapNotifyStatus,
  planMessageTransition,
  planRequestTransition,
  updateContactMessage,
  updateDataRequest,
} from '../server/coach-operations.js';

const NOW = new Date('2026-09-23T00:30:00.000Z');
const REQ_ID = '0f30b419-62ad-4bef-80e2-35eb71eb8ccb';

function recorder() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return value; },
    end() { return undefined; },
  };
}

async function withEnv(fetchImpl, fn) {
  const saved = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY, dash: process.env.DASHBOARD_ACCESS_KEY };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';
  global.fetch = fetchImpl;
  try { return await fn(); } finally {
    global.fetch = saved.fetch;
    for (const [env, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_KEY', saved.key], ['DASHBOARD_ACCESS_KEY', saved.dash]]) {
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ── Mapping and ordering ─────────────────────────────────────────────────────

test('queues are ordered by what needs doing: unread and outstanding first', async () => {
  const select = async table => {
    if (table === 'contact_messages') return [
      { id: 3, athlete_code: 'b', body: 'newest read', created_at: '2026-09-22T00:00:00Z', read_at: '2026-09-22T01:00:00Z', read_by: 'Karl' },
      { id: 2, athlete_code: 'a', body: 'newer unread', created_at: '2026-09-21T00:00:00Z', read_at: null },
      { id: 1, athlete_code: 'a', body: 'oldest unread', created_at: '2026-09-01T00:00:00Z', read_at: null },
    ];
    if (table === 'data_requests') return [
      { id: REQ_ID, athlete_code: 'a', kind: 'account_deletion', requested_at: '2026-08-01T00:00:00Z' },
      { id: 'b1b2c3d4-0000-4000-8000-000000000000', athlete_code: 'b', kind: 'wearable_deletion', requested_at: '2026-09-20T00:00:00Z', completed_at: '2026-09-21T00:00:00Z' },
    ];
    if (table === 'notify_status') return [
      { athlete_code: 'a', devices: 0, notifications_managed: true, unread: 2, queued: 1 },
      { athlete_code: 'b', devices: 1, notifications_managed: false, last_push: '2026-09-22T00:00:00Z' },
    ];
    throw new Error(table);
  };
  const out = await loadOperations(select, NOW);
  assert.deepEqual(out.contactMessages.map(m => m.id), ['1', '2', '3']);
  assert.equal(out.contactMessages[0].athleteCode, 'A');
  assert.equal(out.dataRequests[0].state, 'overdue');
  assert.equal(out.dataRequests[1].state, 'completed');
  assert.deepEqual(out.operationsCounts, {
    messagesUnread: 2, messagesTotal: 3, dataRequestsOpen: 1, dataRequestsOverdue: 1, dataRequestsTotal: 2,
    notifyAthletes: 2, notifyNoDevice: 1, notifyQueued: 1,
  });
  assert.deepEqual(out.operationsMissing, []);
});

test('a source that fails is named as missing, never shown as an empty queue', async () => {
  const out = await loadOperations(async table => {
    if (table === 'data_requests') throw new Error('relation does not exist');
    return [];
  }, NOW);
  assert.deepEqual(out.operationsMissing, ['data_requests']);
  assert.deepEqual(out.dataRequests, []);
});

test('attribution columns are optional until their migration runs', async () => {
  const seen = [];
  const out = await loadOperations(async (table, params) => {
    seen.push(`${table}:${params.select}`);
    if (params.select?.includes('read_by')) throw new Error("Could not find the 'read_by' column of 'contact_messages' in the schema cache");
    if (params.select?.includes('acknowledged_by')) throw new Error('column data_requests.acknowledged_by does not exist');
    if (params.select?.includes('completed_by')) throw new Error('column data_requests.completed_by does not exist');
    return table === 'contact_messages' ? [{ id: 9, athlete_code: 'A', body: 'hi', created_at: '2026-09-22T00:00:00Z' }] : [];
  }, NOW);
  assert.deepEqual(out.operationsMissing, []);
  assert.equal(out.contactMessages[0].readBy, null);
});

test('data request due state follows the published 30-day commitment', () => {
  const at = days => new Date(NOW.getTime() - days * 86400000).toISOString();
  assert.equal(mapDataRequest({ id: REQ_ID, requested_at: at(5) }, NOW).state, 'open');
  assert.equal(mapDataRequest({ id: REQ_ID, requested_at: at(24) }, NOW).state, 'due_soon');
  assert.equal(mapDataRequest({ id: REQ_ID, requested_at: at(31) }, NOW).state, 'overdue');
  const done = mapDataRequest({ id: REQ_ID, requested_at: at(40), completed_at: at(35) }, NOW);
  assert.equal(done.state, 'completed');
  assert.equal(done.daysOpen, 5);
});

test('notification health separates inbox from push from no device', () => {
  assert.equal(mapNotifyStatus({ athlete_code: 'a', devices: 0 }).delivery, 'no_device');
  assert.equal(mapNotifyStatus({ athlete_code: 'a', devices: 2 }).delivery, 'registered_not_pushed');
  const pushing = mapNotifyStatus({ athlete_code: 'a', devices: 1, last_push: '2026-09-22T00:00:00Z', notifications_managed: false, unread: '3' });
  assert.equal(pushing.delivery, 'pushing');
  assert.equal(pushing.exempt, true);
  assert.equal(pushing.unread, 3);
});

// ── State machine ────────────────────────────────────────────────────────────

test('data request transitions are validated server-side', () => {
  const open = { acknowledged_at: null, completed_at: null };
  const ack = planRequestTransition('data_request_acknowledge', open, 'Karl', NOW);
  assert.deepEqual(ack, { acknowledged_at: NOW.toISOString(), acknowledged_by: 'Karl' });
  assert.equal(planRequestTransition('data_request_acknowledge', { acknowledged_at: 'x' }, 'Karl', NOW), null);
  const complete = planRequestTransition('data_request_complete', open, 'Alex', NOW);
  assert.equal(complete.completed_by, 'Alex');
  assert.equal(complete.acknowledged_by, 'Alex', 'completing records the acknowledgement too');
  assert.throws(() => planRequestTransition('data_request_reopen', open, 'Karl', NOW), e => e.status === 409);
  assert.throws(() => planRequestTransition('data_request_acknowledge', { completed_at: 'x' }, 'Karl', NOW), e => e.status === 409);
  assert.deepEqual(planRequestTransition('data_request_reopen', { completed_at: 'x' }, 'Karl', NOW), { completed_at: null, completed_by: null });
  assert.throws(() => planRequestTransition('data_request_delete', open, 'Karl', NOW), e => e.status === 400);
  assert.deepEqual(planMessageTransition('message_read', { read_at: null }, 'Karl', NOW), { read_at: NOW.toISOString(), read_by: 'Karl' });
  assert.deepEqual(planMessageTransition('message_unread', { read_at: 'x' }, 'Karl', NOW), { read_at: null, read_by: null });
});

test('identifiers are validated and out-of-scope rows look missing', async () => {
  const sb = async () => [{ id: 5, athlete_code: 'OTHER', read_at: null }];
  const denied = async () => { const e = new Error('You are not authorised for that athlete'); e.status = 403; throw e; };
  await assert.rejects(updateContactMessage('message_read', 'abc', { sb, assertAllowed: async () => {} }), e => e.status === 400);
  await assert.rejects(updateContactMessage('message_read', '5; drop', { sb, assertAllowed: async () => {} }), e => e.status === 400);
  await assert.rejects(updateDataRequest('data_request_complete', 'not-a-uuid', { sb, assertAllowed: async () => {} }), e => e.status === 400);
  await assert.rejects(updateContactMessage('message_read', '5', { sb, assertAllowed: denied }), e => e.status === 404);
  await assert.rejects(updateContactMessage('message_read', '5', { sb: async () => [], assertAllowed: async () => {} }), e => e.status === 404);
});

test('marking read patches only that row and records the coach, tolerating a missing column', async () => {
  const calls = [];
  const sb = async (path, options = {}) => {
    calls.push({ path, options });
    if (!options.method) return [{ id: 5, athlete_code: 'KNEE', body: 'hurts', created_at: '2026-09-22T00:00:00Z', read_at: null }];
    if (options.body && 'read_by' in options.body) throw new Error("Could not find the 'read_by' column of 'contact_messages'");
    return [{ id: 5, athlete_code: 'KNEE', body: 'hurts', created_at: '2026-09-22T00:00:00Z', ...options.body }];
  };
  const result = await updateContactMessage('message_read', '5', { sb, coach: 'Karl', assertAllowed: async () => {}, now: NOW });
  assert.equal(result.changed, true);
  assert.equal(result.message.readAt, NOW.toISOString());
  const patches = calls.filter(c => c.options.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal(patches[0].path, 'contact_messages?id=eq.5');
  assert.deepEqual(patches[0].options.body, { read_at: NOW.toISOString(), read_by: 'Karl' });
  assert.deepEqual(patches[1].options.body, { read_at: NOW.toISOString() });
});

// ── HTTP boundary ────────────────────────────────────────────────────────────

test('queue actions require the coach key and a registered coach', async () => {
  await withEnv(async url => { throw new Error(`no network expected: ${url}`); }, async () => {
    const res = recorder();
    await athletesHandler({ method: 'POST', headers: {}, body: { action: 'message_read', id: '5' }, query: {} }, res);
    assert.equal(res.statusCode, 401);
  });

  const requests = [];
  await withEnv(async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if (String(url).includes('/coaches?')) return json([]);
    return json([]);
  }, async () => {
    const res = recorder();
    await athletesHandler({ method: 'POST', headers: { 'x-dashboard-key': 'dashboard-key', 'x-coach-name': 'Karl' }, body: { action: 'data_request_complete', id: REQ_ID }, query: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(requests.some(r => r.method === 'PATCH'), false);
  });
});

test('an authorised coach completes a data request with attribution', async () => {
  const requests = [];
  await withEnv(async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (u.includes('/coaches?')) return json([{ id: 'c1', handle: 'KARL', name: 'Karl', role: 'admin', enabled: true }]);
    if (u.includes('/data_requests?') && (init.method || 'GET') === 'GET') return json([{ id: REQ_ID, athlete_code: 'KNEE', kind: 'account_deletion', requested_at: '2026-09-01T00:00:00Z', acknowledged_at: null, completed_at: null }]);
    if (u.includes('/data_requests?') && init.method === 'PATCH') return json([{ id: REQ_ID, athlete_code: 'KNEE', kind: 'account_deletion', requested_at: '2026-09-01T00:00:00Z', ...JSON.parse(init.body) }]);
    throw new Error(`unexpected ${u}`);
  }, async () => {
    const res = recorder();
    await athletesHandler({ method: 'POST', headers: { 'x-dashboard-key': 'dashboard-key', 'x-coach-name': 'Karl' }, body: { action: 'data_request_complete', id: REQ_ID }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.request.state, 'completed');
    assert.equal(res.body.request.completedBy, 'Karl');
    const patch = requests.find(r => r.method === 'PATCH');
    assert.match(patch.url, /data_requests\?id=eq\.0f30b419/);
    assert.equal(patch.body.completed_by, 'Karl');
  });
});

test('coach-data returns the operational queues in success and error shapes', async () => {
  const rowsFor = url => {
    if (url.includes('/contact_messages?')) return [{ id: 1, athlete_code: 'KNEE', body: '<b>help</b>', created_at: '2026-09-22T00:00:00Z' }];
    if (url.includes('/data_requests?')) throw new Error('boom');
    if (url.includes('/notify_status?')) return [{ athlete_code: 'KNEE', devices: 0 }];
    if (url.includes('/athlete_data?')) return [];
    return [];
  };
  await withEnv(async url => {
    try { return json(rowsFor(String(url))); } catch (error) { return json({ message: error.message }, 500); }
  }, async () => {
    const res = recorder();
    await coachDataHandler({ method: 'GET', headers: { 'x-dashboard-key': 'dashboard-key' }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.contactMessages.length, 1);
    assert.equal(res.body.contactMessages[0].body, '<b>help</b>', 'escaping happens at render, not by mangling data');
    assert.deepEqual(res.body.dataRequests, []);
    assert.deepEqual(res.body.dataQuality, { partial: true, missingSources: ['data_requests'] });
    assert.equal(res.body.notifyStatus[0].delivery, 'no_device');
    assert.equal(res.body.operationsCounts.messagesUnread, 1);
  });

  await withEnv(async () => json({ message: 'down' }, 500), async () => {
    const res = recorder();
    await coachDataHandler({ method: 'GET', headers: { 'x-dashboard-key': 'dashboard-key' }, query: {} }, res);
    assert.equal(res.statusCode, 502);
    for (const key of ['contactMessages', 'dataRequests', 'notifyStatus']) assert.deepEqual(res.body[key], []);
    assert.equal(res.body.dataQuality.partial, true);
    assert.equal(res.body.operationsCounts.messagesUnread, 0);
  });
});
