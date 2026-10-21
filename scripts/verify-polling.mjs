// Drives the real dashboard in Chromium with a virtual clock and counts the
// background requests the two polling sources make. Unit tests cover the
// poller in isolation; this proves the page actually wires it up.
//
//   node scripts/serve-preview.mjs &
//   node scripts/verify-polling.mjs
//
// Prints one PASS/FAIL line per check and exits non-zero on any failure.

import { chromium } from 'playwright';

const BASE = process.env.PREVIEW_URL || 'http://localhost:4173';
const MIN = 60000;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// The dashboard registers /sw.js (public/app.js). Requests a service worker
// makes are invisible to page.route(), so block it to be able to simulate an
// API outage. The worker passes /api/* straight to the network anyway.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => {
  try {
    sessionStorage.setItem('dp_dashboard_key', 'preview');
    sessionStorage.setItem('dp_dashboard_coach', 'KARL');
  } catch {}
  // Headless Chromium is always "visible"; let the test drive it.
  window.__vis = 'visible';
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => window.__vis });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__vis !== 'visible' });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const counts = { actions: 0, acks: 0, actionsAll: 0, actionsDone: 0 };
page.on('request', req => {
  const url = req.url();
  if (url.includes('/api/actions?status=active')) counts.actions += 1;
  if (url.includes('/api/actions?status=all')) counts.actionsAll += 1;
  if (url.includes('/api/actions?status=done')) counts.actionsDone += 1;
  if (url.includes('/api/athletes?action=acknowledgements')) counts.acks += 1;
});

await page.clock.install();
await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.clock.runFor(3000);
await page.waitForLoadState('networkidle');
// Advance in one-second steps so a response the page is waiting on arrives in
// (nearly) the same virtual second it would in real life, instead of the clock
// leaping past the 20s request deadline while the route is still answering.
const settle = async ms => {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await page.clock.runFor(Math.min(1000, ms - elapsed));
    await page.waitForTimeout(5);
  }
  await page.waitForTimeout(50);
};

const start = { ...counts };
check('board loads its active actions once on start', start.actions >= 1, JSON.stringify(start));
check('the old status=all poll is gone', counts.actionsAll === 0);

await settle(10 * MIN);
const visible = { actions: counts.actions - start.actions, acks: counts.acks - start.acks };
check('visible tab: actions poll at most once a minute', visible.actions >= 8 && visible.actions <= 10, `${visible.actions} in 10 min (was ~50 at 12s)`);
check('visible tab: acknowledgements poll at most once a minute', visible.acks >= 8 && visible.acks <= 10, `${visible.acks} in 10 min (was ~50 at 12s)`);

await page.evaluate(() => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
const beforeHidden = { ...counts };
await settle(30 * MIN);
check('hidden tab: no polling traffic for 30 minutes',
  counts.actions === beforeHidden.actions && counts.acks === beforeHidden.acks,
  `actions +${counts.actions - beforeHidden.actions}, acks +${counts.acks - beforeHidden.acks}`);

await page.evaluate(() => {
  window.__vis = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
});
await settle(2000);
check('returning to the tab refreshes each source exactly once',
  counts.actions === beforeHidden.actions + 1 && counts.acks === beforeHidden.acks + 1,
  `actions +${counts.actions - beforeHidden.actions}, acks +${counts.acks - beforeHidden.acks}`);

await page.evaluate(() => window.DP_ACTIONS.filter('done'));
await settle(1000);
check('completed history loads only when the Completed tab opens', counts.actionsDone === 1, `${counts.actionsDone}`);

// Failure: the API answers 503 + Retry-After. Polls must back off.
await page.route(url => url.href.includes('/api/actions?status=active'), route => route.fulfill({
  status: 503, headers: { 'Retry-After': '30', 'Content-Type': 'application/json' },
  body: JSON.stringify({ ok: false, code: 'upstream_timeout', error: 'The database did not respond in time. Try again in a moment.' }),
}));
await page.evaluate(() => window.DP_ACTIONS.filter('open'));
const beforeFail = counts.actions;
await settle(15 * MIN);
const failing = counts.actions - beforeFail;
check('failing API: polls back off (≤6 in 15 minutes instead of 15)', failing >= 3 && failing <= 6, `${failing} requests`);
const boardText = await page.evaluate(() => document.getElementById('coaching-actions')?.textContent || '');
check('failing API: the board keeps what it already showed', /Coaching actions/.test(boardText));

check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
