// Phase 4.1 cascade audit.
//
// Reads only the stylesheets index.html actually loads, in load order, plus its
// inline <style>. Files that ship in public/ but are never linked are reported
// separately: counting them inflates every number and hides where the real work
// is. The documented "~458 !important" was such a number.
//
//   node scripts/audit-css.mjs            summary
//   node scripts/audit-css.mjs --full     every offending selector
//   node scripts/audit-css.mjs --json     machine-readable, for regression gates

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const FULL = process.argv.includes('--full');
const JSON_OUT = process.argv.includes('--json');

// ── Which files actually load, in order ──────────────────────────────────────
const loaded = [...html.matchAll(/<link rel="stylesheet" href="\/([^"?]+)/g)].map(m => m[1]);
const onDisk = readdirSync(PUBLIC).filter(f => f.endsWith('.css'));
const dead = onDisk.filter(f => !loaded.includes(f));

const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

const sources = [
  ...[...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m, i) => ({
    file: `index.html <style> #${i + 1}`, css: stripComments(m[1]),
  })),
  ...loaded.map(f => ({ file: f, css: stripComments(readFileSync(join(PUBLIC, f), 'utf8')) })),
];

// ── Rule walker ──────────────────────────────────────────────────────────────
// Deliberately simple: split on braces rather than parsing CSS properly. It is
// accurate for counting declarations and selectors, which is all this needs, and
// it cannot break on a stylesheet it does not understand.
function rules(css) {
  const out = [];
  let depth = 0, buf = '', selector = '';
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (c === '{') {
      depth += 1;
      if (depth === 1) { selector = buf.trim(); buf = ''; continue; }
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        if (!/^@(media|supports|layer)/.test(selector)) out.push({ selector, body: buf });
        else out.push(...rules(buf).map(r => ({ ...r, at: selector })));
        buf = ''; selector = '';
        continue;
      }
    }
    buf += c;
  }
  return out;
}

// CSS specificity as (id, class/attr/pseudo-class, element/pseudo-element).
function specificity(sel) {
  const s = sel.replace(/::?[a-z-]+\([^)]*\)/gi, m => m).trim();
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
  const elements = (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids, classes, elements];
}
const specScore = ([a, b, c]) => a * 10000 + b * 100 + c;

const report = {
  loadedStylesheets: loaded,
  deadStylesheets: dead.map(f => ({
    file: f,
    important: (readFileSync(join(PUBLIC, f), 'utf8').match(/!important/g) || []).length,
    lines: readFileSync(join(PUBLIC, f), 'utf8').split('\n').length,
  })),
  important: { total: 0, byFile: {}, byProperty: {}, worstSelectors: [] },
  inventory: { colours: {}, radii: {}, fontSizes: {}, spacing: {}, zIndex: {}, transitions: {} },
  selectors: { total: 0, bySpecificity: {}, duplicatedAcrossFiles: [] },
  emojiInCss: [],
};

const selectorOwners = new Map();
const importantRows = [];

for (const { file, css } of sources) {
  let fileCount = 0;
  for (const rule of rules(css)) {
    report.selectors.total += 1;

    for (const sel of rule.selector.split(',').map(x => x.trim()).filter(Boolean)) {
      const key = sel.replace(/\s+/g, ' ');
      if (!selectorOwners.has(key)) selectorOwners.set(key, new Set());
      selectorOwners.get(key).add(file);
      const bucket = specificity(sel).join('-');
      report.selectors.bySpecificity[bucket] = (report.selectors.bySpecificity[bucket] || 0) + 1;
    }

    for (const decl of rule.body.split(';')) {
      const m = decl.match(/^\s*([-\w]+)\s*:\s*([^;]+)$/);
      if (!m) continue;
      const [, prop, rawValue] = m;
      const value = rawValue.trim();

      if (/!important/.test(value)) {
        fileCount += 1;
        report.important.total += 1;
        report.important.byProperty[prop] = (report.important.byProperty[prop] || 0) + 1;
        importantRows.push({
          file, selector: rule.selector.replace(/\s+/g, ' ').slice(0, 110),
          prop, at: rule.at || null, spec: specScore(specificity(rule.selector.split(',')[0])),
        });
      }

      const add = (group, v) => {
        report.inventory[group][v] = (report.inventory[group][v] || 0) + 1;
      };
      // Only literal values are inventoried. A var() reference is already on the
      // token system and is not what Phase 4.1 is trying to find.
      if (!/var\(/.test(value)) {
        for (const hex of value.match(/#[0-9a-f]{3,8}\b/gi) || []) add('colours', hex.toLowerCase());
        for (const fn of value.match(/rgba?\([^)]+\)|hsla?\([^)]+\)/gi) || []) add('colours', fn.replace(/\s+/g, ''));
        if (/^border-radius$/.test(prop)) for (const r of value.split(/\s+/)) add('radii', r.replace('!important', '').trim());
        if (/^font-size$/.test(prop)) add('fontSizes', value.replace('!important', '').trim());
        if (/^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/.test(prop)) {
          for (const v of value.replace('!important', '').trim().split(/\s+/)) if (/^-?[\d.]+px$/.test(v)) add('spacing', v);
        }
        if (/^z-index$/.test(prop)) add('zIndex', value.replace('!important', '').trim());
        if (/^(transition|animation)$/.test(prop)) add('transitions', value.replace('!important', '').trim().slice(0, 40));
      }
    }
  }
  report.important.byFile[file] = fileCount;
}

for (const [sel, files] of selectorOwners) {
  if (files.size > 1) report.selectors.duplicatedAcrossFiles.push({ selector: sel, files: [...files] });
}
report.selectors.duplicatedAcrossFiles.sort((a, b) => b.files.length - a.files.length);

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
for (const { file, css } of sources) {
  for (const m of css.match(new RegExp(`content:\\s*['"][^'"]*${EMOJI.source}[^'"]*['"]`, 'gu')) || []) {
    report.emojiInCss.push({ file, rule: m });
  }
}

report.important.worstSelectors = Object.entries(
  importantRows.reduce((acc, r) => {
    const key = `${r.file} :: ${r.selector}`;
    (acc[key] = acc[key] || []).push(r.prop);
    return acc;
  }, {})
).map(([k, props]) => ({ where: k, count: props.length, props: [...new Set(props)] }))
 .sort((a, b) => b.count - a.count);

const top = (obj, n = 14) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

if (JSON_OUT) {
  console.log(JSON.stringify({ ...report, importantRows: FULL ? importantRows : undefined }, null, 2));
} else {
  const bar = n => '█'.repeat(Math.round(n / 8));
  console.log('\n=== LOADED STYLESHEETS (cascade order) ===');
  loaded.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f}`));

  console.log('\n=== DEAD STYLESHEETS (in public/, never linked) ===');
  report.deadStylesheets.forEach(d =>
    console.log(`  ${String(d.important).padStart(4)} !important  ${String(d.lines).padStart(5)} lines  ${d.file}`));

  console.log(`\n=== !IMPORTANT: ${report.important.total} in loaded CSS ===`);
  Object.entries(report.important.byFile)
    .sort((a, b) => b[1] - a[1]).filter(([, n]) => n)
    .forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${bar(n)} ${f}`));
  console.log('\n  by property:');
  top(report.important.byProperty).forEach(([p, n]) => console.log(`  ${String(n).padStart(4)}  ${p}`));
  console.log('\n  heaviest selectors:');
  report.important.worstSelectors.slice(0, FULL ? 60 : 12)
    .forEach(r => console.log(`  ${String(r.count).padStart(3)}  ${r.where}`));

  console.log('\n=== INVENTORY (literal values only; var() excluded) ===');
  for (const group of ['radii', 'fontSizes', 'spacing', 'zIndex']) {
    const entries = Object.entries(report.inventory[group]);
    console.log(`\n  ${group}: ${entries.length} distinct`);
    console.log('   ', entries.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .map(([v, n]) => `${v}(${n})`).join(' '));
  }
  const colours = Object.entries(report.inventory.colours);
  console.log(`\n  colours: ${colours.length} distinct literals`);
  console.log('   ', top(report.inventory.colours, 18).map(([v, n]) => `${v}(${n})`).join(' '));

  console.log(`\n=== SELECTORS: ${report.selectors.total} rules ===`);
  console.log('  specificity (id-class-element):');
  top(report.selectors.bySpecificity, 10).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
  console.log(`\n  same selector in 2+ files: ${report.selectors.duplicatedAcrossFiles.length}`);
  report.selectors.duplicatedAcrossFiles.slice(0, FULL ? 40 : 10)
    .forEach(d => console.log(`    ${d.selector}  ->  ${d.files.join(', ')}`));

  console.log(`\n=== EMOJI IN CSS content: ${report.emojiInCss.length} ===`);
  report.emojiInCss.slice(0, 20).forEach(e => console.log(`    ${e.file}: ${e.rule}`));
  console.log('');
}
