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

test('running and strength stay separable in the theme that actually renders', () => {
  // This test used to read only the dark block of dashboard-redesign.css, and
  // that is precisely how the regression it exists to catch got through:
  // dashboard-theme-system.css loads later and redefined the light-theme pair as
  // #136d98 / #334d69, two blues 17.6 apart, so the mileage chart drew its run
  // bars and its strength line in one hue. The check now resolves the pair the
  // way a browser does -- last declaration in load order wins, per theme -- and
  // measures separation in CIE Lab rather than by hue, because two colours can
  // sit far apart in hue degrees and still be indistinguishable as 2px strokes.

  // Load order as declared in index.html. Anything appended later wins.
  const LOADED = [
    'dashboard-redesign.css', 'dashboard-detail-cleanup.css', 'dashboard-mobile.css',
    'dashboard-comprehensive.css', 'dashboard-theme-system.css', 'dashboard-desktop.css',
    'dashboard-mobile-polish.css', 'triage.css', 'programming.css',
    'weekly-sport-targets.css', 'daily-macro-overrides.css', 'instrument.css',
  ];

  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

  // Walk every rule block and keep the last --run/--str seen for each theme.
  // Blocks selecting [data-theme="light"] are light; :root and everything else
  // is the dark default. data-theme="pride" is a deliberate alternate and is
  // excluded: it overrides --str only, on purpose.
  const resolve = () => {
    const winner = { dark: {}, light: {} };
    const sources = [['index.html', html.slice(html.indexOf('<style>'))], ...LOADED.map(f => [f, read(f)])];
    for (const [file, raw] of sources) {
      const source = stripComments(raw);
      for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = block[1];
        const body = block[2];
        if (/data-theme="pride"/.test(selector)) continue;
        const theme = /data-theme="light"/.test(selector) ? 'light' : 'dark';
        for (const token of ['run', 'str']) {
          const hit = body.match(new RegExp(`--${token}\\s*:\\s*(#[0-9a-f]{3,8})`, 'i'));
          if (hit) winner[theme][token] = { value: hit[1].toLowerCase(), file };
        }
      }
    }
    return winner;
  };

  const srgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const lab = hex => {
    const f = c => { c /= 255; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
    const [R, G, B] = srgb(hex).map(f);
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const g = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * g(Y) - 16, 500 * (g(X) - g(Y)), 200 * (g(Y) - g(Z))];
  };
  const deltaE = (a, b) => {
    const [A, B] = [lab(a), lab(b)];
    return Math.sqrt(A.reduce((sum, v, i) => sum + (v - B[i]) ** 2, 0));
  };

  const winner = resolve();
  // 40 is well below the ~90 both themes now carry, and well above the 17.6 the
  // collapsed pair scored. It fails the bug without pinning the palette.
  const FLOOR = 40;

  for (const theme of ['dark', 'light']) {
    const run = winner[theme].run;
    const str = winner[theme].str;
    assert.ok(run && str, `${theme} theme must declare both --run and --str`);
    const separation = deltaE(run.value, str.value);
    assert.ok(
      separation > FLOOR,
      `${theme}: --run ${run.value} (${run.file}) and --str ${str.value} (${str.file}) ` +
      `are only ${separation.toFixed(1)} apart in CIE Lab; they read as one colour`
    );
  }

  // Run stays warm and strength stays cool in both themes, so the coding means
  // the same thing whichever theme a coach works in.
  const hue = hex => {
    const [r, g, b] = srgb(hex).map(v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const theme of ['dark', 'light']) {
    const runHue = hue(winner[theme].run.value);
    const strHue = hue(winner[theme].str.value);
    assert.ok(runHue < 70 || runHue > 330, `${theme}: --run should read warm, got hue ${Math.round(runHue)}`);
    assert.ok(strHue > 170 && strHue < 270, `${theme}: --str should read cool, got hue ${Math.round(strHue)}`);
  }
});

test('semantic ink meets WCAG AA against the surfaces it is used on', () => {
  // The dashboard's smallest text is its most important: adherence percentages,
  // review ages, session flags. Those use the semantic ink tokens, and in light
  // theme they were resolving to 3.97-4.46:1 against the tinted surfaces the
  // product actually paints, which put 19 text nodes under the 4.5 floor.
  //
  // This checks the tokens rather than rendered pixels, because a rendered check
  // needs a browser and this needs to fail in CI. The rendered check lives in
  // scripts/verify-ui.mjs, which composites the full background stack.

  const srgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const relative = hex => {
    const [r, g, b] = srgb(hex).map(v => {
      v /= 255;
      return v > 0.03928 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [relative(a), relative(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  // Resolve a token to its literal value for one theme, honouring load order and
  // one level of var() aliasing (--ok: var(--done), and so on).
  const LOADED = [
    'dashboard-redesign.css', 'dashboard-detail-cleanup.css',
    'dashboard-comprehensive.css', 'dashboard-theme-system.css',
    'dashboard-desktop.css', 'triage.css', 'programming.css',
    'weekly-sport-targets.css', 'daily-macro-overrides.css', 'instrument.css',
    'dashboard-mobile-final.css',
  ];
  const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sources = [['inline', strip(html.slice(html.indexOf('<style>')))],
    ...LOADED.map(f => [f, strip(read(f))])];

  const declared = { dark: {}, light: {} };
  for (const [file, css] of sources) {
    for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = block[1];
      if (/data-theme="pride"/.test(selector)) continue;
      // A phone-only block still declares the same token values.
      const theme = /data-theme="light"/.test(selector) ? 'light' : 'dark';
      for (const decl of block[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
        declared[theme][decl[1]] = { value: decl[2].trim(), file };
      }
    }
  }

  const resolve = (theme, name, depth = 0) => {
    const hit = declared[theme][name] || declared.dark[name];
    if (!hit || depth > 4) return null;
    const alias = hit.value.match(/^var\((--[\w-]+)/);
    if (alias) return resolve(theme, alias[1], depth + 1);
    const hex = hit.value.match(/#[0-9a-f]{6}\b/i);
    return hex ? { hex: hex[0], file: hit.file } : null;
  };

  // The grounds each theme actually paints text on.
  const SURFACES = {
    light: ['#ffffff', '#f4f2ed', '#edf3f7'],
    dark: ['#222120', '#2a2928', '#1a1918'],
  };

  const failures = [];
  for (const theme of ['light', 'dark']) {
    for (const token of ['--run', '--str', '--ok', '--warn', '--alert', '--brand-text']) {
      const ink = resolve(theme, token);
      if (!ink) continue;
      for (const surface of SURFACES[theme]) {
        const r = ratio(ink.hex, surface);
        if (r < 4.5) {
          failures.push(`${theme} ${token} ${ink.hex} (${ink.file}) on ${surface}: ${r.toFixed(2)}:1`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], 'semantic ink must clear 4.5:1 on every surface it is painted on');
});
