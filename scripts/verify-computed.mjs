// Computed-style snapshot and diff, for cascade surgery.
//
// Phase 4.1 moves and rewrites CSS that hundreds of elements depend on. Tests
// cannot see a cascade regression and a screenshot only shows the part of the
// page that happens to be in frame, so this records what the browser actually
// resolved for every rendered element and diffs two runs.
//
//   node scripts/verify-computed.mjs --out before.json
//   ...make the change...
//   node scripts/verify-computed.mjs --out after.json
//   node scripts/verify-computed.mjs --diff before.json after.json
//
// Elements are keyed by a stable structural path rather than DOM order, so a
// diff points at "this card's padding changed", not "everything shifted by one".

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const BASE = process.env.PREVIEW_URL || 'http://localhost:4173';

// Properties that carry the design system. Deliberately not "all of them":
// resolved values like width drift with content and would bury real changes.
const PROPS = [
  'display', 'position', 'flexDirection', 'gridTemplateColumns', 'gap',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform',
  'color', 'backgroundColor', 'borderTopWidth', 'borderTopColor', 'borderTopLeftRadius',
  'minHeight', 'maxWidth', 'overflowX', 'overflowY', 'zIndex', 'opacity', 'visibility',
  'textAlign', 'whiteSpace', 'boxShadow', 'transform',
];

async function snapshot({ width, height, theme, states }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    try {
      sessionStorage.setItem('dp_dashboard_key', 'preview');
      sessionStorage.setItem('dp_dashboard_coach', 'KARL');
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(t => document.body.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(1400);

  const out = {};
  for (const state of states) {
    await page.evaluate(state.setup);
    await page.waitForTimeout(state.wait ?? 1100);
    out[state.name] = await page.evaluate(props => {
      // A path that survives re-renders: tag plus its class list plus the index
      // among siblings that share both. Ids are used verbatim where present.
      const pathOf = el => {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body && parts.length < 7) {
          if (node.id) { parts.unshift(`#${node.id}`); break; }
          const cls = (node.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
          const sig = node.tagName.toLowerCase() + (cls ? '.' + cls : '');
          const twins = [...(node.parentElement?.children || [])].filter(s => {
            const c = (s.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
            return s.tagName === node.tagName && c === cls;
          });
          parts.unshift(twins.length > 1 ? `${sig}[${twins.indexOf(node)}]` : sig);
          node = node.parentElement;
        }
        return parts.join('>');
      };

      const result = {};
      const seen = new Set();
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        // Only what is actually laid out. Hidden nodes resolve to defaults and
        // would add thousands of identical rows.
        if (rect.width === 0 && rect.height === 0) continue;
        let key = pathOf(el);
        if (seen.has(key)) {
          let n = 2;
          while (seen.has(`${key}~${n}`)) n += 1;
          key = `${key}~${n}`;
        }
        seen.add(key);
        const cs = getComputedStyle(el);
        const row = {};
        for (const p of props) row[p] = cs[p];
        row._box = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
        result[key] = row;
      }
      return result;
    }, PROPS);
  }

  const meta = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));

  await browser.close();
  return { meta, states: out, errors };
}

const STATES = [
  { name: 'today', setup: () => document.getElementById('tab-triage-btn')?.click() },
  { name: 'squad', setup: () => document.getElementById('tab-athletes-btn')?.click() },
  { name: 'calendar', setup: () => document.getElementById('tab-programming-btn')?.click() },
  { name: 'workspace', setup: () => { document.getElementById('tab-athletes-btn')?.click(); window.showFP('KAI'); }, wait: 1600 },
  { name: 'workspace-running', setup: () => window.switchAthleteTab('running'), wait: 1300 },
  { name: 'workspace-strength', setup: () => window.switchAthleteTab('strength'), wait: 1300 },
];

const VIEWS = [
  { key: 'mobile-dark', width: 390, height: 844, theme: 'dark' },
  { key: 'mobile-light', width: 390, height: 844, theme: 'light' },
  { key: 'desktop-dark', width: 1440, height: 900, theme: 'dark' },
  { key: 'desktop-light', width: 1440, height: 900, theme: 'light' },
];

if (arg('--diff')) {
  const before = JSON.parse(readFileSync(args[args.indexOf('--diff') + 1], 'utf8'));
  const after = JSON.parse(readFileSync(args[args.indexOf('--diff') + 2], 'utf8'));
  let changed = 0, gone = 0, added = 0, elements = 0;
  const byProp = {};
  const samples = [];

  for (const view of Object.keys(before.views)) {
    for (const state of Object.keys(before.views[view].states)) {
      const b = before.views[view].states[state];
      const a = after.views[view]?.states[state] || {};
      for (const key of Object.keys(b)) {
        elements += 1;
        if (!(key in a)) { gone += 1; if (samples.length < 400) samples.push({ kind: 'removed', view, state, key }); continue; }
        for (const prop of Object.keys(b[key])) {
          if (b[key][prop] !== a[key][prop]) {
            changed += 1;
            byProp[prop] = (byProp[prop] || 0) + 1;
            if (samples.length < 400) samples.push({ kind: 'changed', view, state, key, prop, from: b[key][prop], to: a[key][prop] });
          }
        }
      }
      for (const key of Object.keys(a)) if (!(key in b)) added += 1;
    }
  }

  console.log(`elements compared: ${elements}`);
  console.log(`declarations changed: ${changed}`);
  console.log(`elements only in before: ${gone}   only in after: ${added}`);
  for (const view of Object.keys(after.views)) {
    const m = after.views[view].meta, mb = before.views[view].meta;
    console.log(`  ${view}: overflow ${mb.horizontalOverflow} -> ${m.horizontalOverflow}, errors ${before.views[view].errors.length} -> ${after.views[view].errors.length}`);
  }
  if (changed) {
    console.log('\nchanged by property:');
    Object.entries(byProp).sort((x, y) => y[1] - x[1]).forEach(([p, n]) => console.log(`  ${String(n).padStart(5)}  ${p}`));
    console.log('\nsamples:');
    for (const s of samples.slice(0, Number(arg('--show') || 40))) {
      console.log(s.kind === 'changed'
        ? `  [${s.view}/${s.state}] ${s.key}\n      ${s.prop}: ${s.from}  ->  ${s.to}`
        : `  [${s.view}/${s.state}] REMOVED ${s.key}`);
    }
  }
  writeFileSync('/tmp/computed-diff.json', JSON.stringify({ changed, gone, added, byProp, samples }, null, 2));
  process.exit(0);
}

const views = {};
for (const v of VIEWS) {
  process.stderr.write(`snapshot ${v.key}...\n`);
  views[v.key] = await snapshot({ ...v, states: STATES });
}
const target = arg('--out') || '/tmp/computed.json';
writeFileSync(target, JSON.stringify({ views }, null, 2));
const total = Object.values(views).reduce(
  (n, v) => n + Object.values(v.states).reduce((m, s) => m + Object.keys(s).length, 0), 0);
console.error(`wrote ${target}: ${total} element snapshots across ${VIEWS.length} views`);
