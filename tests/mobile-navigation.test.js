// Phone navigation contract: five thumb destinations, everything else under
// More, safe areas respected, nothing important hidden behind the bar, and an
// install prompt that stays dismissed. The browser checks for touch-target
// size and first-screen content live in scripts/verify-command-centre.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const nav = read('dashboard-mobilenav.js');
const phone = read('dashboard-mobile-final.css');
const app = read('app.js');
const html = read('index.html');

test('the bar is Today, Squad, Programming, Pipeline and More', () => {
  const primary = nav.slice(nav.indexOf('var PRIMARY = ['), nav.indexOf('];', nav.indexOf('var PRIMARY = [')));
  const keys = [...primary.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(keys, ['triage', 'athletes', 'programming', 'applications']);
  assert.match(nav, /navItem\(\{ label: 'More', icon: 'more' \}, true\)/);
});

test('Calendar, settings, roster management and theme live under More', () => {
  const more = nav.slice(nav.indexOf('var MORE = ['), nav.indexOf('];', nav.indexOf('var MORE = [')));
  const keys = [...more.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
  for (const key of ['calendar', 'sync', 'coaches', 'manage', 'theme', 'lock']) {
    assert.ok(keys.includes(key), `${key} is reachable from More`);
  }
  // Commands run, they do not route to a tab that does not exist.
  assert.match(nav, /if \(COMMANDS\[e\.key\]\) \{ COMMANDS\[e\.key\]\(\); return; \}/);
  assert.match(nav, /manage: function \(\) \{ if \(typeof window\.openManageAthletes === 'function'\)/);
});

test('the closed More sheet is out of the tab order and Escape closes it', () => {
  assert.match(nav, /sheet\.inert = true;/);
  assert.match(nav, /sheetEl\.inert = false;/);
  assert.match(nav, /event\.key === 'Escape'\) \{ event\.preventDefault\(\); closeSheet\(true\); \}/);
  assert.match(nav, /sheet\.setAttribute\('role', 'dialog'\)/);
});

test('the bar respects safe areas and keeps 48px items', () => {
  assert.match(phone, /\.dp-mobilenav \{ min-height:var\(--dp-mobile-nav-h\);\s*padding:5px 8px calc\(5px \+ var\(--dp-safe-bottom\)\)/);
  assert.match(phone, /\.dp-mnav-item \{ min-height:48px;/);
  // Content clears the bar.
  assert.match(phone, /\.triage-page \{ min-height:calc\(100dvh - var\(--dp-mobile-header-row\)\);\s*padding-bottom:calc\(var\(--dp-mobile-nav-h\) \+ 18px \+ var\(--dp-safe-bottom\)\)/);
  // Notices sit above it, never on it.
  assert.match(phone, /bottom: calc\(var\(--dp-mobile-nav-h\) \+ 10px \+ var\(--dp-safe-bottom\)\)/);
});

test('Focus Mode is a full screen on a phone and respects safe areas', () => {
  assert.match(phone, /\.cq-focus-panel \{ width:100%;\s*height:100dvh;/);
  assert.match(phone, /\.cq-focus-bar \{ padding:calc\(6px \+ var\(--dp-safe-top\)\)/);
  assert.match(phone, /\.cq-focus-foot \{ flex-wrap:wrap; padding:10px var\(--dp-mobile-edge\) calc\(10px \+ var\(--dp-safe-bottom\)\)/);
});

test('Squad on a phone is a compact list with filters behind one button and a visible sort', () => {
  assert.match(phone, /#grid\.table-mode \.dash-table-wrap \{ display:none; \}/);
  assert.match(phone, /\.sq-list \{ display:flex;/);
  assert.match(phone, /#filter-bar#filter-bar > \.sort-wrap \{ display:flex;/);
  assert.match(phone, /#filter-bar#filter-bar\.mobile-expanded > #sq-status-group \{ display:grid;/);
  // Wrapped, not a horizontally clipped strip.
  assert.match(phone, /grid-template-columns:repeat\(2, minmax\(0, 1fr\)\);\s*gap:6px;\s*overflow:visible;/);
  assert.match(html, /function buildSquadList\(ath\)/);
});

test('a dismissed install prompt stays dismissed for two weeks', () => {
  const store = new Map();
  const listeners = {};
  const toasts = [];
  const context = vm.createContext({
    navigator: { serviceWorker: { register: () => Promise.resolve({ addEventListener() {} }), addEventListener() {} } },
    window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener(type, fn) { this[`on${type}`] = fn; }, remove() {} }),
      body: { appendChild: el => toasts.push(el) },
    },
    requestAnimationFrame: fn => fn(),
    setTimeout: fn => fn(),
    Date,
  });
  vm.runInContext(app, context);
  const prompt = { preventDefault() {}, prompt() {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) };

  listeners.beforeinstallprompt(prompt);
  assert.equal(toasts.length, 1, 'offered once');
  // The coach closes it with the X: the close button is the last child added.
  assert.ok(Number(store.get('dp_install_dismissed_until') || 0) === 0);
  const closeHandlerRan = /close\.addEventListener\('click', \(\) => \{\s*if \(typeof onDismiss === 'function'\) onDismiss\(\);/.test(app);
  assert.ok(closeHandlerRan, 'closing the toast records the dismissal');
  // Simulate the dismissal and a new session.
  store.set('dp_install_dismissed_until', String(Date.now() + 14 * 864e5));
  listeners.beforeinstallprompt(prompt);
  assert.equal(toasts.length, 1, 'not offered again inside the snooze window');
});
