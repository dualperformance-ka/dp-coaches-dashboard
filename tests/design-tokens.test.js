import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const html = read('index.html');
const theme = read('dashboard-theme-system.css');
const instrument = read('instrument.css');
const redesign = read('dashboard-redesign.css');
const desktop = read('dashboard-desktop.css');

// index.html has always fetched IBM Plex, but the token contract named 'Geist',
// which has no @font-face anywhere in the repo. Every rule resolved to
// system-ui and the downloaded font files were discarded.

test('the token contract names only families the page actually fetches', () => {
  const fontLink = html.match(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?([^"]+)"/);
  assert.ok(fontLink, 'the Google Fonts link must exist');
  const families = [...fontLink[1].matchAll(/family=([^:&]+)/g)].map(m => m[1].replace(/\+/g, ' '));
  assert.deepEqual(
    families.sort(),
    ['IBM Plex Mono', 'IBM Plex Sans', 'IBM Plex Sans Condensed']
  );

  // Declarations only — comments are allowed to explain what the old value was.
  const stripComments = source => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const [name, source] of [['index.html', html], ['theme', theme], ['instrument', instrument]]) {
    assert.doesNotMatch(
      stripComments(source), /Geist/,
      `${name} names a face that is never loaded`
    );
  }
  for (const family of families) {
    assert.match(theme, new RegExp(`'${family}'`), `${family} must appear in the token contract`);
  }
});

test('the condensed display face survives the last stylesheet', () => {
  // instrument.css loads last and used to alias --cond back to --sans, which
  // silently cancelled the display face everywhere it was used.
  assert.match(theme, /--font-display: 'IBM Plex Sans Condensed'/);
  assert.match(instrument, /--cond:var\(--display\)/);
  assert.match(instrument, /--font-display:var\(--display\)/);
});

test('one token drives every desktop content width', () => {
  assert.match(theme, /--content-max: \d+px/);
  assert.match(theme, /--athlete-max: \d+px/);
  assert.match(html, /\.main\{[^}]*max-width:var\(--content-max/);
  assert.match(redesign, /\.main \{ max-width: var\(--content-max/);
  assert.match(desktop, /--desktop-max: var\(--content-max/);
  // No stylesheet may reintroduce a hard-coded competing width for .main.
  for (const [name, source] of [['index.html', html], ['redesign', redesign]]) {
    assert.doesNotMatch(source, /\.main\s*\{[^}]*max-width:\s*1[34]\d\dpx/, `${name} pins .main`);
  }
});

test('running and strength stay separable colours', () => {
  // Both were set to the readout blue, which collapsed the one piece of colour
  // coding a coach relies on when comparing the two halves of the programme.
  const dark = redesign.slice(redesign.indexOf('--run:'), redesign.indexOf('--ok:'));
  const run = dark.match(/--run:\s*(#[0-9a-f]{6})/i)?.[1];
  const str = dark.match(/--str:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(run && str, 'both tokens must be declared');
  assert.notEqual(run.toLowerCase(), str.toLowerCase());
  // Compare hues rather than exact values so a palette tweak does not fail here.
  const hue = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const gap = Math.abs(hue(run) - hue(str));
  assert.ok(Math.min(gap, 360 - gap) > 60, `run and strength hues are only ${Math.round(gap)}° apart`);
});
