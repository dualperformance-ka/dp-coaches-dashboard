// Coaches dashboard pre-flight checks.
//
// This file used to be a verbatim copy of the athlete portal's script, carried
// over when this repo was forked. It asserted portal internals that do not
// exist here — training volume strips, progress photo controls, the goals
// prompt, the /api/portal-data rewrite — and failed 26 assertions on a clean
// checkout, which meant nobody could use it as a gate. Every check below is
// one that is true of THIS app and would catch a real regression.
//
// Deliberately NOT carried over from the portal:
//   * Service worker assertions. public/sw.js exists but is never registered
//     (no serviceWorker.register anywhere), so it is dead fork code and
//     asserting its cache strategy proves nothing.
//   * Portal DOM/layout assertions, for components this app does not have.
//   * The athlete-side auth helper. This is a coach tool; see AUTH below.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const publicDir = join(root, 'public');
const index = readFileSync(join(publicDir, 'index.html'), 'utf8');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const failures = [];

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// ── Syntax. A broken script takes the whole dashboard down on load. ──────────
const publicScripts = walk(publicDir).filter((file) => file.endsWith('.js'));
for (const file of publicScripts) {
  try {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`JavaScript syntax failed: ${file}\n${error.stderr || error.message}`);
  }
}

// ── Every asset index.html references must exist. ───────────────────────────
const localAssets = [...index.matchAll(/(?:src|href)="((?:\/)?[^:"#?]+(?:\?[^"#]+)?)"/g)]
  .map((match) => match[1])
  .filter((asset) => !asset.startsWith('//') && !asset.includes('${'));
for (const asset of localAssets) {
  const path = join(publicDir, asset.split('?')[0].replace(/^\//, ''));
  if (!existsSync(path)) failures.push(`Missing referenced asset: ${asset}`);
}

// ── The browser must never reach the database directly. Everything goes
//    through an authenticated server route holding the service key. ──────────
for (const file of publicScripts) {
  const source = readFileSync(file, 'utf8');
  if (/supabase[^\n]*\.from\(/.test(source)) {
    failures.push(`Direct browser database query remains: ${file}`);
  }
}

// ── AUTH. Every protected route must resolve its caller server-side. Coach
//    routes use requireCoach; athlete-facing ones use getRequestAthlete. The
//    old script demanded getRequestAthlete everywhere and so reported
//    progress-photos.js and write.js as broken when they are in fact held to
//    the stricter coach boundary. ─────────────────────────────────────────────
const PROTECTED_API = ['ingest.js', 'my-logs.js', 'progress-photos.js', 'reminders.js',
                       'strava.js', 'write.js', 'coach-data.js', 'actions.js', 'athletes.js'];
for (const name of PROTECTED_API) {
  const path = join(root, 'api', name);
  if (!existsSync(path)) { failures.push(`Protected API is missing: api/${name}`); continue; }
  const source = readFileSync(path, 'utf8');
  if (!source.includes('getRequestAthlete') && !source.includes('requireCoach')) {
    failures.push(`Protected API has no auth boundary (needs requireCoach or getRequestAthlete): api/${name}`);
  }
}

// ── Vercel function budget. Raise deliberately, not by accident. ────────────
const API_CEILING = 24;
const apiFunctions = readdirSync(join(root, 'api')).filter((name) => name.endsWith('.js'));
if (apiFunctions.length > API_CEILING) {
  failures.push(`Vercel function limit exceeded: ${apiFunctions.length}/${API_CEILING}`);
}

// ── Security headers. ───────────────────────────────────────────────────────
const globalHeaders = (vercel.headers || []).find((entry) => entry.source === '/(.*)');
const csp = globalHeaders?.headers?.find((header) => header.key === 'Content-Security-Policy')?.value || '';
for (const directive of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"]) {
  if (!csp.includes(directive)) failures.push(`CSP is missing: ${directive}`);
}

// ── Stylesheet integrity, for the sheets index.html actually loads. An
//    unbalanced /* ... */ silently swallows every rule after it: the file still
//    "loads", the page just quietly loses its styling from that point down. ───
const loadedStyles = [...new Set(localAssets
  .filter((asset) => asset.split('?')[0].endsWith('.css'))
  .map((asset) => asset.split('?')[0].replace(/^\//, '')))];
for (const name of loadedStyles) {
  const path = join(publicDir, name);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, 'utf8');
  const opens = (source.match(/\/\*/g) || []).length;
  const closes = (source.match(/\*\//g) || []).length;
  if (opens !== closes) {
    failures.push(`${name} has an unbalanced comment (${opens} "/*" vs ${closes} "*/"). Everything after the orphan is swallowed.`);
  }
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) failures.push(`${name} has unbalanced braces (depth ${depth} at end of file).`);
}

// ── The shared design system must stay last among the unscoped layers, or the
//    dashboard's earlier layers win and the two apps stop matching.
//
//    One exception, and only one: a stylesheet whose every rule is inside a
//    phone media query. The rule here protects instrument.css from being
//    overridden on the screens both apps share, and a file that cannot apply
//    above 720px cannot do that. dashboard-mobile-final.css is allowed after it
//    for exactly that reason, and it is what let 529 !important come out of the
//    phone layer: those rules only needed the flag because they loaded before
//    instrument.css and a media query adds nothing to specificity.
//
//    The allowance is verified, not asserted. Any file listed after
//    instrument.css is read, and every top-level block in it must be a
//    max-width media query. The moment someone adds an unscoped rule to such a
//    file it fails here rather than silently outranking the design system.
//
//    One narrow carve-out, because the phone layer genuinely owns two unscoped
//    things and shipping without them broke production: the --dp-* tokens it
//    reads inside calc(), and the display:none that keeps the injected mobile
//    nav and More sheet off every viewport the phone layer does not claim. A
//    top-level block may therefore declare ONLY custom properties named --dp-*
//    or the single declaration display:none. Anything else still fails. ───────
const styleLinks = [...index.matchAll(/<link[^>]+href="\/([\w.-]+\.css)/g)].map((m) => m[1]);
if (!styleLinks.includes('instrument.css')) {
  failures.push('instrument.css is not loaded — the dashboard would drift from the athlete portal');
} else {
  const after = styleLinks.slice(styleLinks.indexOf('instrument.css') + 1);
  for (const name of after) {
    let css;
    try {
      css = readFileSync(join(publicDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    } catch {
      failures.push(`${name} loads after instrument.css but could not be read`);
      continue;
    }
    // Walk top-level blocks; anything not scoped to a phone width outranks the
    // shared design system on desktop, which is the thing this check exists for.
    let depth = 0, selector = '', start = 0;
    const offenders = [];
    for (let i = 0; i < css.length; i += 1) {
      const ch = css[i];
      if (ch === '{') {
        if (depth === 0) selector = css.slice(start, i).replace(/\s+/g, ' ').trim();
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          if (selector && !/^@media\s*\(\s*max-width\s*:\s*\d+px\s*\)$/.test(selector)) {
            // The carve-out: --dp-* tokens and display:none, nothing else.
            const body = css.slice(css.indexOf('{', start) + 1, i);
            const bad = body.split(';').map((d) => d.trim()).filter(Boolean)
              .filter((d) => !/^--dp-[\w-]+\s*:/.test(d) && !/^display\s*:\s*none$/.test(d));
            if (bad.length) offenders.push(`${selector.slice(0, 44)} { ${bad[0].slice(0, 40)} }`);
          }
          start = i + 1;
        }
      }
    }
    if (offenders.length) {
      failures.push(
        `${name} loads after instrument.css but ${offenders.length} of its blocks are not phone-scoped ` +
        `(e.g. "${offenders[0]}"). Only max-width media queries may follow the design system.`
      );
    }
  }
}

// ── The mobile nav's base contract.
//
//    dashboard-mobilenav.js appends .dp-mobilenav, .dp-sheet and
//    .dp-sheet-backdrop to document.body on EVERY viewport; the phone layer
//    switches them on inside a media query. So an unscoped display:none has to
//    exist somewhere, or the bar and the sheet render unstyled in normal flow
//    on desktop. That is exactly what shipped once, when the phone files were
//    consolidated and only their @media blocks were carried across.
//
//    The same consolidation dropped the top-level --dp-* tokens those media
//    blocks read inside calc(). An undefined custom property makes calc()
//    invalid at computed-value time and the browser discards the whole
//    declaration, silently, so the phone lost its content bottom padding and
//    content scrolled under the fixed bar. Neither failure is visible to a
//    test that only asserts a rule exists somewhere in the file.
//
//    Both are checked here against the top-level cascade only. ───────────────
{
  const loadedCss = styleLinks
    .map((name) => {
      try { return readFileSync(join(publicDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); }
      catch { return ''; }
    })
    .join('\n');

  // Depth-0 blocks: what actually applies with no media query in play.
  const topLevel = [];
  {
    let depth = 0, selector = '', start = 0, open = -1;
    for (let i = 0; i < loadedCss.length; i += 1) {
      const ch = loadedCss[i];
      if (ch === '{') {
        if (depth === 0) { selector = loadedCss.slice(start, i).replace(/\s+/g, ' ').trim(); open = i; }
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          if (selector && !selector.startsWith('@')) {
            topLevel.push({ selector, body: loadedCss.slice(open + 1, i) });
          }
          start = i + 1;
        }
      }
    }
  }

  for (const cls of ['.dp-mobilenav', '.dp-sheet', '.dp-sheet-backdrop']) {
    const hidden = topLevel.some((r) =>
      r.selector.split(',').some((sel) => sel.trim() === cls) &&
      /(^|;)\s*display\s*:\s*none\s*(!important)?\s*(;|$)/.test(r.body));
    if (!hidden) {
      failures.push(
        `${cls} has no unscoped display:none in the loaded stylesheets. ` +
        `dashboard-mobilenav.js injects it on every viewport, so it will render ` +
        `unstyled at the bottom of the desktop dashboard.`
      );
    }
  }

  // --dp-* tokens, scope-aware. A token only has to be declared somewhere at
  // least as wide as every place it is read: declared at top level it covers
  // everything, declared inside max-width:720px it covers the 380px block but
  // not the other way round. Undeclared entirely is the failure that shipped.
  const widthOf = (cond) => {
    const m = /max-width\s*:\s*(\d+)px/.exec(cond);
    return m ? Number(m[1]) : Infinity;
  };
  const declared = new Map(), consumed = new Map();
  {
    const media = [];
    let i = 0, start = 0;
    while (i < loadedCss.length) {
      const ch = loadedCss[i];
      if (ch === '{') {
        const head = loadedCss.slice(start, i).trim();
        if (head.startsWith('@')) {
          media.push(head.startsWith('@media') ? widthOf(head) : Infinity);
          start = i + 1;
        } else {
          let d = 1, j = i + 1;
          while (d && j < loadedCss.length) {
            if (loadedCss[j] === '{') d += 1;
            else if (loadedCss[j] === '}') d -= 1;
            j += 1;
          }
          const body = loadedCss.slice(i + 1, j - 1);
          const scope = media.length ? Math.min(...media) : Infinity;
          const push = (map, k) => map.set(k, (map.get(k) || new Set()).add(scope));
          for (const m of body.matchAll(/(--dp-[\w-]+)\s*:/g)) push(declared, m[1]);
          for (const m of body.matchAll(/var\(\s*(--dp-[\w-]+)/g)) push(consumed, m[1]);
          i = j; start = i;
          continue;
        }
      } else if (ch === '}') {
        media.pop();
        start = i + 1;
      }
      i += 1;
    }
  }
  const unreachable = [...consumed].filter(([token, uses]) => {
    const decls = declared.get(token);
    return !decls || [...uses].some((u) => ![...decls].some((d) => d >= u));
  }).map(([token]) => token);
  if (unreachable.length) {
    failures.push(
      `${unreachable.length} --dp-* token(s) are read by var() where nothing declares them ` +
      `(${unreachable.slice(0, 4).join(', ')}). Inside calc() an undefined token voids the whole ` +
      `declaration, so the rule disappears with no error.`
    );
  }
}

// ── The coach gate is injected at runtime by coach-auth.js, which must stay
//    loaded and must still build the gate. Losing either would expose the
//    dashboard shell to anyone who opens the URL. ─────────────────────────────
if (!index.includes('/coach-auth.js')) {
  failures.push('coach-auth.js is not loaded — the dashboard would render ungated');
}
const coachAuth = existsSync(join(publicDir, 'coach-auth.js'))
  ? readFileSync(join(publicDir, 'coach-auth.js'), 'utf8') : '';
if (!coachAuth.includes('id="dp-access-gate"')) {
  failures.push('coach-auth.js no longer builds the access gate');
}

// ── Cache busting. Browser and CDN key on the full URL, so an edited asset
//    behind an unchanged ?v= keeps serving the old file. Run
//    `node scripts/check-portal.mjs --update-versions` after a deliberate bump.
const shellVersions = [...index.matchAll(/(?:href|src)="\/?((?:js\/)?[\w.-]+\.(?:css|js))\?v=([\w.-]+)"/g)];
const manifestPath = join(root, 'scripts', 'asset-versions.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const observed = {};
for (const [, asset, version] of shellVersions) {
  const filePath = join(publicDir, asset);
  if (!existsSync(filePath)) continue;
  const sha = createHash('sha1').update(readFileSync(filePath)).digest('hex').slice(0, 12);
  observed[asset] = { version, sha };
  const previous = manifest[asset];
  if (previous && previous.sha !== sha && String(previous.version) === String(version)) {
    failures.push(`${asset} changed but is still served as ?v=${version}. Bump it in index.html, then run --update-versions.`);
  }
}
// ── The service worker precaches SHELL_ASSETS by exact URL, query string
//    included. If index.html asks for dashboard-mobile-final.css?v=20260907-34
//    while SHELL_ASSETS still lists ?v=20260906-31, the worker warms a URL
//    nothing requests and the file the page actually needs is not in the shell
//    cache at all. Nothing errors: it just quietly stops being offline-ready,
//    and the bumped VERSION makes it look like the bump was done properly.
//    Bumping an asset means bumping it in BOTH files. ────────────────────────
{
  const sw = existsSync(join(publicDir, 'sw.js'))
    ? readFileSync(join(publicDir, 'sw.js'), 'utf8') : '';
  const shellWants = Object.fromEntries(
    [...index.matchAll(/(?:href|src)="\/?((?:js\/)?[\w.-]+\.(?:css|js))\?v=([\w.-]+)"/g)]
      .map(m => [m[1], m[2]]));
  const drift = [...sw.matchAll(/'\/((?:js\/)?[\w.-]+\.(?:css|js))\?v=([\w.-]+)'/g)]
    .filter(([, asset, version]) => shellWants[asset] && shellWants[asset] !== version)
    .map(([, asset, version]) => `${asset}: sw.js has ?v=${version}, index.html asks for ?v=${shellWants[asset]}`);
  if (drift.length) {
    failures.push(
      `${drift.length} asset(s) are versioned differently in sw.js and index.html:\n  ` +
      drift.join('\n  ') +
      `\nThe service worker would precache a URL the page never requests.`
    );
  }
}

if (process.argv.includes('--update-versions')) {
  writeFileSync(manifestPath, JSON.stringify(observed, null, 2) + '\n');
  console.log(`Recorded versions for ${Object.keys(observed).length} versioned assets.`);
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`Dashboard checks passed: ${apiFunctions.length}/${API_CEILING} functions, ${localAssets.length} referenced assets, ${loadedStyles.length} stylesheets, no direct browser DB access.`);
