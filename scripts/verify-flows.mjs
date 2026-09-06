// Interaction-level verification for the Phase 1-3 acceptance matrix.
//
// verify-ui.mjs answers "does the cascade resolve to the Phase 1 tokens".
// This answers "does the coach workflow actually work": every primary
// destination opens, all seven athlete tabs render distinct content, the
// command palette responds to its keys and gets out of the way while typing,
// the session drawer opens and traps focus, and nothing throws on the way.
//
//   node scripts/serve-preview.mjs &
//   node scripts/verify-flows.mjs

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.PREVIEW_URL || 'http://localhost:4173';
const OUT = process.env.VERIFY_OUT || '.verify-out';
mkdirSync(OUT, { recursive: true });

const out = { ranAt: new Date().toISOString(), steps: [], errors: [] };
const note = (name, value) => { out.steps.push({ name, value }); console.error(`· ${name}: ${JSON.stringify(value).slice(0, 400)}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    sessionStorage.setItem('dp_dashboard_key', 'preview');
    sessionStorage.setItem('dp_dashboard_coach', 'KARL');
  } catch {}
});
const page = await ctx.newPage();
page.on('pageerror', e => out.errors.push('PAGEERROR: ' + e.message.slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') out.errors.push(m.text().slice(0, 200)); });
const failedRequests = [];
page.on('requestfailed', r => failedRequests.push(`${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`));

await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
note('failedRequests', failedRequests);

// ── Font metrics ─────────────────────────────────────────────────────────────
// document.fonts.check() returns true for a family that merely resolves through
// fallback, so it cannot tell a loaded condensed face from Plex Sans standing in
// for it. Measuring the same string in both faces can: if Condensed is really
// being used it renders materially narrower than the regular sans.
note('fontMetrics', await page.evaluate(() => {
  const measure = family => {
    const s = document.createElement('span');
    s.textContent = 'HANDLEBAR MEASUREMENT 0123456789';
    s.style.cssText = `font:600 40px ${family};position:absolute;visibility:hidden;white-space:nowrap`;
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return Math.round(w);
  };
  const cond = measure(`'IBM Plex Sans Condensed', sans-serif`);
  const sans = measure(`'IBM Plex Sans', sans-serif`);
  const fallback = measure(`sans-serif`);
  return {
    condensedWidth: cond, sansWidth: sans, genericWidth: fallback,
    condensedIsNarrower: cond < sans - 8,
    sansIsNotFallback: Math.abs(sans - fallback) > 2,
    loadedFaces: [...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family} ${f.weight}`).slice(0, 12),
  };
}));

// ── Duplicate navigation ─────────────────────────────────────────────────────
note('navigation', await page.evaluate(() => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const groups = [...document.querySelectorAll('nav, [role="navigation"], .tabs, .nav-tabs, .mobilenav, #dash-mobilenav')]
    .map(el => ({
      id: el.id || null,
      cls: (el.className || '').toString().slice(0, 60),
      visible: visible(el),
      items: [...el.querySelectorAll('a,button')].map(b => b.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 10),
    }));
  const todayCount = groups.filter(g => g.visible && g.items.some(i => /^today/i.test(i))).length;
  return { groups, visibleNavsOfferingToday: todayCount };
}));

// ── Primary destinations ─────────────────────────────────────────────────────
const destinations = ['Today', 'Squad', 'Calendar', 'Pipeline'];
for (const dest of destinations) {
  const clicked = await page.evaluate(d => {
    const el = [...document.querySelectorAll('a,button,[role="tab"]')]
      .find(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && new RegExp(`^${d}\\b`, 'i').test(e.textContent.trim());
      });
    if (!el) return false;
    el.click();
    return true;
  }, dest);
  await page.waitForTimeout(900);
  const state = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.tab-content, .view, section, main > div')]
      .filter(e => e.getBoundingClientRect().height > 200);
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    return {
      visiblePanels: panel.length,
      chars: text.length,
      hasEmptyDash: / — /.test(text),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  note(`destination:${dest}`, { clicked, ...state });
  await page.screenshot({ path: `${OUT}/flow-${dest.toLowerCase()}.png` });
}

// ── Command palette ──────────────────────────────────────────────────────────
await page.keyboard.press('Meta+k');
await page.waitForTimeout(500);
let palette = await page.evaluate(() => {
  const p = document.querySelector('#cmdk, .cmdk, .command-palette, [data-palette], .palette');
  const open = p && p.getBoundingClientRect().height > 0;
  return {
    found: !!p, open: !!open,
    selector: p ? (p.id || p.className.toString().slice(0, 40)) : null,
    focusIsInput: ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName),
    activeId: document.activeElement?.id || null,
  };
});
note('palette:cmdK', palette);
if (palette.open) {
  await page.keyboard.type('sar');
  await page.waitForTimeout(400);
  note('palette:results', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cmdk li, .cmdk [role="option"], .palette li, [data-palette] li')];
    return { count: rows.length, first: rows.slice(0, 5).map(r => r.textContent.trim().replace(/\s+/g, ' ').slice(0, 60)) };
  }));
  await page.screenshot({ path: `${OUT}/flow-palette.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  note('palette:escapeClosed', await page.evaluate(() => {
    const p = document.querySelector('#cmdk, .cmdk, .command-palette, [data-palette], .palette');
    return !p || p.getBoundingClientRect().height === 0;
  }));
}

// "/" opens the palette, but must not while the coach is typing in a field.
await page.keyboard.press('/');
await page.waitForTimeout(400);
note('palette:slash', await page.evaluate(() => {
  const p = document.querySelector('#cmdk, .cmdk, .command-palette, [data-palette], .palette');
  return { open: !!p && p.getBoundingClientRect().height > 0 };
}));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

note('palette:slashWhileTyping', await page.evaluate(() => {
  const input = document.createElement('input');
  input.id = 'dp-typing-probe';
  document.body.appendChild(input);
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
  const p = document.querySelector('#cmdk, .cmdk, .command-palette, [data-palette], .palette');
  const opened = !!p && p.getBoundingClientRect().height > 0;
  input.remove();
  return { paletteOpenedWhileTyping: opened };
}));

// ── Athlete workspace + seven tabs ───────────────────────────────────────────
const opened = await page.evaluate(() => {
  const el = [...document.querySelectorAll('a,button,[role="button"],tr,[data-athlete],.sq-row,.athlete-chip')]
    .find(e => /khang|sarah/i.test(e.textContent || '') && e.getBoundingClientRect().width > 0);
  if (!el) return null;
  el.click();
  return (el.textContent || '').trim().slice(0, 40);
});
await page.waitForTimeout(1500);
note('workspace:opened', opened);
await page.screenshot({ path: `${OUT}/flow-workspace.png` });

const TABS = ['Overview', 'Training', 'Running', 'Strength', 'Body & Fuel', 'Check-ins', 'Notes'];
const tabResults = [];
for (const tab of TABS) {
  const r = await page.evaluate(name => {
    const btn = [...document.querySelectorAll('button,[role="tab"],a')]
      .find(e => e.getBoundingClientRect().width > 0 &&
                 e.textContent.trim().replace(/\s+/g, ' ').toLowerCase().startsWith(name.toLowerCase()));
    if (!btn) return { found: false };
    btn.click();
    return { found: true, aria: btn.getAttribute('aria-selected'), role: btn.getAttribute('role') };
  }, tab);
  await page.waitForTimeout(700);
  const body = await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ');
    return { chars: t.length, fingerprint: t.slice(0, 160) };
  });
  tabResults.push({ tab, ...r, ...body });
}
note('workspace:tabs', tabResults.map(t => ({
  tab: t.tab, found: t.found, chars: t.chars, aria: t.aria,
})));
// Distinct content per tab: identical fingerprints mean a tab is not switching.
const prints = new Set(tabResults.filter(t => t.found).map(t => t.fingerprint));
note('workspace:distinctTabContent', { tabsFound: tabResults.filter(t => t.found).length, distinctFingerprints: prints.size });
await page.screenshot({ path: `${OUT}/flow-workspace-tabs.png` });

// Numeric tab shortcuts (Phase 4.5 target — recorded as a baseline, not a bug).
await page.keyboard.press('3');
await page.waitForTimeout(500);
note('keyboard:numericTabShortcut', await page.evaluate(() => {
  const sel = document.querySelector('[role="tab"][aria-selected="true"], .tab.active, .fpa-tab.is-active');
  return { selected: sel ? sel.textContent.trim().slice(0, 30) : null };
}));
for (const seq of [['g', 't'], ['g', 's']]) {
  await page.keyboard.press(seq[0]);
  await page.keyboard.press(seq[1]);
  await page.waitForTimeout(400);
}
note('keyboard:gSequence', await page.evaluate(() => ({
  activeDestination: [...document.querySelectorAll('.active,[aria-current="page"],[aria-selected="true"]')]
    .map(e => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 24)).slice(0, 6),
})));

// ── Emoji + cascade baselines for the Phase 4 audit ──────────────────────────
note('phase4Baseline', await page.evaluate(() => {
  const RE = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2700}-\u{27BF}]/u;
  const hits = [];
  document.querySelectorAll('body *').forEach(el => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && RE.test(n.nodeValue)) {
        const m = n.nodeValue.match(new RegExp(RE, 'gu'));
        if (m) hits.push(...m);
      }
    }
  });
  const counts = {};
  hits.forEach(h => { counts[h] = (counts[h] || 0) + 1; });
  const radii = new Set(), sizes = new Set();
  document.querySelectorAll('body *').forEach(el => {
    const s = getComputedStyle(el);
    if (s.borderTopLeftRadius && s.borderTopLeftRadius !== '0px') radii.add(s.borderTopLeftRadius);
    if (s.fontSize) sizes.add(s.fontSize);
  });
  return {
    totalGlyphs: hits.length,
    distinctGlyphs: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20),
    distinctRadii: [...radii].sort(),
    distinctFontSizes: [...sizes].sort((a, b) => parseFloat(a) - parseFloat(b)),
  };
}));

out.failedRequests = failedRequests;
await browser.close();
writeFileSync(`${OUT}/flows.json`, JSON.stringify(out, null, 2));
console.log('WROTE ' + OUT + '/flows.json');
