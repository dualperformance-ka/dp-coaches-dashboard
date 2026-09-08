// The athlete portal records how a set felt, and writes it beside that set as
// its own pipe-separated chunk rather than inside it:
//
//   Seated Hamstring Curl: Set 1: 36kg × 10reps | Set 2: 40kg × 10reps
//     | Effort: too hard | Set 3: 29kg × 10reps
//
// "Effort: too hard" belongs to Set 2, which is why Set 3 drops to 29kg. The
// ledger split on the pipe and treated every chunk as a set, so the calibration
// became a set of its own with no weight or reps, and every real set after it
// was numbered one too high. A coach reading load progression saw wrong numbers.
//
// The seven spellings below are the ones actually in the database, counted
// across the live logs, including the parenthesised one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const index = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

function lift(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm');
  const at = index.search(re);
  assert.ok(at !== -1, `${name} must exist in index.html`);
  let depth = 0, end = at;
  for (let i = index.indexOf('{', at); i < index.length; i += 1) {
    if (index[i] === '{') depth += 1;
    else if (index[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  return index.slice(at, end);
}

const ctx = {
  esc: (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])),
  DP_ICON: () => '<svg></svg>',
  console,
};
vm.createContext(ctx);
vm.runInContext(`${lift('effortTone')}\n${lift('renderExerciseLog')}\nthis.tone = effortTone; this.render = renderExerciseLog;`, ctx);

const ALL_SPELLINGS = [
  'technical failure', 'more in tank', 'on target',
  'form broke', 'on target (at limit)', 'too easy', 'too hard',
];

test('every effort value the portal writes is recognised', () => {
  for (const value of ALL_SPELLINGS) {
    const tone = ctx.tone(value);
    assert.ok(['strain', 'headroom', 'ontarget'].includes(tone), `${value} -> ${tone}`);
  }
});

test('calibration is grouped by what the coach does about it', () => {
  assert.equal(ctx.tone('technical failure'), 'strain');
  assert.equal(ctx.tone('form broke'), 'strain');
  assert.equal(ctx.tone('too hard'), 'strain');
  assert.equal(ctx.tone('more in tank'), 'headroom');
  assert.equal(ctx.tone('too easy'), 'headroom');
  assert.equal(ctx.tone('on target'), 'ontarget');
  assert.equal(ctx.tone('on target (at limit)'), 'ontarget');
});

test('an effort chunk does not become a set, and does not shift the numbering', () => {
  // Verbatim shape from the live logs.
  const log = 'Seated Hamstring Curl: Set 1: 36kg × 10reps | Set 2: 40kg × 10reps | Effort: too hard | Set 3: 29kg × 10reps | Set 4: 29kg × 11reps';
  const html = ctx.render(log, false, null, null, null);
  const labels = [...html.matchAll(/<em class="wd-ext-setlbl">Set (\d+)<\/em>/g)].map(m => Number(m[1]));
  assert.deepEqual(labels, [1, 2, 3, 4], 'four logged sets must be numbered one to four');
  assert.doesNotMatch(html, /wd-ext-raw[^>]*>Effort:/, 'the calibration must not render as a bare set row');
});

test('the calibration is attached to the set it describes', () => {
  const log = 'Seated Hamstring Curl: Set 1: 36kg × 10reps | Set 2: 40kg × 10reps | Effort: too hard | Set 3: 29kg × 10reps';
  const html = ctx.render(log, false, null, null, null);
  // The tag has to sit inside the second set's row, not the first or third.
  const rows = html.split('wd-ext-row').slice(1);
  assert.equal(rows.length, 3, 'three rows for three sets');
  assert.doesNotMatch(rows[0], /wd-ext-effort/);
  assert.match(rows[1], /wd-ext-effort strain[^>]*>too hard</);
  assert.doesNotMatch(rows[2], /wd-ext-effort/);
});

test('every spelling survives a round trip through the ledger', () => {
  for (const value of ALL_SPELLINGS) {
    const log = `Back Squat: Set 1: 100kg × 5reps | Effort: ${value} | Set 2: 100kg × 5reps`;
    const html = ctx.render(log, false, null, null, null);
    const labels = [...html.matchAll(/<em class="wd-ext-setlbl">Set (\d+)<\/em>/g)].map(m => Number(m[1]));
    assert.deepEqual(labels, [1, 2], `${value}: numbering must stay 1,2`);
    assert.ok(html.includes(ctx.esc(value)), `${value}: must still be shown to the coach`);
  }
});

test('an exercise logged with nothing but a calibration is not counted as done', () => {
  // Guards the empty-detection, which reads every set having no weight or reps.
  const html = ctx.render('Back Squat: Set 1: —kg × — reps | Effort: too hard', false, null, null, null);
  assert.match(html, /Not done|wd-ext-missed/, 'a set with no load logged is not a completed set');
});

test('prescription steps are allowed to wrap', () => {
  // .wd-strava-stat is nowrap because it is built for "8.2km". Prescription
  // steps are sentences, and one 469px unbreakable line pushed the workspace
  // wider than the window, which slid Back to Squad off the left edge.
  assert.match(index, /\.wd-submitted-plan \.wd-strava-stat\{[^}]*white-space:normal/,
    'prescription steps must not inherit the stat chip nowrap');
});

test('the workspace cannot scroll sideways', () => {
  // .fp-topbar is sticky vertically only, so horizontal overflow drags the
  // Back to Squad button out of reach.
  assert.match(index, /#fp-overlay\{[^}]*overflow-x:clip/,
    'the athlete workspace must clip horizontal overflow');
});
