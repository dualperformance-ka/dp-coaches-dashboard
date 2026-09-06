import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const mobileNav = fs.readFileSync(new URL('../public/dashboard-mobilenav.js', import.meta.url), 'utf8');
const workspaceCss = fs.readFileSync(
  new URL('../public/dashboard-detail-cleanup.css', import.meta.url),
  'utf8'
);

// Eight top-level tabs mixed daily coaching with administration. The bar now
// carries four coaching destinations; Applications / new leads / the notify
// composer became Pipeline sub-views, and Sync, the coach team and roster
// management moved behind Settings.

test('the tab bar offers four coaching destinations plus search and settings', () => {
  const barStart = html.indexOf('<div class="tab-bar" role="tablist"');
  const bar = html.slice(barStart, html.indexOf('\n</div>', barStart));
  const primary = [...bar.matchAll(/id="tab-(\w+)-btn"/g)]
    .map(m => m[1])
    .filter(key => key !== 'search');
  assert.deepEqual(primary, ['triage', 'athletes', 'programming', 'pipeline']);
  assert.match(bar, /id="tab-search-btn"/);
  assert.match(bar, /id="settings-btn"/);
  // The three retired tabs must not still have top-level buttons.
  assert.doesNotMatch(bar, /id="tab-(apps|notif|send|coaches|sync)-btn"/);
});

test('pipeline sub-views keep their existing content panels and badge ids', () => {
  assert.match(html, /id="pipeline-subnav"/);
  for (const key of ['applications', 'notifications', 'send']) {
    assert.match(html, new RegExp(`id="pipe-${key}-btn"`), `${key} sub-tab button`);
  }
  // Render code writes to these ids; moving the tabs must not orphan them.
  for (const id of ['tab-apps-count', 'tab-notif-count', 'tab-sync-count', 'tab-pipeline-count']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} still exists`);
  }
  assert.match(html, /const PIPELINE_TABS = \['applications', 'notifications', 'send'\]/);
});

test('switchTab still accepts every legacy key its callers pass', () => {
  // triage.js calls switchTab('send') and switchTab('planning'); the command
  // centre and mobile nav pass the rest.
  assert.match(html, /const ALL_TABS = \['triage', 'athletes', 'programming', 'coaches', 'sync', \.\.\.PIPELINE_TABS\]/);
  assert.match(html, /if \(tab === 'planning' \|\| tab === 'nutrition'\)/);
  assert.match(html, /if \(tab === 'pipeline'\) tab = _pipelineView/);
});

test('the settings menu sits outside the tab bar so it is not clipped', () => {
  const barStart = html.indexOf('<div class="tab-bar" role="tablist"');
  const barEnd = html.indexOf('\n</div>', barStart);
  const dropdownAt = html.indexOf('id="settings-dropdown"');
  assert.ok(dropdownAt > barEnd, 'the dropdown must be a sibling of .tab-bar, not a child');
  // .tab-bar combines backdrop-filter with overflow, which both clips an
  // absolutely-positioned child and scrolls the bar when the menu takes focus.
  assert.match(workspaceCss, /\.settings-dropdown\s*\{[^}]*position:\s*fixed/s);
  assert.match(html, /function settingsGo\(target\)/);
  assert.match(html, /if \(target === 'manage'\) return openManageAthletes\(\)/);
});

test('roster management is reachable only from settings', () => {
  assert.doesNotMatch(html, /id="manage-athletes-btn"/);
  assert.match(html, /onclick="settingsGo\('manage'\)"/);
});

test('the command palette can reach any athlete or screen', () => {
  assert.match(html, /function openCommandPalette\(\)/);
  assert.match(html, /event\.key\.toLowerCase\(\) === 'k'/);
  // "/" must not hijack typing.
  assert.match(html, /if \(event\.key === '\/' && !_isTyping\(\)\)/);
  assert.match(html, /const CMDK_RECENT_KEY = 'dp_recent_athletes'/);
  assert.match(html, /cmdkRemember\(id\);/);
});

test('athlete-overlay arrow navigation yields to the palette and to typing', () => {
  const handler = html.slice(
    html.indexOf("  // The palette owns the keyboard while it is open."),
    html.indexOf("// ── Quick DM generator ──")
  );
  assert.match(handler, /if \(cmdk && !cmdk\.hidden\) return;/);
  assert.match(handler, /if \(_isTyping\(\)\) return;/);
  // The typing guard has to come before the arrow handlers, not after.
  assert.ok(
    handler.indexOf('if (_isTyping()) return;') < handler.indexOf("e.key === 'ArrowLeft'"),
    'the typing guard must precede arrow navigation'
  );
});

test('the mobile bottom nav mirrors the desktop destinations', () => {
  const primary = [...mobileNav.matchAll(/\{ key: '(\w+)',\s+label: '[^']+',\s+icon: '\w+'\s+\}/g)];
  assert.ok(primary.length >= 4);
  assert.match(mobileNav, /var PRIMARY = \[[\s\S]*?'triage'[\s\S]*?'athletes'[\s\S]*?'programming'[\s\S]*?'applications'[\s\S]*?\];/);
  // Pipeline's badge moved with it.
  assert.match(mobileNav, /applications: 'tab-pipeline-count'/);
});
