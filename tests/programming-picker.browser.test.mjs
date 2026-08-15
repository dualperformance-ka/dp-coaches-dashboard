// Browser test for the exercise picker's two entry points.
//
// The prescription builder and the dashboard's own New Split editor are pure
// DOM behaviour — no server call is involved in opening the library or writing
// a chosen name back — so a real browser is the only honest way to test them.
//
// Run: node --test tests/programming-picker.browser.test.mjs
// Skips silently if Playwright is not installed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  test('picker browser tests skipped (playwright not installed)', () => {});
}

const LIBRARY = {
  ok: true,
  categories: ['Chest', 'Back', 'Quads', 'Hamstrings'],
  results: [
    { id: 'e1', name: 'Barbell Bench Press', category: 'Chest', equipment: 'Barbell' },
    { id: 'e2', name: 'Cable Crossover', category: 'Chest', equipment: 'Cable' },
    { id: 'e3', name: 'Barbell Row', category: 'Back', equipment: 'Barbell' },
    { id: 'e4', name: 'Back Squat', category: 'Quads', equipment: 'Barbell' },
    { id: 'e5', name: 'Leg Extension', category: 'Quads', equipment: 'Machine' },
    { id: 'e6', name: 'Seated Hamstring Curl', category: 'Hamstrings', equipment: 'Machine' },
  ],
};

// A stand-in for the dashboard shell: the same ids and data attributes the real
// index.html uses, and nothing else.
function page(extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${readFileSync(join(root, 'public/programming.css'), 'utf8')}</style>
</head><body>
<div id="pw-ex-list">
  <div class="pw-ex-row">
    <input class="po-input" data-f="exercise" placeholder="Exercise name" value="">
    <input class="po-input" data-f="workingSets" value="3">
  </div>
</div>
${extra}
<script>
  window.__posts = [];
  window.maPost = async function (payload) { window.__posts.push(payload); return { ok: true, touched: ['s1'], appliedScope: 'session', note: '' }; };
  const LIB = ${JSON.stringify(LIBRARY)};
  window.fetch = async function (url) {
    if (String(url).includes('action=exercise_library')) {
      return { ok: true, status: 200, json: async () => LIB };
    }
    if (String(url).includes('action=prescription')) {
      return { ok: true, status: 200, json: async () => ({ ok: true,
        session: { id: 's1', athlete_code: 'ALEX', title: 'Lower C', planned_date: '2026-08-12',
                   week_label: 'Week 3', session_type: 'Strength', status: 'Planned',
                   publish_state: 'published', prescription_mode: 'structured', locked_at: null },
        exercises: [
          { id: 'x1', exercise_name: 'Leg Extension', position: 0, sets: 4, warmup_sets: 1,
            working_sets: 4, rep_min: 8, rep_max: 12, rest_seconds: 90, athlete_notes: 'First set warm-up' },
          { id: 'x2', exercise_name: 'Seated Hamstring Curl', position: 1, sets: 4, rep_min: 8, rep_max: 12 },
        ],
        runSteps: [], legacySplit: null }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
</script>
<script>${readFileSync(join(root, 'public/programming.js'), 'utf8')}</script>
</body></html>`;
}

// This container ships Chromium at a fixed path; the pinned Playwright build
// may expect a different revision directory, so point it explicitly.
const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function open() {
  const browser = await chromium.launch(
    existsSync(EXECUTABLE) ? { executablePath: EXECUTABLE } : {}
  );
  const p = await browser.newPage();
  p.setDefaultTimeout(5000);
  await p.setContent(page(), { waitUntil: 'load' });
  await p.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  return { browser, p };
}

if (chromium) {
  test('New Split editor: clicking the exercise field opens the library', async () => {
    const { browser, p } = await open();
    try {
      await p.click('#pw-ex-list [data-f="exercise"]');
      await p.waitForSelector('#rx-picker:not(.hidden)', { timeout: 3000 });

      assert.equal(await p.textContent('#rx-picker-title'), 'Choose exercise');

      const cats = await p.$$eval('.rx-cat span:first-child', (n) => n.map((e) => e.textContent));
      assert.deepEqual(cats, ['Chest', 'Back', 'Quads', 'Hamstrings'],
        'every muscle group is offered, in coaching order');

      const first = await p.$$eval('.rx-picker-row .rx-picker-name', (n) => n.map((e) => e.textContent));
      assert.deepEqual(first, ['Barbell Bench Press', 'Cable Crossover'],
        'opens on the first category');
    } finally { await browser.close(); }
  });

  test('New Split editor: choosing an exercise writes it into the field', async () => {
    const { browser, p } = await open();
    try {
      await p.click('#pw-ex-list [data-f="exercise"]');
      await p.waitForSelector('#rx-picker:not(.hidden)');
      await p.click('.rx-cat[data-cat="Quads"]');
      await p.click('.rx-picker-row[data-name="Back Squat"]');

      await p.waitForFunction(() => document.getElementById('rx-picker').classList.contains('hidden'));
      assert.equal(await p.inputValue('#pw-ex-list [data-f="exercise"]'), 'Back Squat');

      // No API call: the split editor saves on its own.
      assert.deepEqual(await p.evaluate(() => window.__posts), []);
    } finally { await browser.close(); }
  });

  test('New Split editor: switching category filters the list', async () => {
    const { browser, p } = await open();
    try {
      await p.click('#pw-ex-list [data-f="exercise"]');
      await p.waitForSelector('#rx-picker:not(.hidden)');
      await p.click('.rx-cat[data-cat="Back"]');
      const names = await p.$$eval('.rx-picker-row .rx-picker-name', (n) => n.map((e) => e.textContent));
      assert.deepEqual(names, ['Barbell Row']);
    } finally { await browser.close(); }
  });

  test('filter searches across every category, not just the open one', async () => {
    const { browser, p } = await open();
    try {
      await p.click('#pw-ex-list [data-f="exercise"]');
      await p.waitForSelector('#rx-picker:not(.hidden)');
      await p.fill('#rx-picker-search', 'barbell');
      await p.waitForSelector('.rx-picker-row[data-name="Barbell Row"]');
      const names = await p.$$eval('.rx-picker-row .rx-picker-name', (n) => n.map((e) => e.textContent));
      assert.deepEqual(names.sort(), ['Barbell Bench Press', 'Barbell Row'],
        'matches span Chest and Back');
    } finally { await browser.close(); }
  });

  test('an exercise not in the library can still be used', async () => {
    const { browser, p } = await open();
    try {
      await p.click('#pw-ex-list [data-f="exercise"]');
      await p.waitForSelector('#rx-picker:not(.hidden)');
      await p.fill('#rx-picker-search', 'Reverse Nordic');
      await p.waitForSelector('#rx-use-typed');
      await p.click('#rx-use-typed');
      assert.equal(await p.inputValue('#pw-ex-list [data-f="exercise"]'), 'Reverse Nordic');
    } finally { await browser.close(); }
  });

  test('prescription builder: clicking a name opens the library at that muscle group', async () => {
    const { browser, p } = await open();
    try {
      await p.evaluate(() => window.DP_PROGRAMMING.open('s1'));
      await p.waitForSelector('.rx-ex');

      // Name fields are chosen, not typed.
      assert.equal(await p.getAttribute('.rx-ex .rx-ex-name', 'readonly'), '');

      await p.click('.rx-ex[data-id="x1"] .rx-ex-name');
      await p.waitForSelector('#rx-picker:not(.hidden)');
      assert.equal(await p.textContent('#rx-picker-title'), 'Replace exercise');

      // Leg Extension is a Quads exercise, so Quads is the open category.
      assert.equal(await p.getAttribute('.rx-cat.is-active', 'data-cat'), 'Quads');
    } finally { await browser.close(); }
  });

  test('prescription builder: choosing a replacement posts the right action and scope', async () => {
    const { browser, p } = await open();
    try {
      await p.evaluate(() => window.DP_PROGRAMMING.open('s1'));
      await p.waitForSelector('.rx-ex');
      await p.click('.rx-ex[data-id="x1"] .rx-ex-name');
      await p.waitForSelector('#rx-picker:not(.hidden)');
      await p.click('.rx-picker-row[data-name="Back Squat"]');

      await p.waitForFunction(() => window.__posts.length > 0);
      const post = (await p.evaluate(() => window.__posts))[0];
      assert.equal(post.action, 'exercise_replace');
      assert.equal(post.exercise_id, 'x1');
      assert.equal(post.exercise_name, 'Back Squat');
      assert.equal(post.exercise_library_id, 'e4');
      assert.equal(post.scope, 'session', 'the safe default, not whatever was last used');
    } finally { await browser.close(); }
  });

  test('choosing a name does not loop the picker back open', async () => {
    // choose() refocuses the field; binding to focus rather than click would
    // reopen the picker forever.
    const { browser, p } = await open();
    try {
      await p.click('#pw-ex-list [data-f="exercise"]');
      await p.waitForSelector('#rx-picker:not(.hidden)');
      await p.click('.rx-picker-row[data-name="Cable Crossover"]');
      await p.waitForFunction(() => document.getElementById('rx-picker').classList.contains('hidden'));
      await p.waitForTimeout(250);
      assert.ok(await p.isHidden('#rx-picker'), 'picker stays closed');
    } finally { await browser.close(); }
  });

  test('the athlete preview never renders a coach note', async () => {
    const { browser, p } = await open();
    try {
      await p.evaluate(() => window.DP_PROGRAMMING.open('s1'));
      await p.waitForSelector('.rx-ex');
      await p.click('#rx-preview-btn');
      await p.waitForSelector('.rxp-list');
      const html = await p.innerHTML('#rx-body');
      assert.ok(!/coach/i.test(html), 'no coach-only content reaches the preview');
      assert.ok(html.includes('First set warm-up'), 'athlete notes do appear');
      assert.ok(await p.isHidden('#rx-scopebar'), 'coach controls are gone in preview');
    } finally { await browser.close(); }
  });
}
