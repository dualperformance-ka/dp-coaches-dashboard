// Fail-fast behaviour for the Supabase-backed coach routes (October 2026
// timeout incident). These tests stub global fetch; nothing reaches Supabase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const SECRET = 'service-key-DO-NOT-LOG-7f3a';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = SECRET;
process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';

const {
  FAILURE, SupabaseRequestError, isUpstreamUnavailable, supabaseFetch, withSupabaseRoute,
} = await import('../api/_lib/supabase-fetch.js');
const { default: actionsHandler, ACTION_COLUMNS, ACTIONS_BUDGET_MS } = await import('../api/actions.js');
const { default: athletesHandler, ATHLETES_BUDGET_MS } = await import('../api/athletes.js');
const {
  default: coachDataHandler, FULL_LOAD_BUDGET_MS, LIGHT_BUDGET_MS, selectTriageBodyRows,
} = await import('../api/coach-data.js');
const { supabaseRequest } = await import('../api/_lib/supabase-rest.js');

const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const maxDurationMs = route => vercel.functions[`api/${route}.js`].maxDuration * 1000;

function recorder() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return value; },
    end() { this.headersSent = true; return undefined; },
  };
}

const coachHeaders = { 'x-dashboard-key': 'dashboard-key', 'x-coach-name': 'Karl' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

// A Supabase that accepts the connection and never answers, like PostgREST
// during the incident. Honours the abort signal exactly as undici does.
function hangingFetch(calls = []) {
  return (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 120000);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
      }, { once: true });
    });
  };
}

async function withFetch(fetchImpl, fn) {
  const saved = global.fetch;
  global.fetch = fetchImpl;
  try { return await fn(); } finally { global.fetch = saved; }
}

// Collects everything the code under test writes to the console.
async function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => lines.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join('\n');
}

function assertNothingSensitive(text) {
  assert.equal(text.includes(SECRET), false, 'service key leaked');
  assert.doesNotMatch(text, /Bearer /, 'authorization header leaked');
  assert.equal(text.includes('example.supabase.co'), false, 'Supabase URL leaked');
  assert.equal(text.includes('ALVIN'), false, 'athlete code from a query string leaked');
  assert.equal(text.includes('must-not-leave'), false, 'response body leaked');
}

// ── The acceptance criterion, end to end, at the real budgets ───────────────

test('a hanging Supabase becomes a controlled 503 well before each Vercel limit', async () => {
  const cases = [
    { route: 'actions', handler: actionsHandler, req: { method: 'GET', headers: coachHeaders, query: { status: 'active', athlete: 'ALVIN' } } },
    { route: 'athletes', handler: athletesHandler, req: { method: 'GET', headers: coachHeaders, query: { action: 'acknowledgements' } } },
    { route: 'coach-data', handler: coachDataHandler, req: { method: 'GET', headers: coachHeaders, query: {} } },
    { route: 'coach-data', handler: coachDataHandler, req: { method: 'GET', headers: coachHeaders, query: { mode: 'triage' } } },
  ];
  const logs = await captureLogs(() => withFetch(hangingFetch(), async () => {
    await Promise.all(cases.map(async c => {
      const res = recorder();
      const started = Date.now();
      await c.handler(c.req, res);
      c.elapsed = Date.now() - started;
      c.res = res;
    }));
  }));

  for (const c of cases) {
    const limit = maxDurationMs(c.route);
    assert.equal(c.res.statusCode, 503, `${c.route} status`);
    assert.equal(c.res.headers['Retry-After'], '30', `${c.route} Retry-After`);
    assert.equal(c.res.body.code, 'upstream_timeout', `${c.route} code`);
    assert.equal(c.res.body.ok, false);
    assert.ok(c.elapsed < 12500, `${c.route} answered in ${c.elapsed}ms; must be under ~12s`);
    assert.ok(c.elapsed < limit - 2500, `${c.route} answered in ${c.elapsed}ms against a ${limit}ms Vercel limit`);
  }
  // coach-data keeps its full empty response shape on an outage.
  assert.deepEqual(cases[2].res.body.sessions, []);
  assert.deepEqual(cases[2].res.body.dataRequests, []);
  assertNothingSensitive(logs);
  assert.match(logs, /"category":"upstream_timeout"/);
  assert.match(logs, /"event":"route_complete","route":"\/api\/actions"/);
});

test('every route budget leaves headroom under its configured maxDuration', () => {
  assert.ok(ACTIONS_BUDGET_MS <= maxDurationMs('actions') - 3000);
  assert.ok(ATHLETES_BUDGET_MS <= maxDurationMs('athletes') - 3000);
  assert.ok(FULL_LOAD_BUDGET_MS <= maxDurationMs('coach-data') - 3000);
  assert.ok(LIGHT_BUDGET_MS <= maxDurationMs('coach-data') - 3000);
  // The fix is fail-fast, not longer limits.
  assert.equal(vercel.functions['api/actions.js'].maxDuration, 15);
  assert.equal(vercel.functions['api/athletes.js'].maxDuration, 30);
  assert.equal(vercel.functions['api/coach-data.js'].maxDuration, 30);
});

// ── Helper mechanics, at small timeouts ─────────────────────────────────────

test('the per-call deadline aborts a hanging request', async () => {
  const calls = [];
  const started = Date.now();
  const error = await withFetch(hangingFetch(calls), () =>
    supabaseFetch('coach_actions?select=id', { timeoutMs: 50 }).then(() => null, e => e));
  assert.ok(error instanceof SupabaseRequestError);
  assert.equal(error.category, FAILURE.TIMEOUT);
  assert.equal(error.status, 503);
  assert.equal(error.code, 'upstream_timeout');
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.length, 1, 'no automatic retry');
});

test('a route budget caps the total time across sequential calls', async () => {
  const calls = [];
  // Call 1 times out at 120ms, call 2 gets the remaining ~80ms, call 3 finds
  // less than MIN_CALL_BUDGET_MS left and never starts.
  const handler = withSupabaseRoute('/api/test', { budgetMs: 200, timeoutMs: 120 }, async (req, res) => {
    for (let i = 0; i < 3; i += 1) {
      try { await supabaseFetch(`coach_actions?select=id&n=${i}`); } catch { /* keep going, as a lenient caller would */ }
    }
    res.status(200).json({ ok: true });
  });
  const res = recorder();
  const started = Date.now();
  await captureLogs(() => withFetch(hangingFetch(calls), () => handler({ headers: {} }, res)));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 400, `took ${elapsed}ms against a 200ms budget`);
  assert.equal(calls.length, 2, 'the third call never leaves the function once the budget is spent');
});

test('upstream failures are classified without retries', async () => {
  const scenarios = [
    { name: 'PGRST002 schema cache', response: () => json({ code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }, 503), category: FAILURE.SERVER, status: 503, code: 'upstream_unavailable' },
    { name: 'gateway timeout', response: () => json({ message: 'Gateway Timeout' }, 504), category: FAILURE.TIMEOUT, status: 503, code: 'upstream_timeout' },
    { name: 'statement timeout', response: () => json({ code: '57014', message: 'canceling statement due to statement timeout' }, 500), category: FAILURE.TIMEOUT, status: 503, code: 'upstream_timeout' },
    { name: 'Cloudflare origin down', response: () => new Response('<html>521</html>', { status: 521 }), category: FAILURE.SERVER, status: 503, code: 'upstream_unavailable' },
    { name: 'network failure', response: () => { throw new TypeError('fetch failed'); }, category: FAILURE.NETWORK, status: 503, code: 'upstream_unavailable' },
    { name: 'invalid JSON', response: () => new Response('{not json', { status: 200 }), category: FAILURE.INVALID, status: 502, code: 'upstream_invalid_response' },
  ];
  for (const s of scenarios) {
    let calls = 0;
    const logs = await captureLogs(async () => {
      const error = await withFetch(async () => { calls += 1; return s.response(); }, () =>
        supabaseFetch('athlete_data?athlete_code=eq.ALVIN&select=value').then(() => null, e => e));
      assert.equal(error?.category, s.category, s.name);
      assert.equal(error.status, s.status, s.name);
      assert.equal(error.code, s.code, s.name);
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.message.includes('example.supabase.co'), false);
    });
    assert.equal(calls, 1, `${s.name}: retried`);
    assertNothingSensitive(logs);
    assert.match(logs, /"operation":"GET athlete_data"/);
  }
});

test('an expected Supabase 4xx keeps its message and the route keeps its status', async () => {
  // Helper level: no outage status, upstream message preserved for fallbacks.
  const error = await withFetch(async () => json({ code: '42703', message: "column daily_body_logs.pain_location does not exist", details: 'Failing row contains (ALVIN, must-not-leave)' }, 400), () =>
    supabaseFetch('daily_body_logs?select=pain_location').then(() => null, e => e));
  assert.equal(error.category, FAILURE.CLIENT);
  assert.equal(error.status, undefined);
  assert.equal(error.upstreamStatus, 400);
  assert.equal(isUpstreamUnavailable(error), false);
  assert.match(error.message, /pain_location does not exist/);
  assert.equal(error.message.includes('must-not-leave'), false, 'details are not carried');

  // The missing-column fallback that depends on that message still works.
  const seen = [];
  const rows = await captureLogs(() => withFetch(async url => {
    seen.push(String(url));
    if (String(url).includes('pain_location')) return json({ code: '42703', message: "column daily_body_logs.pain_location does not exist" }, 400);
    return json([{ athlete_code: 'K', log_date: '2026-10-20', pain: 6 }]);
  }, async () => {
    const result = await selectTriageBodyRows('2026-10-14');
    assert.equal(result.length, 1);
  }));
  assert.ok(rows !== undefined);
  assert.equal(seen.length, 2, 'fell back to the next projection once');

  // Route level: an upstream 409 (foreign key) is still the route's generic
  // error, not an outage 503, and gets no Retry-After.
  const res = recorder();
  const logs = await captureLogs(() => withFetch(async () => json({ code: '23503', message: 'insert or update on table "coach_actions" violates foreign key constraint', details: 'Key (athlete_code)=(ALVIN) is not present' }, 409), () =>
    actionsHandler({ method: 'POST', headers: coachHeaders, query: {}, body: { athlete_code: 'ALVIN', title: 'Check in' } }, res)));
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers['Retry-After'], undefined);
  assert.equal(res.body.error, 'The dashboard service could not complete that request');
  assert.match(logs, /"category":"upstream_client_error"/);
  assert.match(logs, /"upstreamCode":"23503"/);
  assert.equal(logs.includes('is not present'), false, 'upstream details are not logged');
});

test('route-level validation statuses are unchanged', async () => {
  await withFetch(async () => json([]), async () => {
    const badId = recorder();
    await actionsHandler({ method: 'PATCH', headers: coachHeaders, query: {}, body: { id: 'nope', status: 'done' } }, badId);
    assert.equal(badId.statusCode, 400);

    const missing = recorder();
    await captureLogs(() => actionsHandler({ method: 'PATCH', headers: coachHeaders, query: {}, body: { id: '0f30b419-62ad-4bef-80e2-35eb71eb8ccb', status: 'done' } }, missing));
    assert.equal(missing.statusCode, 404);

    const badStatus = recorder();
    await actionsHandler({ method: 'GET', headers: coachHeaders, query: { status: 'drop table' } }, badStatus);
    assert.equal(badStatus.statusCode, 400);

    const noKey = recorder();
    await actionsHandler({ method: 'GET', headers: {}, query: {} }, noKey);
    assert.equal(noKey.statusCode, 401);
  });
});

test('a caller signal is honoured and its reason is not reclassified', async () => {
  const controller = new AbortController();
  const reason = new Error('client went away');
  setTimeout(() => controller.abort(reason), 20);
  const error = await withFetch(hangingFetch(), () =>
    supabaseFetch('coach_actions?select=id', { timeoutMs: 5000, signal: controller.signal }).then(() => null, e => e));
  assert.equal(error, reason);
});

test('successful routes report the Supabase portion in Server-Timing', async () => {
  const res = recorder();
  await captureLogs(() => withFetch(async (url, init) => (init.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { 'Content-Range': '*/7' } })
    : json([])), () => actionsHandler({ method: 'GET', headers: coachHeaders, query: { status: 'active' } }, res)));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Server-Timing'], /^supabase;dur=[\d.]+;desc="2 calls"$/);
  assert.ok(res.headers['X-Request-Id']);
});

test('the shared portal helper is bounded too', async () => {
  const started = Date.now();
  const error = await withFetch(hangingFetch(), () =>
    supabaseRequest('push_subscriptions?select=id', { timeoutMs: 40 }).then(() => null, e => e));
  assert.equal(error.code, 'upstream_timeout');
  assert.ok(Date.now() - started < 1000);
});

// ── Query shape on the hot paths ────────────────────────────────────────────

test('the actions board polls active rows with explicit columns and only counts completed ones', async () => {
  const requests = [];
  const res = recorder();
  await captureLogs(() => withFetch(async (url, init) => {
    requests.push({ url: String(url), method: init.method, prefer: init.headers?.Prefer || '' });
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': '*/12' } });
    return json([{ id: 'a', status: 'open', athlete_code: 'K' }]);
  }, () => actionsHandler({ method: 'GET', headers: coachHeaders, query: { status: 'active' } }, res)));

  assert.equal(res.body.completedCount, 12);
  assert.equal(res.body.actions.length, 1);
  const list = requests.find(r => r.method === 'GET');
  const count = requests.find(r => r.method === 'HEAD');
  assert.ok(list.url.includes(`select=${ACTION_COLUMNS}`));
  assert.ok(list.url.includes('status=in.(open,in_progress,waiting)'));
  assert.equal(list.url.includes('select=*'), false);
  assert.equal(list.prefer.includes('count='), false, 'no count on the row query');
  assert.ok(count.url.includes('status=eq.done'));
  assert.match(count.prefer, /count=exact/, 'the count that is shown is the only count requested');

  // Completed history only when asked for.
  const done = [];
  await captureLogs(() => withFetch(async url => { done.push(String(url)); return json([]); }, () =>
    actionsHandler({ method: 'GET', headers: coachHeaders, query: { status: 'done' } }, recorder())));
  assert.equal(done.length, 1);
  assert.ok(done[0].includes('status=eq.done'));
});

test('a resolution-state outage fails the acknowledgement poll instead of un-resolving rows', async () => {
  const res = recorder();
  await captureLogs(() => withFetch(async url => (String(url).includes('/coach_signal_state?')
    ? json({ message: 'Gateway Timeout' }, 504)
    : json([])), () => athletesHandler({ method: 'GET', headers: coachHeaders, query: { action: 'acknowledgements' } }, res)));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'upstream_timeout');
  assert.equal('signals' in res.body, false);

  // A missing table (pre-migration) still means "nothing resolved".
  const pre = recorder();
  await captureLogs(() => withFetch(async url => (String(url).includes('/coach_signal_state?')
    ? json({ code: 'PGRST205', message: 'Could not find the table' }, 404)
    : json([])), () => athletesHandler({ method: 'GET', headers: coachHeaders, query: { action: 'acknowledgements' } }, pre)));
  assert.equal(pre.statusCode, 200);
  assert.deepEqual(pre.body.signals, []);
});

test('acknowledgement polling reads only the columns the dashboard uses', async () => {
  const urls = [];
  const res = recorder();
  await captureLogs(() => withFetch(async url => { urls.push(String(url)); return json([]); }, () =>
    athletesHandler({ method: 'GET', headers: coachHeaders, query: { action: 'acknowledgements' } }, res)));
  assert.equal(res.statusCode, 200);
  const acks = urls.find(u => u.includes('/athlete_data?'));
  const signals = urls.find(u => u.includes('/coach_signal_state?'));
  assert.match(acks, /select=athlete_code,key,value&/);
  assert.match(signals, /select=athlete_code,signal_type,fingerprint,resolved_by,resolved_at&/);
  assert.equal(urls.some(u => u.includes('select=*')), false);
});

test('the full coach-data load asks for no counts and pages by a stable cursor', async () => {
  const requests = [];
  const sessions = Array.from({ length: 2500 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    athlete_code: 'K',
    session_name: `S${i}`,
    // Many rows share a date: the case offset paging got wrong.
    session_date: `2026-10-${String(1 + (i % 20)).padStart(2, '0')}`,
  }));
  const res = recorder();
  await captureLogs(() => withFetch(async (url, init) => {
    const u = new URL(String(url));
    requests.push({ url: u, headers: init.headers || {} });
    if (u.pathname.endsWith('/training_session_logs')) {
      const after = (u.searchParams.get('id') || '').replace(/^gt\./, '');
      const limit = Number(u.searchParams.get('limit'));
      return json(sessions.filter(r => !after || r.id > after).slice(0, limit));
    }
    return json([]);
  }, () => coachDataHandler({ method: 'GET', headers: coachHeaders, query: {} }, res)));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sessionsStructured ?? res.body.counts.sessionsStructured, 2500);
  const names = res.body.sessions.map(s => s.Session);
  assert.equal(new Set(names).size, 2500, 'no row skipped or repeated across pages');
  const dates = res.body.sessions.map(s => s.Date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first, as before');

  for (const r of requests) {
    assert.equal(String(r.headers.Prefer || '').includes('count='), false, `${r.url.pathname} asked for a count`);
    assert.equal('Range' in r.headers, false, `${r.url.pathname} used offset paging`);
  }
  const pages = requests.filter(r => r.url.pathname.endsWith('/training_session_logs'));
  assert.equal(pages.length, 3);
  assert.equal(pages[0].url.searchParams.get('order'), 'id.asc');
  assert.equal(pages[1].url.searchParams.get('id'), `gt.${sessions[999].id}`);
});

test('an optional table that is missing degrades, an outage does not', async () => {
  // Missing table (404 PGRST205) for an optional source: the load still succeeds.
  const ok = recorder();
  await captureLogs(() => withFetch(async url => (String(url).includes('/coach_signal_state?')
    ? json({ code: 'PGRST205', message: 'Could not find the table' }, 404)
    : json([])), () => coachDataHandler({ method: 'GET', headers: coachHeaders, query: {} }, ok)));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.signalState, []);

  // The same optional source timing out fails the load as an outage instead of
  // pretending nothing is resolved.
  const down = recorder();
  await captureLogs(() => withFetch(async url => (String(url).includes('/coach_signal_state?')
    ? json({ message: 'Gateway Timeout' }, 504)
    : json([])), () => coachDataHandler({ method: 'GET', headers: coachHeaders, query: {} }, down)));
  assert.equal(down.statusCode, 503);
  assert.equal(down.body.code, 'upstream_timeout');
});
