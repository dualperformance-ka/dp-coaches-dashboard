// The athlete workspace header condenses once the coach scrolls into a panel.
//
// .fpa-sticky is position:sticky, so it still occupies its space in the
// scrolling flow: condensing it removes real height, everything below moves up,
// and Chrome re-anchors scrollTop by that same amount. With a single threshold
// for both directions that is a feedback loop, and it shipped: condensing at
// scrollTop 180 dropped the header 113px, anchoring put scrollTop at 67, 67 was
// under the threshold so the class came straight off, the header grew back,
// scrollTop returned to 180. Seven class flips in one wheel gesture, each one
// moving the page by the height of the header.
//
// These tests run the real threshold rule against a model of that anchoring, so
// a return to one threshold fails here rather than in a coach's hands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const index = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

// Lift the function out of the page and run it in a sandbox.
const start = index.search(/^function fpaCondenseThresholds\s*\(/m);
assert.ok(start !== -1, 'fpaCondenseThresholds must exist in index.html');
let depth = 0, end = start;
for (let i = index.indexOf('{', start); i < index.length; i += 1) {
  if (index[i] === '{') depth += 1;
  else if (index[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(index.slice(start, end) + '\nthis.f = fpaCondenseThresholds;', ctx);
const thresholds = ctx.f;

// Measured on the shipped layout: 113px on a 1440px desktop, 175px on a narrow
// window, 372px on a 390px phone where the vitals row is hidden outright.
const REAL_DROPS = [113, 175, 339, 372];

test('the two thresholds never sit on top of each other', () => {
  for (let drop = 0; drop <= 800; drop += 1) {
    const { condenseAt, expandAt } = thresholds(drop);
    assert.ok(expandAt < condenseAt, `drop ${drop}: expandAt ${expandAt} must be below condenseAt ${condenseAt}`);
  }
});

test('condensing never anchors the coach back above the expand threshold', () => {
  // This is the exact loop that shipped. Condensing removes `drop` pixels above
  // the viewport, so scrollTop lands at y - drop; if that is still under the
  // expand threshold the class comes straight back off.
  for (const drop of REAL_DROPS) {
    const { condenseAt, expandAt } = thresholds(drop);
    const landing = Math.max(0, condenseAt + 1 - drop);
    assert.ok(landing > expandAt,
      `drop ${drop}: condensing at ${condenseAt + 1} lands at ${landing}, which must stay above expandAt ${expandAt}`);
  }
});

test('expanding never anchors the coach back above the condense threshold', () => {
  // The mirror image: expanding adds the height back and pushes scrollTop down.
  for (const drop of REAL_DROPS) {
    const { condenseAt, expandAt } = thresholds(drop);
    const landing = expandAt + drop;
    assert.ok(landing <= condenseAt,
      `drop ${drop}: expanding at ${expandAt} lands at ${landing}, which must not exceed condenseAt ${condenseAt}`);
  }
});

// Models one wheel gesture. The detail that makes this bug what it is: the
// scrollTop the browser re-anchors after a toggle fires ANOTHER scroll event
// straight away, so the rule is re-evaluated on the new position without
// waiting for the next wheel step. That re-entrancy is the loop, and a model
// that only checks once per wheel step does not reproduce it.
function gesture({ decide, drop, maxScroll = 1600, downSteps = 30, upSteps = 34 }) {
  let y = 0, condensed = false, flips = 0;
  const settle = () => {
    for (let guard = 0; guard < 40; guard += 1) {
      const next = decide(y, condensed);
      if (next === condensed) return;
      condensed = next;
      flips += 1;
      y = Math.max(0, y + (next ? -drop : drop));
    }
    flips += 1000; // never settled
  };
  const step = (dy) => {
    y = Math.max(0, Math.min(condensed ? maxScroll - drop : maxScroll, y + dy));
    settle();
  };
  for (let i = 0; i < downSteps; i += 1) step(90);
  for (let i = 0; i < upSteps; i += 1) step(-90);
  return flips;
}

test('a full scroll down and back up toggles exactly twice', () => {
  for (const drop of REAL_DROPS) {
    const { condenseAt, expandAt } = thresholds(drop);
    const flips = gesture({
      drop,
      decide: (y, condensed) => (condensed ? y > expandAt : y > condenseAt),
    });
    assert.equal(flips, 2, `drop ${drop}: expected one condense and one expand, got ${flips} toggles`);
  }
});

test('the single-threshold version is what these tests would have caught', () => {
  // Guards the guard: run the shipped rule through the same model and confirm
  // it never settles, so a passing suite above means something.
  const flips = gesture({ drop: 113, decide: (y) => y > 140 });
  assert.ok(flips > 2, `the shipped rule should oscillate, got ${flips} toggles`);
});

test('the condensed header height is published rather than hardcoded', () => {
  // --fpa-sticky-h was a constant 140px while the real condensed header is
  // 153px on a desktop and 226px on a narrow window, so the sticky day labels
  // in the ledger slid up behind it. It is measured and written now.
  assert.match(index, /setProperty\('--fpa-sticky-h'/,
    'the handler must publish the measured height');
  assert.match(index, /getBoundingClientRect\(\)\.height/,
    'and it must come from a measurement');
});
