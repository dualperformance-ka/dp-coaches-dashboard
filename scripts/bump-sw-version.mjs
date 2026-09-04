#!/usr/bin/env node
// Bumps the service worker's VERSION constant.
//
// public/sw.js keys every cache off VERSION, and the browser only installs a new
// worker when sw.js changes byte-for-byte. With no build step, a deploy that
// leaves it alone ships new HTML while coaches keep old cached JS and CSS, with
// no update prompt and no way out from inside the app. Run this before deploying.
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../public/sw.js', import.meta.url);
const source = readFileSync(path, 'utf8');
const match = source.match(/const VERSION = '([^']+)';/);
if (!match) {
  console.error('Could not find the VERSION constant in public/sw.js');
  process.exit(1);
}

const current = match[1];
const label = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
const numbered = current.match(/^(.*?-v)(\d+)(.*)$/);
const next = label
  ? `dp-coaches-v${numbered ? Number(numbered[2]) + 1 : 1}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  : numbered ? `${numbered[1]}${Number(numbered[2]) + 1}${numbered[3]}` : `${current}-2`;

writeFileSync(path, source.replace(match[0], `const VERSION = '${next}';`));
console.log(`sw.js VERSION: ${current} -> ${next}`);
