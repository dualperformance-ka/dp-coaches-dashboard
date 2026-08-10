import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const publicDir = join(root, 'public');
const index = readFileSync(join(publicDir, 'index.html'), 'utf8');
const worker = readFileSync(join(publicDir, 'sw.js'), 'utf8');
const styles = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const nutrition = readFileSync(join(publicDir, 'js', '06-nutrition.js'), 'utf8');
const loginGoals = readFileSync(join(publicDir, 'js', '02-login-goals.js'), 'utf8');
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const failures = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const file of walk(join(root, 'api')).concat(walk(publicDir)).filter((file) => file.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`JavaScript syntax failed: ${file}\n${error.stderr || error.message}`);
  }
}

const localAssets = [...index.matchAll(/(?:src|href)="((?:\/)?[^:"#?]+(?:\?[^"#]+)?)"/g)]
  .map((match) => match[1].startsWith('/') ? match[1] : `/${match[1]}`)
  .filter((asset) => /\.(?:js|css)(?:\?|$)/.test(asset));
const cachedAssets = new Set([...worker.matchAll(/'([^']+)'/g)].map((match) => match[1]));

for (const asset of localAssets) {
  const path = join(publicDir, asset.split('?')[0]);
  if (!existsSync(path)) failures.push(`Missing referenced asset: ${asset}`);
  if (!cachedAssets.has(asset)) failures.push(`Service worker is missing current asset: ${asset}`);
}

// PWA cache boundary: only explicitly versioned code/style assets may bypass
// the network on launch. Navigations and config.js must continue through the
// network-first branch, while /api requests must remain outside SW handling.
for (const marker of [
  "url.pathname.startsWith('/api/')",
  "const isVersionedShellAsset = /\\.(?:css|js)$/",
  "url.searchParams.has('v')",
  "url.pathname === '/'",
]) {
  if (!worker.includes(marker)) failures.push(`Service worker caching boundary is missing: ${marker}`);
}
if (!/if \(isVersionedShellAsset\) \{[\s\S]*caches\.match\(request\)[\s\S]*return;[\s\S]*const isShell/.test(worker)) {
  failures.push('Versioned PWA shell assets must stay cache-first ahead of the remaining shell strategies');
}
if (!/request\.mode === 'navigate'[\s\S]*caches\.match\(cacheKey\)[\s\S]*cached \|\| networkResponse[\s\S]*const isShell/.test(worker)) {
  failures.push('Installed-PWA navigation must serve the cached HTML shell while revalidating it in the background');
}

const publicScripts = walk(publicDir).filter((file) => file.endsWith('.js'));
for (const file of publicScripts) {
  const source = readFileSync(file, 'utf8');
  if (/\bsbClient\s*\.\s*from\s*\(/.test(source)) {
    failures.push(`Direct browser database query remains: ${file}`);
  }
  if (/api\.cloudinary\.com/.test(source)) {
    failures.push(`Direct browser Cloudinary mutation remains: ${file}`);
  }
}

const rewrites = vercel.rewrites || [];
if (!rewrites.some((item) => item.source === '/api/portal-data' && item.destination === '/api/write?mode=portal')) {
  failures.push('Authenticated /api/portal-data rewrite is missing');
}

const apiFunctions = readdirSync(join(root, 'api')).filter((name) => name.endsWith('.js'));
if (apiFunctions.length > 12) failures.push(`Vercel function limit exceeded: ${apiFunctions.length}/12`);

if (!index.includes('accessibility.js?v=1')) failures.push('Accessibility runtime is not loaded');
if (!loginGoals.includes("portalRequest('bootstrap')") ||
    !loginGoals.includes('Combined portal bootstrap failed; using compatibility reads') ||
    !/await loadCloudData\(code,bootstrap\.state\);[\s\S]*await loadStructuredBodyData\(code,bootstrap\.bodyLogs\);[\s\S]*await loadSessionLogs\(bootstrap\.sessionLogs\);/.test(loginGoals)) {
  failures.push('Read-only startup bootstrap lost its ordered hydration or compatibility fallback');
}
if (!index.includes('aria-label="Previous training week"')) failures.push('Calendar controls need accessible names');
if (/id="(?:trainingKmCard|weeklyKmCard)"/.test(index)) {
  failures.push('The duplicate weekly target card has returned to the Training schedule');
}
for (const id of ['trainingVolumeStrip', 'weeklyVolumeStrip']) {
  if (!index.includes(`id="${id}"`)) failures.push(`Training volume strip mount is missing: ${id}`);
}
if (!index.includes('class="save-state-pill saved"')) {
  failures.push('Mobile sync confirmation should start in its quiet saved state');
}
const homePriorityIndex = index.indexOf('class="top-shell-priority week-card"');
const goalsPromptIndex = index.indexOf('id="goalsBanner"');
const trainingTabIndex = index.indexOf('id="tab-training"');
if (homePriorityIndex < 0 || goalsPromptIndex < homePriorityIndex ||
    (trainingTabIndex >= 0 && goalsPromptIndex > trainingTabIndex)) {
  failures.push('The first-login goals prompt must stay in the compact home priority card');
}
if (!styles.includes('.save-state-pill.saved{opacity:0;pointer-events:none}')) {
  failures.push('Successful mobile sync status should not float over portal content');
}
if (nutrition.includes('dp_vstrip_open') || !nutrition.includes('var open=!collapsible;')) {
  failures.push('Training volume should render collapsed by default');
}
const progressPhotoIndex = index.indexOf('class="card progress-card progress-photo-card progress-photo-priority"');
const progressBaselineIndex = index.indexOf('class="progress-baseline"');
const progressTrendIndex = index.indexOf('class="card progress-card progress-trend-card"');
if (progressPhotoIndex < 0 || progressBaselineIndex < 0 || progressTrendIndex < 0 ||
    !(progressPhotoIndex < progressBaselineIndex && progressBaselineIndex < progressTrendIndex)) {
  failures.push('Mobile Progress hierarchy must lead with current-week photos, then baseline and weight trend');
}
for (const id of ['photoCurrentAction', 'photoAngleStatuses', 'photoModalProgressFill', 'photoNextBtn', 'photoHistoryDetails']) {
  if (!index.includes(`id="${id}"`)) failures.push(`Adaptive progress photo control is missing: ${id}`);
}
if (!index.includes('progress-collapsible-card" id="pgVolumeCard"') ||
    !index.includes('id="pgWeightHistoryCard"')) {
  failures.push('Secondary Progress sections must remain available as mobile collapsible cards');
}
const training = readFileSync(join(publicDir, 'js', '08-training.js'), 'utf8');
for (const marker of ['_rowIndex', 'working-set-note', 'ns-warmup-map', 'Today’s progression target', 'Final working set: stay at ']) {
  if (!training.includes(marker) && !styles.includes(marker)) {
    failures.push(`Live strength progression guidance is missing: ${marker}`);
  }
}

const globalHeaders = (vercel.headers || []).find((entry) => entry.source === '/(.*)');
const csp = globalHeaders?.headers?.find((header) => header.key === 'Content-Security-Policy')?.value || '';
for (const directive of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"]) {
  if (!csp.includes(directive)) failures.push(`CSP is missing: ${directive}`);
}

for (const name of ['ingest.js', 'my-logs.js', 'progress-photos.js', 'reminders.js', 'strava.js', 'write.js']) {
  const source = readFileSync(join(root, 'api', name), 'utf8');
  if (!source.includes('getRequestAthlete')) failures.push(`Protected API lost its athlete auth boundary: api/${name}`);
}

// Stylesheet integrity. An unbalanced /* ... */ silently swallows every rule
// after it — the file still "loads", the page just quietly loses its styling
// from that point down. Cheap to check, expensive to debug.
for (const name of ['styles.css', 'desktop.css', 'icons.css']) {
  const source = readFileSync(join(root, 'public', name), 'utf8');
  const opens = (source.match(/\/\*/g) || []).length;
  const closes = (source.match(/\*\//g) || []).length;
  if (opens !== closes) {
    failures.push(`${name} has an unbalanced comment (${opens} "/*" vs ${closes} "*/"). Everything after the orphan is swallowed by the CSS parser.`);
  }
  // Brace balance, ignoring anything inside comments or quoted strings.
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

// Cache busting. Versioned CSS/JS and the HTML app shell are cache-first in the installed PWA, and the
// browser/CDN both key on the full URL — shipping an edited asset behind an
// unchanged ?v= would leave athletes on the old file. Two checks:
//   1. index.html and sw.js must agree on every version.
//   2. an asset whose contents changed must have had its version bumped,
//      verified against the content hashes in scripts/asset-versions.json.
// Run `node scripts/check-portal.mjs --update-versions` after a deliberate bump.
const shellVersions = [...index.matchAll(/(?:href|src)="\/?((?:js\/)?[\w.-]+\.(?:css|js))\?v=(\d+)"/g)];
for (const [, asset, version] of shellVersions) {
  if (!worker.includes(`${asset}?v=${version}`) && !worker.includes(`/${asset}?v=${version}`)) {
    failures.push(`Asset version drift: index.html requests ${asset}?v=${version} but the service worker shell does not list it. Bump both together.`);
  }
}

const manifestPath = join(root, 'scripts', 'asset-versions.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const observed = {};
for (const [, asset, version] of shellVersions) {
  const filePath = join(publicDir, asset);
  if (!existsSync(filePath)) continue;
  const sha = createHash('sha1').update(readFileSync(filePath)).digest('hex').slice(0, 12);
  observed[asset] = { version: Number(version), sha };
  const previous = manifest[asset];
  if (previous && previous.sha !== sha && previous.version === Number(version)) {
    failures.push(`${asset} changed but is still served as ?v=${version}. Browsers and the CDN key on the URL, so athletes will keep the old file — bump the version in index.html and sw.js, then run: node scripts/check-portal.mjs --update-versions`);
  }
}
if (process.argv.includes('--update-versions')) {
  writeFileSync(manifestPath, JSON.stringify(observed, null, 2) + '\n');
  console.log(`Recorded versions for ${Object.keys(observed).length} shell assets.`);
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`Portal checks passed: ${apiFunctions.length} functions, ${localAssets.length} shell assets, no direct browser DB access.`);
