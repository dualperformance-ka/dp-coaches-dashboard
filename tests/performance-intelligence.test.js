import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  // Skip the parameter list before looking for the body brace: a default
  // parameter like `options = {}` otherwise closes the scan immediately.
  let depth = 0;
  let cursor = html.indexOf('(', start);
  for (; cursor < html.length; cursor += 1) {
    if (html[cursor] === '(') depth += 1;
    if (html[cursor] === ')') { depth -= 1; if (!depth) break; }
  }
  const open = html.indexOf('{', cursor);
  depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('the analysis modules load and are cached by the service worker', () => {
  assert.match(html, /<script type="module" src="\/run-analysis\.js\?v=/);
  assert.match(html, /<script type="module" src="\/strength-analysis\.js\?v=/);
  // The engine they import has to be in the shell cache too, or the modules
  // fail to resolve offline.
  assert.match(sw, /'\/overload-adapter\.js'/);
  assert.match(sw, /'\/progressive-overload\.js'/);
  assert.match(sw, /'\/run-analysis\.js\?v=/);
  assert.match(sw, /'\/strength-analysis\.js\?v=/);
});

test('the portal log blob is kept rather than reduced to a set of keys', () => {
  // The overload engine reads the structured sets. useSessionStateRows used to
  // keep only Object.keys(), which is why strength history had to be re-parsed
  // out of free text on every render.
  assert.match(html, /let _logBlobs = new Map\(\);/);
  const use = functionSource('useSessionStateRows');
  assert.match(use, /_logBlobs\.set\(code, val\)/);
  assert.match(use, /_logBlobs = new Map\(\)/);
});

test('the strength panel feeds the engine the coach’s own rep ranges', () => {
  const prescribed = functionSource('prescribedExercises');
  assert.match(prescribed, /repRange: String\(repRange\)/);
  assert.match(prescribed, /return \{ counts, prescriptions \}/);
  // Counting sessions the athlete has not reached yet would make everyone
  // mid-block look like they were skipping every lift.
  assert.match(prescribed, /if \(!date \|\| date > today\) continue;/);

  const panel = functionSource('buildStrengthPanel');
  assert.match(panel, /prescriptions,/);
});

test('an inferred status is never dressed up as the engine’s decision', () => {
  const chip = functionSource('strengthStatusChip');
  assert.match(chip, /if \(row\.inferred\)/);
  // Different words: Rising/Flat/Steady, not Add load/Stalled/Hold.
  assert.match(chip, /'Rising'/);
  assert.match(chip, /'Flat'/);
  assert.match(chip, /is-inferred/);
});

test('the exercise drawer resolves its athlete without depending on the roster', () => {
  const open = functionSource('openExerciseHistory');
  assert.match(open, /const cached = _strengthCache\.get\(athleteCode\)/);
  assert.match(open, /cached\?\.athlete/);
  assert.match(open, /if \(!entry \|\| !STRENGTH \|\| !a\) return;/);
  // The cache has to carry the athlete for that to work.
  assert.match(functionSource('athleteStrengthHistory'), /_strengthCache\.set\(a\.id, \{ athlete: a, history \}\)/);
});

test('derived signals are computed client-side and merged into the one queue', () => {
  const derived = functionSource('derivedSignalsFor');
  assert.match(derived, /Load spike/);
  assert.match(derived, /Wellness decline/);
  assert.match(derived, /Strength stalls/);
  // A wellness drop needs three check-ins so one bad week is not a signal.
  assert.match(derived, /if \(recovery\.length >= 3\)/);
  // Two stalls, not one, before the queue is bothered.
  assert.match(derived, /stalled\.length >= 2/);
  // RPE only fires on easy work, where the expected effort is unambiguous.
  assert.match(derived, /classifySession\(run\.name, run\.type\) === 'easy'/);

  const publish = functionSource('publishClientSignals');
  assert.match(publish, /derivedSignalsFor\(a\)/);
  assert.match(publish, /flag: 'client_alert'/);
});

test('prescribed vs actual is fetched per session and degrades honestly', () => {
  const render = functionSource('renderPrescribedVsActual');
  // Session-total mode must state why the per-interval table is missing.
  assert.match(render, /match\.mode === 'session'/);
  assert.match(render, /session totals only/);
  assert.match(render, /match\.reason/);

  // One prescription request per session, cached, and never blocking the week.
  assert.match(html, /const _prescriptionCache = new Map\(\)/);
  const load = functionSource('loadPrescription');
  assert.match(load, /action=prescription/);
  assert.match(load, /_prescriptionCache\.has\(sessionId\)/);

  // The placeholder carries the Supabase session id, not the Notion page id.
  assert.match(html, /const pvaPlanId = pvaPlan\?\._sbId \|\| ''/);
  assert.match(html, /data-pva-session=/);
  assert.match(functionSource('switchAthleteTab'), /hydratePrescribedComparisons\(panel\)/);
});

test('running and strength panels are the tabs’ first content', () => {
  const card = functionSource('buildFPCard');
  assert.match(card, /running:\s*\[buildRunningPanel\(a\)/);
  assert.match(card, /strength: \[buildStrengthPanel\(a\)/);
});

test('derived history is discarded when the underlying data reloads', () => {
  // Stale exercise history after a refresh would silently show yesterday's
  // numbers under today's timestamp.
  assert.match(html, /useSessionReviewRows\(coachDataSB\.sessionReviews\);\s*\n\s*_strengthCache = new Map\(\);/);
});

test('no analysis path reads Strava API data', () => {
  const runModule = fs.readFileSync(new URL('../public/run-analysis.js', import.meta.url), 'utf8');
  const strengthModule = fs.readFileSync(new URL('../public/strength-analysis.js', import.meta.url), 'utf8');
  // Declarations only: the modules' header comments legitimately explain the
  // compliance boundary by naming the table they must not read.
  const stripComments = source => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const [name, source] of [['run-analysis', runModule], ['strength-analysis', strengthModule]]) {
    assert.doesNotMatch(stripComments(source), /strava/i, `${name} must not read Strava data`);
  }
  // The running panel's own inputs are the athlete's uploads and portal logs.
  const sessions = functionSource('athleteRunSessions');
  assert.match(sessions, /a\.activities \|\| \[\]/);
  assert.match(sessions, /parseRunLog/);
});
