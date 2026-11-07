// Browser test: Start from text, the Garmin delivery states, the coach reset
// and the next-14-days readiness line, in a real browser at phone widths.
//
// Run: node --test tests/garmin-coach-gaps.browser.test.mjs
// Skips silently if Playwright is not installed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { test('garmin coach browser tests skipped (playwright not installed)', () => {}); }

const SID = '11111111-1111-4111-8111-111111111111';
const READINESS = { ok: true, from: '2026-11-06', to: '2026-11-19', counts: { ready: 1, text_only: 1, needs_fixing: 1 }, items: [
  { id: 'a', title: '6 × 1 km intervals with a long name that has to wrap on a phone', date: '2026-11-07', draft: false, status: 'ready', reason: 'Garmin-ready. The athlete can send it from the portal.' },
  { id: 'b', title: 'Easy run', date: '2026-11-08', draft: true, status: 'text_only', reason: 'Written as text. Open it and use Start from text, or add steps.' },
  { id: 'c', title: 'VO2', date: '2026-11-10', draft: false, status: 'needs_fixing', reason: 'Step 1 (Run): choose either a distance or a time, not both.' },
] };

function page({ garmin = { delivery: 'none' }, legacyRun = [] } = {}) {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${read('public/programming.css')} body{margin:0;padding:16px;font-family:sans-serif}</style></head><body>
<div id="prog-week-body"><div class="plan-week-meta" id="plan-week-meta">KARL · 2 Nov – 8 Nov</div><div class="plan-grid" id="plan-grid"></div></div>
<div id="builder"></div>
<script>
  window.__posts = []; window.__opened = []; window.confirm = () => true;
  window._progAthlete = 'KARL';
  window.maPost = async (payload) => { window.__posts.push(payload); return { ok: true, cleared: 1 }; };
  window.renderPlanGrid = function () { document.getElementById('plan-grid').textContent = 'grid'; };
  window.openPlanSession = function (id) { window.__opened.push(id); };
  window.fetch = async (url) => {
    if (String(url).includes('action=garmin_readiness')) return { ok: true, status: 200, json: async () => (${JSON.stringify(READINESS)}) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
</script>
<script>${read('public/run-workout.js')}</script>
<script>${read('public/run-builder.js')}</script>
<script>${read('public/plan-session-run.js')}</script>
<script>
  const B = window.DPRunBuilder;
  B.load({ session: { id: '${SID}', athlete_code: 'KARL', title: '6 × 1 km', session_type: 'Intervals', planned_date: '2026-11-12', publish_state: 'published', prescription_mode: 'legacy' },
    runSteps: [], legacyRun: ${JSON.stringify(legacyRun)}, garmin: ${JSON.stringify(garmin)} },
    { apiPost: (p) => window.maPost(p), toast: (m) => { window.__toast = m; } });
  const host = document.getElementById('builder');
  window.__mountBuilder = () => { B.load({ session: B._state.session, runSteps: B._state.steps.map(s => s), legacyRun: ${JSON.stringify(legacyRun)}, garmin: B._state.garmin }, B._state.ctx); };
  host.innerHTML = B.html(); B.bind(host); B.refresh(host);
</script></body></html>`;
}

async function open(width, options) {
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.setDefaultTimeout(5000);
  await p.setContent(page(options), { waitUntil: 'load' });
  return { browser, p, errors };
}

const TEXT = [
  { key: 'warm_up', label: 'Warm up', value: '10min easy' }, { key: 'intervals', label: 'Intervals / sets', value: '6 x 1km' },
  { key: 'working_pace', label: 'Working pace', value: '4:30-4:45' }, { key: 'rest', label: 'Rest between sets', value: '90s jog' },
  { key: 'cool_down', label: 'Cool down', value: '10min easy' },
];

if (chromium) {
  for (const width of [360, 390]) {
    test(`readiness line fits ${width}px and opens a run`, async () => {
      const { browser, p, errors } = await open(width);
      try {
        await p.evaluate(() => window.renderPlanGrid());
        await p.waitForSelector('#prog-garmin-ready summary');
        assert.match(await p.textContent('#prog-garmin-ready summary'), /Garmin · next 14 days\s+1 ready · 1 text only · 1 need fixing/);
        await p.click('#prog-garmin-ready summary');
        const states = await p.$$eval('#prog-garmin-ready .pgr-state', (n) => n.map((e) => e.textContent));
        assert.deepEqual(states, ['Garmin-ready', 'Text only', 'Needs fixing']);
        const fit = await p.evaluate(() => { const el = document.getElementById('prog-garmin-ready'); return { right: el.getBoundingClientRect().right, vw: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth }; });
        assert.ok(fit.right <= fit.vw && fit.overflow <= 0, JSON.stringify(fit));
        if (process.env.GARMIN_SHOTS) await p.locator('#prog-garmin-ready').screenshot({ path: `/tmp/claude-0/dash-readiness-${width}.png` });
        await p.click('#prog-garmin-ready [data-open-session="b"]');
        assert.deepEqual(await p.evaluate(() => window.__opened), ['b']);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  }

  test('Start from text drafts the steps from the run’s text and saves nothing', async () => {
    const { browser, p, errors } = await open(390, { legacyRun: TEXT });
    try {
      await p.click('[data-act-global="convert"]');
      await p.click('[data-quick="text"]');
      await p.waitForSelector('.rb-draft-notes');
      assert.match(await p.textContent('.rb-draft-notes'), /Check every step before saving/);
      const steps = await p.evaluate(() => window.DPRunBuilder.steps().map((s) => [s.step_type, s.repeat_count, s.end, s.distance_km, s.duration_sec, s.target, s.pace_fast, s.pace_slow]));
      assert.deepEqual(steps, [
        ['warmup', null, 'time', null, 600, 'effort', '', ''], ['repeat', 6, 'lap', null, null, 'none', '', ''],
        ['interval', null, 'distance', 1, null, 'pace', '4:30', '4:45'], ['recovery', null, 'time', null, 90, 'effort', '', ''],
        ['cooldown', null, 'time', null, 600, 'effort', '', ''],
      ]);
      assert.equal(await p.evaluate(() => window.DPRunBuilder.isDirty()), true, 'a draft is an unsaved change');
      assert.deepEqual(await p.evaluate(() => window.__posts), [], 'nothing saved or published');
      if (process.env.GARMIN_SHOTS) await p.locator('#builder').screenshot({ path: '/tmp/claude-0/dash-start-from-text-390.png' });
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('without any text there is no Start from text button', async () => {
    const { browser, p } = await open(390);
    try {
      // A structured run with no steps shows the empty builder straight away.
      await p.evaluate(() => { const B = window.DPRunBuilder; B._state.session.prescription_mode = 'structured'; const h = document.getElementById('builder'); h.innerHTML = B.html(); B.bind(h); B.refresh(h); });
      await p.waitForSelector('[data-quick="intervals"]');
      assert.equal(await p.locator('[data-quick="text"]').count(), 0);
    } finally { await browser.close(); }
  });

  test('a lost create says Needs coach check, and Clear the block resets only that receipt', async () => {
    const { browser, p, errors } = await open(360, { garmin: { delivery: 'needs_check' }, legacyRun: TEXT });
    try {
      // The status card shows once there are steps: draft them first.
      await p.click('[data-act-global="convert"]');
      await p.click('[data-quick="text"]');
      await p.waitForSelector('.rb-delivery');
      assert.match(await p.textContent('.rb-delivery'), /Needs coach check\./);
      await p.click('[data-garmin-reset]');
      await p.waitForFunction(() => window.__posts.length === 1);
      assert.deepEqual(await p.evaluate(() => window.__posts), [{ action: 'garmin_receipt_reset', session_id: SID }]);
      assert.equal(await p.locator('[data-garmin-reset]').count(), 0, 'the block is gone once cleared');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test('unpublish warns about Garmin only when a receipt says it reached Garmin', async () => {
    for (const [garmin, expect] of [[{ delivery: 'none' }, false], [{ delivery: 'sent', scheduledDate: '2026-11-12', sentAt: '2026-11-06T00:00:00Z' }, true], [{ delivery: 'calendar_unconfirmed', scheduledDate: '2026-11-12' }, true]]) {
      const { browser, p } = await open(390, { garmin });
      try {
        const text = await p.evaluate(() => window.DPRunBuilder.garminWarning());
        assert.equal(/Garmin Connect calendar/.test(text), expect, JSON.stringify(garmin));
      } finally { await browser.close(); }
    }
  });
}
