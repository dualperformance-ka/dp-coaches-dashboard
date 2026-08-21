import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const themeCss = fs.readFileSync(new URL('../public/dashboard-theme-system.css', import.meta.url), 'utf8');

test('weight history follows the dashboard theme and keeps theme-safe graph colours', () => {
  assert.match(indexHtml, /--wh-surface:#111820/);
  assert.match(indexHtml, /--wh-run:#4f9abd;--wh-str:#79c3e8/);
  assert.match(indexHtml, /fill="var\(--wh-run\)"/);
  assert.match(indexHtml, /function setWHTheme\(t\)\s*\{\s*setTheme\(t\);\s*\}/s);
  assert.match(indexHtml, /syncWHTheme\(_dashTheme\)/);
  assert.match(indexHtml, /color: 'var\(--chart-weight\)'/);
  assert.match(themeCss, /#wh-overlay:not\(\.wh-light\) \.wh-section\s*\{[^}]*background:var\(--wh-surface\)/s);
  assert.match(themeCss, /#wh-overlay\.wh-light \.wh-section\s*\{[^}]*background:var\(--wh-surface\)/s);
  assert.match(themeCss, /--chart-weight: #e7f2f8/);
  assert.match(themeCss, /body\[data-theme="light"\][^{]*\{[\s\S]*?--chart-weight: #101d27/);
});
