import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const workspaceCss = fs.readFileSync(
  new URL('../public/dashboard-detail-cleanup.css', import.meta.url),
  'utf8'
);

// The athlete view used to render sixteen sections as one scrolling document,
// with a sticky banner that carried only the athlete name and week navigation.
// Athlete identity and current state now live in a sticky header above a tab
// strip, and the week strip became week-scoped panel content.

test('athlete identity and current state stay visible in a sticky header', () => {
  // Header and tabs share one sticky wrapper, so the offset never depends on
  // the header's own height (which changes with flags and the next-action row).
  assert.match(html, /<div class="fpa-sticky">/);
  assert.match(html, /\$\{buildAthleteHeader\(a, ctx\)\}/);
  assert.match(html, /\$\{buildAthleteTabBar\(tabCounts\)\}/);
  assert.match(workspaceCss, /\.fpa-sticky\s*\{[^}]*position:\s*sticky;[^}]*top:\s*var\(--fpa-topbar-h/s);

  // The header names the athlete and states the coaching context around them.
  assert.match(html, /class="fpa-name">\$\{esc\(a\.displayName \|\| a\.id\)\}/);
  assert.match(html, /class="fpa-vitals-lbl">This week/);
});

test('race context reaches the athlete header', () => {
  // athlete_goals has always been returned by /api/coach-data; until the goals
  // argument was threaded through buildAll nothing consumed it, so no screen
  // could say how far out a race was.
  assert.match(html, /buildAll\([^)]*coachDataSB\.goals\)/s);
  assert.match(html, /function buildRaceContext\(goal, weekNum, code\)/);
  assert.match(html, /race: buildRaceContext\(goalsByCode\[a\.id\] \|\| null, wkNum, a\.id\)/);
  assert.match(html, /const countdown = raceCountdownLabel\(race\)/);
});

test('week navigation stays with the week-scoped panels', () => {
  assert.match(html, /function buildAthleteWeekStrip\(a, ctx\)/);
  assert.match(html, /Current programme week/);
  assert.match(html, /Current: \$\{esc\(currentWeekLabel\)\}/);
  // Overview and Training are the two week-scoped panels, so both carry it.
  assert.match(html, /overview: \[weekStrip,/);
  assert.match(html, /training: \[weekStrip,/);
});

test('the title-matching collapse pass is gone', () => {
  // It listed almost every section as open-by-default, so in practice nothing
  // collapsed and the view stayed a sixteen-section scroll.
  assert.doesNotMatch(html, /function initCollapsibleSections\(/);
  assert.doesNotMatch(html, /function fpExpandAll\(/);
});
