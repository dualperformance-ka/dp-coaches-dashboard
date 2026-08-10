import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('athlete and programme week remain visible in a sticky context banner', () => {
  assert.match(html, /\.week-jump\{[^}]*position:sticky;[^}]*top:58px/);
  assert.match(html, /class="week-jump-athlete">\$\{esc\(a\.id\)\}/);
  assert.match(html, /Current programme week/);
  assert.match(html, /Current: \$\{esc\(currentWeekLabel\)\}/);
});
