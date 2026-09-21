// Duplicating a workout split so a coach can build a variant of one that
// already works. The hazard this feature walks into: splitsForAthlete() builds
// the session picker as a Map keyed by split NAME, so a copy that kept its
// source's name would not sit beside it — it would replace it, and
// splitForTitle() would then resolve logged sessions to whichever survived.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function src(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  // Walk the parameter list to its closing paren first: a destructured default
  // like ({ copy = false } = {}) puts braces before the body, and counting from
  // the first '{' would close the function early and silently slice nothing.
  let paren = 0;
  let i = html.indexOf('(', start);
  for (; i < html.length; i += 1) {
    if (html[i] === '(') paren += 1;
    if (html[i] === ')') { paren -= 1; if (!paren) break; }
  }
  const open = html.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < html.length; j += 1) {
    if (html[j] === '{') depth += 1;
    if (html[j] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, j + 1);
  }
  throw new Error(`could not extract ${name}`);
}

// ── The hazard, demonstrated against the real picker code ───────────────────
function pickerFor(splits, code) {
  const ctx = vm.createContext({ _splitsCache: splits });
  vm.runInContext(`${src('splitsForAthlete')}; out = splitsForAthlete(${JSON.stringify(code)});`, ctx);
  return ctx.out;
}

test('two splits sharing a name collapse to one in the picker', () => {
  const collided = pickerFor([
    { id: 'a', name: 'Upper A', athlete_code: null, exercises: [{ exercise: 'Row' }] },
    { id: 'b', name: 'Upper A', athlete_code: null, exercises: [{ exercise: 'Pec Dec' }] },
  ], 'KHANG');
  assert.equal(collided.length, 1, 'the second split displaces the first');
  assert.equal(collided[0].id, 'b', 'and the original is the one lost');
});

// ── So a copy is named uniquely, within its own audience ────────────────────
const nameCtx = () => {
  const ctx = vm.createContext({});
  vm.runInContext(src('_uniqueCopyName'), ctx);
  return ctx;
};
const unique = (base, taken) =>
  vm.runInContext(`_uniqueCopyName(${JSON.stringify(base)}, ${JSON.stringify(taken)})`, nameCtx());

test('a copy is named so it cannot displace its source', () => {
  assert.equal(unique('Upper A (3 days / wk)', ['Upper A (3 days / wk)']), 'Upper A (3 days / wk) copy');
  // Copying a copy counts up rather than stacking the word.
  assert.equal(unique('Upper A copy', ['Upper A', 'Upper A copy']), 'Upper A copy 2');
  assert.equal(unique('Upper A', ['Upper A', 'Upper A copy', 'Upper A copy 2']), 'Upper A copy 3');
  // Case is not a distinction the picker's Map would honour either way.
  assert.equal(unique('Upper A', ['upper a copy']), 'Upper A copy 2');
  assert.equal(unique('', []), 'Untitled copy');
});

test('a split only shares a namespace with its own audience', () => {
  const ctx = vm.createContext({ _splitsCache: [
    { id: 'a', name: 'Upper A', athlete_code: null },
    { id: 'b', name: 'Upper A', athlete_code: 'KHANG' },
    { id: 'c', name: 'Lower B', athlete_code: 'KHANG' },
  ] });
  vm.runInContext(src('_splitNamesInScope'), ctx);
  const inScope = (code, except) =>
    vm.runInContext(`_splitNamesInScope(${JSON.stringify(code)}, ${JSON.stringify(except)})`, ctx);
  assert.deepEqual(inScope(null, null), ['Upper A']);
  assert.deepEqual(inScope('KHANG', null), ['Upper A', 'Lower B']);
  // Renaming a split must not collide with itself.
  assert.deepEqual(inScope('KHANG', 'b'), ['Lower B']);
});

// ── And the save refuses a collision typed by hand ──────────────────────────
test('saveSplit refuses a name already used in the same audience', () => {
  const source = src('saveSplit');
  assert.match(source, /_splitNamesInScope\(athleteCode, _pwEditingId\)/);
  assert.match(source, /Two splits with one name replace each other/);
  // The guard must run before the write, not after it.
  assert.ok(source.indexOf('if (clash)') < source.indexOf('library_save'),
    'the collision check must precede the save');
});

// ── The copy is a new row, prefilled, and reads as unsaved ──────────────────
test('a duplicate inserts rather than overwriting its source', () => {
  for (const fn of ['duplicateSplit', 'duplicateSplitFromEditor', 'duplicateLibSession', 'duplicateLibFromEditor']) {
    assert.match(src(fn), /null, \{ copy: true \}/, `${fn} opens the editor with no id`);
    assert.match(src(fn), /_uniqueCopyName/, `${fn} renames the copy`);
  }
  // From the editor, the copy carries what is on screen, not the stored row.
  assert.match(src('duplicateSplitFromEditor'), /_collectSplitExercises\(\)/);
  assert.match(src('duplicateLibFromEditor'), /v\('pl-description'\)/);
});

test('an unsaved copy warns before it is thrown away', () => {
  for (const [fn, overlay] of [['_fillSplitEditor', 'pw-overlay'], ['_fillLibEditor', 'pl-overlay']]) {
    const source = src(fn);
    assert.match(source, new RegExp(`if \\(copy\\) _modalSnapshots\\['${overlay}'\\] = ''`),
      `${fn} leaves a copy dirty so closing it is challenged`);
    assert.match(source, /if \(copy\) name\.select\(\)/, `${fn} selects the name for renaming`);
  }
});

test('Duplicate and Archive are offered only on a saved record', () => {
  for (const [fn, id] of [['_fillSplitEditor', 'pw-duplicate'], ['_fillLibEditor', 'pl-duplicate']]) {
    assert.match(src(fn), new RegExp(`getElementById\\('${id}'\\)\\.style\\.display = editing \\? '' : 'none'`));
  }
  assert.match(html, /id="pw-duplicate"[^>]*onclick="duplicateSplitFromEditor\(\)"/);
  assert.match(html, /id="pl-duplicate"[^>]*onclick="duplicateLibFromEditor\(\)"/);
});

test('the card action does not also open the card it sits on', () => {
  const lib = src('renderPlanLibrary');
  assert.match(lib, /event\.stopPropagation\(\);duplicateSplit\('\$\{s\.id\}'\)/);
  assert.match(lib, /event\.stopPropagation\(\);duplicateLibSession\('\$\{l\.id\}'\)/);
  // Hover cannot be the only way to reach it.
  assert.match(html, /@media \(hover:none\)\{\.plan-lib-dup\{opacity:1\}\}/);
  assert.match(html, /\.plan-lib-card:hover \.plan-lib-dup,\.plan-lib-dup:focus-visible\{opacity:1\}/);
});

// ── Creating a split without going through the library ─────────────────────
// "+ Split" on the Programming toolbar opens the same editor the library's own
// + Split does. That makes a latent desync reachable: the save path showed the
// library without recording that it was open.

test('the toolbar offers + Split beside + Session', () => {
  const start = html.indexOf('id="plan-add-btn"');
  const row = html.slice(start, html.indexOf('</div>', start));
  assert.match(row, /id="plan-split-btn"[^>]*onclick="openSplitEditor\(null\)"/);
  // It sits between + Session and Library, not at the far end of the row.
  assert.ok(row.indexOf('plan-add-btn') < row.indexOf('plan-split-btn'));
  assert.ok(row.indexOf('plan-split-btn') < row.indexOf('plan-lib-btn'));
});

test('+ Split stands down on the squad board with the other athlete controls', () => {
  assert.match(src('renderProgramming'),
    /\['plan-copy-btn', 'plan-add-btn', 'plan-split-btn', 'plan-lib-btn'\]/);
});

test('showing the library after a save records that it is open', () => {
  // The bug: render without the flag, and the button reads "Library" while the
  // library is on screen, then the next renderProgramming() jumps to the grid.
  const show = src('showPlanLibrary');
  assert.match(show, /_planLibOpen = true/);
  assert.ok(show.indexOf('_planLibOpen = true') < show.indexOf('renderPlanLibrary()'),
    'the flag must be set before the render reads it');

  // Every save and archive path goes through it, so none can leave the two
  // out of step.
  for (const fn of ['saveSplit', 'archiveSplit', 'saveLibSession', 'archiveLibSession']) {
    assert.match(src(fn), /showPlanLibrary\(\)/, `${fn} uses the flag-setting path`);
    assert.doesNotMatch(src(fn), /[^w]renderPlanLibrary\(\)/, `${fn} does not render behind the flag`);
  }
});
