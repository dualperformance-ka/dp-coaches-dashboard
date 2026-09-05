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

// ── The shared design system must stay last, or the dashboard's earlier
//    layers win and the two apps stop matching. ──────────────────────────────
const styleLinks = [...index.matchAll(/<link[^>]+href="\/([\w.-]+\.css)/g)].map((m) => m[1]);
if (!styleLinks.includes('instrument.css')) {
  failures.push('instrument.css is not loaded — the dashboard would drift from the athlete portal');
} else if (styleLinks[styleLinks.length - 1] !== 'instrument.css') {
  failures.push(`instrument.css must load last; currently "${styleLinks[styleLinks.length - 1]}" does`);
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
if (process.argv.includes('--update-versions')) {
  writeFileSync(manifestPath, JSON.stringify(observed, null, 2) + '\n');
  console.log(`Recorded versions for ${Object.keys(observed).length} versioned assets.`);
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`Dashboard checks passed: ${apiFunctions.length}/${API_CEILING} functions, ${localAssets.length} referenced assets, ${loadedStyles.length} stylesheets, no direct browser DB access.`);
