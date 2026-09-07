// Phase 4 interface contract: icons, keyboard, focus and the cascade.
//
// These lock in decisions that are easy to undo by accident. Each assertion
// records why the rule exists, because "no emoji" and "one phone layer" are
// only obvious while you are holding the reasons in your head.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const read = f => readFileSync(join(PUBLIC, f), 'utf8');
const index = read('index.html');

// Strip line comments and the DM templates: neither is dashboard chrome.
const uiOnly = index
  .split('\n')
  .filter(line => !line.trim().startsWith('//'))
  .filter(line => !/lines\.push\(/.test(line))
  .join('\n');

const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}]/u;

test('no pictographic emoji is rendered into the dashboard interface', () => {
  // Emoji are drawn by the OS colour font: the same screen looked different on
  // a Mac, a phone and Windows, they sat off the text baseline, and a colour
  // pictogram beside monochrome UI reads as a prototype. dp-icons.js replaced
  // them with one 24x24 currentColor set.
  const offenders = uiOnly
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => PICTOGRAPHIC.test(line))
    // The pride theme button is the single deliberate exception: a monochrome
    // glyph cannot carry what that one means.
    .filter(([, line]) => !/pride-btn/.test(line));

  assert.deepEqual(
    offenders.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`),
    [],
    'use DP_ICON(name) instead of an emoji'
  );
});

test('the icon set is loaded before the code that calls it', () => {
  const iconScript = index.indexOf('/dp-icons.js');
  assert.ok(iconScript > -1, 'dp-icons.js must be loaded');
  // It defines window.DP_ICON synchronously; deferring it would leave every
  // render function calling an undefined global.
  const tag = index.slice(index.lastIndexOf('<script', iconScript), index.indexOf('>', iconScript) + 1);
  assert.doesNotMatch(tag, /\bdefer\b/, 'dp-icons.js must not be deferred');

  const icons = read('dp-icons.js');
  for (const name of [...index.matchAll(/DP_ICON\('([\w-]+)'/g)].map(m => m[1])) {
    assert.match(icons, new RegExp(`\\b${name}:`), `dp-icons.js is missing the "${name}" icon`);
  }
});

test('every icon inherits colour and size from its text', () => {
  const icons = read('dp-icons.js');
  assert.match(icons, /stroke="currentColor"/, 'an icon must take the colour of the text it sits in');
  assert.match(icons, /viewBox="0 0 24 24"/, 'one viewBox keeps stroke weight consistent');
  assert.match(icons, /aria-hidden="true"/, 'a decorative icon must not be announced');
  assert.match(index, /\.dp-icon\{/, 'the shared alignment rule must exist');
});

test('keyboard shortcuts never fire while the coach is typing', () => {
  // The failure this prevents: pressing "s" inside a coaching note navigating
  // to Squad and losing the note.
  const handler = index.slice(index.indexOf('// ── Keyboard workflow'), index.indexOf('// ── Settings menu'));
  assert.ok(handler.length > 500, 'the keyboard handler must exist');
  assert.match(handler, /if \(_isTyping\(\)\) return;/);
  assert.match(handler, /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey\) return;/);
  // And the palette owns the keyboard while open.
  assert.match(handler, /palette && !palette\.hidden/);

  for (const key of ['t', 's', 'c', 'p']) {
    assert.match(handler, new RegExp(`\\b${key}: \\{ id:`), `g-${key} must map to a destination`);
  }
  assert.match(handler, /\^\[1-7\]\$/, 'digits 1-7 must map to the workspace tabs');
  assert.match(handler, /key === 'r'/, 'r must resolve the focused queue row');
});

test('a keyboard user can skip the chrome and always see focus', () => {
  assert.match(index, /class="dp-skip-link" href="#tab-triage-content"/);
  assert.match(index, /\.dp-skip-link:focus\{transform:none/, 'the skip link must appear on focus');
  assert.match(index, /:focus-visible\{outline:2px solid var\(--brand\)/);
  assert.match(index, /id="dp-live-region"[^>]*aria-live="polite"/, 'shortcuts must announce what they did');
});

test('the phone layer stays the last stylesheet and stays phone-scoped', () => {
  // 559 !important existed only because three phone files loaded before five
  // other stylesheets and a media query adds nothing to specificity. One file,
  // loaded last, removed the need for almost all of them.
  const links = [...index.matchAll(/<link rel="stylesheet" href="\/([\w.-]+\.css)/g)].map(m => m[1]);
  assert.equal(links[links.length - 1], 'dashboard-mobile-final.css');
  assert.equal(links[links.length - 2], 'instrument.css');

  // One carve-out, and it is the reason this test was rewritten. The phone
  // layer owns two unscoped things: the --dp-* tokens its media blocks read
  // inside calc(), and the display:none that keeps the injected mobile nav off
  // every viewport the phone layer does not claim. Shipping without them put a
  // band of unstyled nav markup at the bottom of the desktop dashboard and
  // stripped the phone's content bottom padding. Anything else stays banned.
  const phone = read('dashboard-mobile-final.css').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0, start = 0, open = -1;
  const offenders = [];
  for (let i = 0; i < phone.length; i += 1) {
    if (phone[i] === '{') {
      if (depth === 0) {
        const sel = phone.slice(start, i).replace(/\s+/g, ' ').trim();
        if (sel && !/^@media\s*\(\s*max-width/.test(sel)) { open = i; offenders.push({ sel }); }
      }
      depth += 1;
    } else if (phone[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const last = offenders[offenders.length - 1];
        if (last && last.open === undefined && open > start) {
          last.body = phone.slice(open + 1, i);
          last.open = open;
        }
        start = i + 1;
      }
    }
  }
  const illegal = offenders.flatMap(r => (r.body || '')
    .split(';').map(d => d.trim()).filter(Boolean)
    .filter(d => !/^--dp-[\w-]+\s*:/.test(d) && !/^display\s*:\s*none$/.test(d))
    .map(d => `${r.sel} { ${d} }`));
  assert.deepEqual(illegal, [], 'an unscoped rule here would outrank the design system on desktop');
});

test('the injected mobile nav is hidden on every viewport the phone layer does not claim', () => {
  // dashboard-mobilenav.js appends .dp-mobilenav, .dp-sheet and
  // .dp-sheet-backdrop to document.body unconditionally, on every screen. The
  // phone layer switches them on inside @media (max-width: 720px). Something
  // unscoped therefore has to switch them off, or they render as plain blocks
  // in normal flow at the bottom of the desktop dashboard: oversized icons and
  // badge counts running into their labels, which is what reached production.
  const links = [...index.matchAll(/<link rel="stylesheet" href="\/([\w.-]+\.css)/g)].map(m => m[1]);
  const loaded = links.map(f => read(f).replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');

  const topLevel = [];
  let depth = 0, start = 0, open = -1, sel = '';
  for (let i = 0; i < loaded.length; i += 1) {
    if (loaded[i] === '{') {
      if (depth === 0) { sel = loaded.slice(start, i).replace(/\s+/g, ' ').trim(); open = i; }
      depth += 1;
    } else if (loaded[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        if (sel && !sel.startsWith('@')) topLevel.push({ sel, body: loaded.slice(open + 1, i) });
        start = i + 1;
      }
    }
  }

  for (const cls of ['.dp-mobilenav', '.dp-sheet', '.dp-sheet-backdrop']) {
    const hidden = topLevel.some(r =>
      r.sel.split(',').some(one => one.trim() === cls) &&
      /(^|;)\s*display\s*:\s*none\s*(!important)?\s*(;|$)/.test(r.body));
    assert.ok(hidden, `${cls} needs an unscoped display:none or it renders unstyled on desktop`);
  }

  // Same failure, silent half: an undefined custom property makes calc()
  // invalid at computed-value time and the browser drops the whole
  // declaration. That is how the phone lost its content bottom padding.
  //
  // This asserts only that every --dp-* token read inside calc() is declared
  // somewhere. A token declared inside @media (max-width: 720px) and read only
  // inside blocks at that width or narrower is legitimate, and several are;
  // check-portal.mjs does the width-aware version of this comparison. What is
  // never legitimate is a token declared nowhere at all, which is what shipped.
  const declared = new Set([...loaded.matchAll(/(--dp-[\w-]+)\s*:/g)].map(m => m[1]));
  const readInCalc = new Set([...loaded.matchAll(/calc\([^;{}]*var\(\s*(--dp-[\w-]+)/g)].map(m => m[1]));
  const missing = [...readInCalc].filter(t => !declared.has(t));
  assert.deepEqual(missing, [], 'these tokens are read inside calc() but declared nowhere');
});

test('!important stays far below where Phase 4 started', () => {
  const loaded = [...index.matchAll(/<link rel="stylesheet" href="\/([\w.-]+\.css)/g)].map(m => m[1]);
  const inline = [...index.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const all = loaded.map(read).join('\n') + inline;
  const count = (all.replace(/\/\*[\s\S]*?\*\//g, '').match(/!important/g) || []).length;

  // Baseline was 609 across the loaded stylesheets. The Phase 4 target is an
  // 80% cut; the ceiling here is deliberately a little above where the work
  // landed, so a small honest addition does not fail the build, but a slide
  // back toward override-driven CSS does.
  assert.ok(count <= 122, `!important is ${count}, above the 122 ceiling (baseline 609)`);
});

test('files that ship but are never loaded are not silently growing', () => {
  const loaded = new Set([...index.matchAll(/<link rel="stylesheet" href="\/([\w.-]+\.css)/g)].map(m => m[1]));
  const dead = readdirSync(PUBLIC).filter(f => f.endsWith('.css') && !loaded.has(f));
  // These four are known and are to be deleted in the GitHub UI, which a web
  // upload cannot do. The assertion is that the list does not get longer.
  assert.deepEqual(
    dead.sort(),
    ['dashboard-mobile-polish.css', 'dashboard-mobile.css', 'desktop.css', 'icons.css', 'styles.css'].sort(),
    `unexpected unloaded stylesheet: ${dead.join(', ')}`
  );
});
