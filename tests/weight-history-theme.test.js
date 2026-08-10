import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const themeCss = fs.readFileSync(new URL('../public/dashboard-theme-system.css', import.meta.url), 'utf8');

test('weight history dark mode is isolated from the dashboard light theme', () => {
  assert.match(indexHtml, /--wh-surface:#111820/);
  assert.match(indexHtml, /--wh-run:#4f9abd;--wh-str:#79c3e8/);
  assert.match(indexHtml, /fill="var\(--wh-run\)"/);
  assert.match(themeCss, /#wh-overlay:not\(\.wh-light\) \.wh-section\s*\{[^}]*background:var\(--wh-surface\)/s);
  assert.match(themeCss, /#wh-overlay\.wh-light \.wh-section\s*\{[^}]*background:var\(--wh-surface\)/s);
});
