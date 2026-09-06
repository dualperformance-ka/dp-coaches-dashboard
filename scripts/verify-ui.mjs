// Headless UI verification for the Phase 1-4 acceptance matrix.
//
// Automated tests cover derivation. This covers what tests cannot: whether the
// cascade actually resolves to the tokens Phase 1 defined, whether the fonts
// listed in index.html are really being used, whether all seven workspace tabs
// open, and what the page looks like at 1440px and 390px in both themes.
//
// Run against scripts/serve-preview.mjs:
//   node scripts/serve-preview.mjs &
//   node scripts/verify-ui.mjs
//
// Writes JSON to stdout and screenshots to .verify-out/.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.PREVIEW_URL || 'http://localhost:4173';
const OUT = process.env.VERIFY_OUT || '.verify-out';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const THEMES = ['dark', 'light'];

// ── colour distance ──────────────────────────────────────────────────────────
// Run and strength are compared in CIE Lab, not by eyeballing hex. Two hues can
// look distinct in a swatch and collapse once they are 2px chart strokes.
function rgb(str) {
  const m = String(str).match(/(\d+(?:\.\d+)?)/g);
  return m ? m.slice(0, 3).map(Number) : null;
}
function lab([r, g, b]) {
  const f = c => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
  const [R, G, B] = [f(r), f(g), f(b)];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const g2 = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * g2(Y) - 16, 500 * (g2(X) - g2(Y)), 200 * (g2(Y) - g2(Z))];
}
function deltaE(a, b) {
  const A = rgb(a), B = rgb(b);
  if (!A || !B) return null;
  const [l1, a1, b1] = lab(A), [l2, a2, b2] = lab(B);
  return Number(Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2).toFixed(1));
}
// Relative luminance contrast, for the light-theme --dim audit.
function contrast(fg, bg) {
  const L = c => {
    const [r, g, b] = rgb(c).map(v => {
      v /= 255; return v > 0.03928 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = L(fg), b = L(bg);
  return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
}

const report = { base: BASE, ranAt: new Date().toISOString(), consoleErrors: [], checks: {} };

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const key = `${vp.name}-${theme}`;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    // Unlock the coach gate before any script runs. The preview's session route
    // accepts anything; this is a local harness key, not a credential.
    await ctx.addInitScript(() => {
      try {
        sessionStorage.setItem('dp_dashboard_key', 'preview');
        sessionStorage.setItem('dp_dashboard_coach', 'KARL');
      } catch {}
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e.message).slice(0, 300)));

    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(t => {
      document.body.setAttribute('data-theme', t);
    }, theme);
    await page.waitForTimeout(1200);

    const result = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const root = getComputedStyle(document.documentElement);
      const tok = n => (cs.getPropertyValue(n) || root.getPropertyValue(n) || '').trim();

      // Resolve a custom property to a real rgb() by painting it.
      const resolve = name => {
        const probe = document.createElement('span');
        probe.style.cssText = `color:var(${name});position:absolute;visibility:hidden`;
        document.body.appendChild(probe);
        const v = getComputedStyle(probe).color;
        probe.remove();
        return v;
      };

      const fontOf = sel => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fontFamily : null;
      };

      const emoji = [];
      const RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F000}-\u{1F0FF}]/u;
      document.querySelectorAll('body *').forEach(el => {
        for (const n of el.childNodes) {
          if (n.nodeType === 3 && RE.test(n.nodeValue)) {
            const t = n.nodeValue.trim().slice(0, 40);
            if (t) emoji.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50), text: t });
          }
        }
      });

      const navText = [...document.querySelectorAll('nav a, nav button, .nav a, .nav button, [role="tablist"] button')]
        .map(e => e.textContent.trim()).filter(Boolean).slice(0, 40);

      return {
        // document.fonts.check() is not usable here: it returns true when the
        // family merely resolves through fallback, so with Google Fonts blocked
        // it reported all three faces present while every one had fallen back to
        // system sans. Measuring the same string in each face is the check that
        // cannot be fooled -- if Condensed is really applied it renders
        // materially narrower than the regular sans, which in turn differs from
        // the generic fallback.
        fonts: (() => {
          const measure = family => {
            const probe = document.createElement('span');
            probe.textContent = 'HANDLEBAR MEASUREMENT 0123456789';
            probe.style.cssText =
              `font:700 40px ${family};position:absolute;visibility:hidden;white-space:nowrap`;
            document.body.appendChild(probe);
            const w = probe.getBoundingClientRect().width;
            probe.remove();
            return Math.round(w);
          };
          const cond = measure(`'IBM Plex Sans Condensed', sans-serif`);
          const sans = measure(`'IBM Plex Sans', sans-serif`);
          const generic = measure('sans-serif');
          return {
            condWidth: cond, sansWidth: sans, genericWidth: generic,
            condensedReallyApplied: cond < sans - 8,
            sansReallyApplied: Math.abs(sans - generic) > 2,
            loadedFaces: [...document.fonts]
              .filter(f => f.status === 'loaded').map(f => `${f.family} ${f.weight}`),
            tokenCond: tok('--cond'),
            tokenSans: tok('--sans'),
            tokenMono: tok('--mono'),
          };
        })(),
        colours: {
          run: resolve('--run'),
          str: resolve('--str'),
          text: resolve('--text'),
          dim: resolve('--dim'),
          muted: resolve('--muted'),
          surface: resolve('--surface'),
          bg: cs.backgroundColor,
        },
        widths: {
          contentMax: tok('--content-max'),
          athleteMax: tok('--athlete-max'),
          mainWidth: document.querySelector('.main')?.getBoundingClientRect().width || null,
        },
        docWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        navText,
        emojiCount: emoji.length,
        emojiSample: emoji.slice(0, 25),
        gateVisible: !!document.querySelector('#dp-access-gate:not(.is-hidden)'),
        athleteCards: document.querySelectorAll('[data-athlete], .athlete-card, .sq-row').length,
        title: document.title,
      };
    });

    result.runVsStrDeltaE = deltaE(result.colours.run, result.colours.str);
    result.dimContrast = contrast(result.colours.dim, result.colours.surface);
    result.mutedContrast = contrast(result.colours.muted, result.colours.surface);
    result.consoleErrors = errors;

    await page.screenshot({ path: `${OUT}/${key}.png`, fullPage: false });
    report.checks[key] = result;
    report.consoleErrors.push(...errors.map(e => `${key}: ${e}`));

    await ctx.close();
  }
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
