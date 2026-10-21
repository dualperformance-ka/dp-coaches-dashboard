// public/background-poller.js, run in a VM with a virtual clock, document,
// navigator and window, so hours of polling take milliseconds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/background-poller.js', import.meta.url), 'utf8');

function makeEnv({ visible = true, online = true, random = 0.5 } = {}) {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const listeners = { document: {}, window: {} };
  const on = bucket => (type, fn) => { (listeners[bucket][type] ||= new Set()).add(fn); };
  const off = bucket => (type, fn) => { listeners[bucket][type]?.delete(fn); };

  const document = { visibilityState: visible ? 'visible' : 'hidden', addEventListener: on('document'), removeEventListener: off('document') };
  const window = { addEventListener: on('window'), removeEventListener: off('window') };
  const navigator = { onLine: online };

  const env = {
    document, window, navigator,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    now: () => now,
    random: () => random,
    AbortController,
  };

  async function flush() { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }

  // Advances virtual time, firing timers in order and letting promises settle.
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      await flush();
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = target;
    await flush();
  }

  function fire(bucket, type, event = {}) {
    for (const fn of [...(listeners[bucket][type] || [])]) fn(event);
  }

  return {
    env, advance, flush,
    get now() { return now; },
    setVisible(v) { document.visibilityState = v ? 'visible' : 'hidden'; fire('document', 'visibilitychange'); },
    setOnline(v) { navigator.onLine = v; fire('window', v ? 'online' : 'offline'); },
    focus() { fire('window', 'focus'); },
    pagehide(persisted = false) { fire('window', 'pagehide', { persisted }); },
    listenerCount: () => Object.values(listeners).reduce((n, b) => n + Object.values(b).reduce((m, s) => m + s.size, 0), 0),
  };
}

function loadPoller() {
  const sandbox = { setTimeout, clearTimeout, AbortController, Promise, Math, Date };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return sandbox.DPPoller;
}

const MIN = 60000;

function recordingRun(results = []) {
  const calls = [];
  const run = ({ signal, reason }) => {
    calls.push({ at: null, reason, signal });
    const outcome = results.length ? results.shift() : 'ok';
    if (outcome === 'hang') return new Promise(() => {});
    if (outcome === 'fail') return Promise.reject(new Error('503 upstream_timeout'));
    return Promise.resolve();
  };
  return { calls, run };
}

test('healthy polling runs once a minute, never faster', async () => {
  const { createPoller } = loadPoller();
  const t = makeEnv({ random: 0 });
  const { calls, run } = recordingRun();
  createPoller({ run, env: t.env, intervalMs: 12000 }).start();
  await t.advance(10 * MIN);
  assert.equal(calls.length, 10, 'a 12s request is clamped to the 60s floor');
});

test('hidden tabs and offline tabs generate no polling traffic', async () => {
  const { createPoller } = loadPoller();
  const hidden = makeEnv({ visible: false });
  const a = recordingRun();
  createPoller({ run: a.run, env: hidden.env }).start({ immediate: true });
  await hidden.advance(60 * MIN);
  assert.equal(a.calls.length, 0);

  const offline = makeEnv({ online: false });
  const b = recordingRun();
  createPoller({ run: b.run, env: offline.env }).start({ immediate: true });
  await offline.advance(60 * MIN);
  assert.equal(b.calls.length, 0);

  // Going hidden mid-way stops the loop; coming back refreshes once.
  const t = makeEnv({ random: 0 });
  const c = recordingRun();
  createPoller({ run: c.run, env: t.env }).start();
  await t.advance(2 * MIN);
  assert.equal(c.calls.length, 2);
  t.setVisible(false);
  await t.advance(30 * MIN);
  assert.equal(c.calls.length, 2, 'nothing while hidden');
  t.setVisible(true);
  await t.advance(1000);
  assert.equal(c.calls.length, 3, 'one refresh on return');
  assert.equal(c.calls[2].reason, 'visible');
});

test('a slow request never overlaps the next poll or a manual refresh', async () => {
  const { createPoller } = loadPoller();
  const t = makeEnv();
  const { calls, run } = recordingRun(['hang']);
  const poller = createPoller({ run, env: t.env, requestTimeoutMs: 10 * MIN }).start({ immediate: true });
  await t.advance(5 * MIN);
  poller.refreshNow();
  poller.refreshNow();
  t.focus();
  t.setOnline(true);
  await t.advance(MIN);
  assert.equal(calls.length, 1, 'one in-flight request per source');
});

test('failures back off exponentially with jitter, cap at five minutes, and reset on success', async () => {
  const { createPoller } = loadPoller();
  const t = makeEnv({ random: 0.5 }); // the jitter term is neutral at 0.5
  const { calls, run } = recordingRun(['fail', 'fail', 'fail', 'fail', 'ok', 'ok']);
  const times = [];
  const poller = createPoller({ run: (ctx) => { times.push(t.now); return run(ctx); }, env: t.env }).start({ immediate: true });
  await t.advance(30 * MIN);
  const gaps = times.slice(1).map((at, i) => at - times[i]);
  // fail → 2 min, fail → 4 min, fail → 5 min (cap), fail → 5 min, ok → 1 min (+jitter)
  assert.deepEqual(gaps.slice(0, 5), [120000, 240000, 300000, 300000, 63000]);
  assert.ok(calls.length >= 6);
  assert.equal(poller.state().failures, 0);

  // Jitter spreads backoff within ±20% and never beyond the cap.
  const low = makeEnv({ random: 0 });
  const high = makeEnv({ random: 1 });
  const lowPoller = createPoller({ run: () => Promise.reject(new Error('x')), env: low.env }).start({ immediate: true });
  const highPoller = createPoller({ run: () => Promise.reject(new Error('x')), env: high.env }).start({ immediate: true });
  await low.advance(1); await high.advance(1);
  assert.equal(lowPoller.state().nextDelayMs(), 96000);
  assert.equal(highPoller.state().nextDelayMs(), 144000);
  for (let i = 0; i < 6; i += 1) { await low.advance(10 * MIN); await high.advance(10 * MIN); }
  assert.ok(highPoller.state().nextDelayMs() <= 300000);
  assert.ok(lowPoller.state().nextDelayMs() >= 240000);
});

test('focus, visibility and online events arriving together make one request', async () => {
  const { createPoller } = loadPoller();
  const t = makeEnv();
  const { calls, run } = recordingRun();
  createPoller({ run, env: t.env }).start();
  await t.advance(30000); // past the minimum gap since start
  t.setVisible(true);
  t.focus();
  t.setOnline(true);
  t.focus();
  await t.advance(1000);
  assert.equal(calls.length, 1);

  // Another burst seconds later adds nothing.
  t.focus();
  t.setVisible(true);
  await t.advance(2000);
  assert.equal(calls.length, 1);

  // While failing, wake events cannot hammer a struggling API.
  const f = makeEnv();
  const failing = recordingRun(['fail', 'fail', 'fail']);
  createPoller({ run: failing.run, env: f.env }).start({ immediate: true });
  await f.advance(1000);
  for (let i = 0; i < 10; i += 1) { f.focus(); await f.advance(2000); }
  assert.equal(failing.calls.length, 1, 'no wake refresh inside the 30s failing gap');
  await f.advance(15000);
  f.focus();
  await f.advance(1000);
  assert.equal(failing.calls.length, 2);
});

test('each request carries a deadline signal so a browser fetch cannot hang', async () => {
  const { createPoller } = loadPoller();
  const t = makeEnv();
  const { calls, run } = recordingRun(['hang', 'ok']);
  const poller = createPoller({ run, env: t.env, requestTimeoutMs: 20000 }).start({ immediate: true });
  await t.advance(19000);
  assert.equal(calls[0].signal.aborted, false);
  await t.advance(1000);
  assert.equal(calls[0].signal.aborted, true);
  // The poller does not abandon the request itself: a real fetch rejects when
  // its signal aborts, and that rejection is what frees the loop. Until then
  // nothing else may start.
  assert.equal(poller.state().inFlight, true);
});

test('pagehide stops polling and removes every listener', async () => {
  const { createPoller } = loadPoller();
  const t = makeEnv();
  const { calls, run } = recordingRun(['hang']);
  const poller = createPoller({ run, env: t.env }).start({ immediate: true });
  await t.advance(10);
  const signal = calls[0].signal;
  assert.ok(t.listenerCount() > 0);
  t.pagehide(false);
  assert.equal(signal.aborted, true, 'in-flight request aborted on unload');
  assert.equal(t.listenerCount(), 0);
  assert.equal(poller.state().stopped, true);
  await t.advance(60 * MIN);
  t.focus();
  await t.advance(MIN);
  assert.equal(calls.length, 1);
});

test('dashboard sources use the poller, not fixed intervals', () => {
  const dashboard = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/coaching-actions.js', import.meta.url), 'utf8');

  // Loaded before both consumers: before the inline dashboard script and the
  // deferred coaching-actions script.
  const pollerTag = dashboard.indexOf('<script src="/background-poller.js?v=');
  assert.ok(pollerTag > 0);
  assert.ok(pollerTag < dashboard.indexOf('function startSharedResolutionSync'));
  assert.ok(pollerTag < dashboard.indexOf('<script src="/coaching-actions.js'));

  assert.doesNotMatch(dashboard, /setInterval\(refreshSharedAcknowledgements/);
  assert.doesNotMatch(actions, /setInterval\(/);
  assert.match(actions, /request\('\/api\/actions\?status=active'/);
  assert.doesNotMatch(actions, /status=all/);
  // Completed history is fetched only while that tab is open.
  assert.match(actions, /if \(filter === 'done'\) \{\s*const history = await request\('\/api\/actions\?status=done'/);
  // Both pass the poller's deadline signal into fetch.
  assert.match(actions, /const init = \{ cache: 'no-store', signal \};/);
  assert.match(dashboard, /fetch\(`\$\{ROSTER_API\}\?action=acknowledgements`, \{ cache: 'no-store', signal \}\)/);
  // A background refresh never repaints under someone typing.
  assert.match(actions, /function renderWhenIdle\(\)/);
  assert.match(dashboard, /if \(_isTyping\(\)\) \{/);
});
