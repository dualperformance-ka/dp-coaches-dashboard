import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const redesign = fs.readFileSync(new URL('../public/dashboard-redesign.js', import.meta.url), 'utf8');
const triageCss = fs.readFileSync(new URL('../public/triage.css', import.meta.url), 'utf8');
const triageJs = fs.readFileSync(new URL('../public/triage.js', import.meta.url), 'utf8');
const queueJs = fs.readFileSync(new URL('../public/coach-queue.js', import.meta.url), 'utf8');

// Today used to stack three answers to "who needs me": the Command Center's
// client-computed red/amber list, the server triage queue, and a review list in
// the rail. It is now a command centre in workflow order: a compact header,
// one decision queue, squad pulse (reporting), and the coach's own workload in
// the rail. The DOM order matches the visual order so keyboard and screen-reader
// users meet the queue first too.

test('Today reads header, then the one queue, then squad pulse, then the rail', () => {
  const workspace = html.indexOf('class="today-workspace"');
  const head = html.indexOf('class="today-head"');
  const queue = html.indexOf('class="triage-shell"');
  const pulse = html.indexOf('class="today-operations"');
  const commandCenter = html.indexOf('id="command-center"');
  const rail = html.indexOf('class="today-rail"');
  const reviewQueue = html.indexOf('id="review-queue"');
  const coachingActions = html.indexOf('id="coaching-actions"');

  assert.ok(workspace >= 0 && head > workspace, 'compact header first');
  assert.ok(queue > head, 'the queue before any reporting');
  assert.ok(pulse > queue && commandCenter > pulse, 'squad pulse after the queue');
  assert.ok(rail > commandCenter);
  assert.ok(reviewQueue > rail && coachingActions > reviewQueue);
  assert.match(html, /'triage', 'athletes', 'calendar', 'programming'/);
});

test('the large greeting hero is gone; the header is compact static markup', () => {
  assert.doesNotMatch(redesign, /function addPageIntro\(/);
  assert.doesNotMatch(redesign, /dp-page-intro/);
  assert.match(html, /<h1 class="today-greeting">/);
  for (const id of ['today-date', 'today-updated', 'today-attention', 'today-refresh']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} in the header`);
  }
  assert.match(redesign, /function hydrateTodayHeader\(\)/);
});

test('the desktop layout gives the queue the main column and the rail a third', () => {
  assert.match(triageCss, /grid-template-columns: minmax\(0, 2fr\) minmax\(320px, 1fr\)/);
  assert.match(triageCss, /grid-template-areas:\s*"head\s+head"\s*"queue rail"\s*"pulse rail"/);
  assert.match(triageCss, /@media \(max-width: 1060px\)[\s\S]*grid-template-areas:\s*"head"\s*"queue"\s*"pulse"\s*"rail"/);
  // The queue is the page's main column, so it must not scroll inside its
  // own box — that capped it at one viewport regardless of how many rows fired.
  assert.doesNotMatch(triageCss, /\.triage-shell\s*\{[^}]*overflow-y: auto/s);
});

test('the second and third priority lists are gone', () => {
  assert.doesNotMatch(html, /function buildCoachActions\(/);
  assert.doesNotMatch(html, /cc-list-title">Highest Priority/);
  assert.doesNotMatch(html, /Overdue Check-ins <span class="cc-list-count/);
  assert.doesNotMatch(html, /class="cc-side-title">Coach Next Actions/);
  assert.doesNotMatch(html, /class="cc-action-idx"/);
  // Replaced by squad-level vitals that filter rather than rank.
  assert.match(html, /function buildTodayStrip\(ath\)/);
  assert.match(html, /class="squad-vitals"/);
  // The rail no longer lists review days the queue already shows.
  assert.doesNotMatch(triageJs, /class="review-list"/);
  assert.match(triageJs, /data-focus-start="review"/);
});

test('client-computed alerts feed the same queue rather than a second list', () => {
  assert.match(html, /function publishClientSignals\(ath\)/);
  assert.match(html, /flag: 'client_alert'/);
  assert.match(html, /window\.DP_TRIAGE\?\.setClientSignals\(rows\)/);
  // Each line keeps its own severity so the queue can file it by category.
  assert.match(html, /lines: \[\.\.\.critical\.map\(text => \(\{ text, critical: true \}\)\)/);
  // One item per athlete: every source is merged by code in coach-queue.js.
  assert.match(queueJs, /export function buildCoachQueue\(/);
  assert.match(queueJs, /entry\.signals\.push\(\.\.\.clientSignals\(row\)\)/);
  // Client rows still rank below every server band inside a category.
  const priority = html.match(/priority: \(critical\.length \? (\d+) : (\d+)\)/);
  assert.ok(priority, 'client rows must declare a priority');
  assert.ok(Number(priority[1]) < 2000, 'client alerts rank below awaiting_review');
});

test('every queue row can be completed and resolved rows reopened', () => {
  assert.match(triageJs, /data-triage-resolve=/);
  assert.match(triageJs, /action: 'signal_resolve'/);
  assert.match(triageJs, /action: 'signal_restore'/);
  assert.match(triageJs, /data-triage-print=/);
  assert.match(triageJs, /data-review-all=/);
  assert.match(triageJs, /data-message-read=/);
});

test('review work is reachable, clearable and lands on the session', () => {
  assert.match(triageJs, /function renderReviewQueue\(review\)/);
  assert.match(triageJs, /action: 'session_review'/);
  assert.match(triageJs, /data-review-done=/);
  // Opening a review lands on the session, not the athlete's overview.
  assert.match(triageJs, /openAthlete\(code, \{ tab: 'training', date \}\)/);
  assert.match(html, /function openAthleteFromTriage\(code, options = \{\}\)/);
});

test('squad pulse sits below the queue and collapses on a phone', () => {
  assert.match(html, /id="pulse-toggle" aria-expanded="true" aria-controls="pulse-body"/);
  assert.match(html, /function initPulseToggle\(\)/);
  assert.match(html, /return saved === null \? !phone\(\) : saved === '1'/);
  // Need attention is the queue's own number, never a separate count.
  assert.match(html, /kind: 'attention'/);
  assert.match(html, /window\.DP_TRIAGE\?\.model\?\.\(\)\.counts\?\.all/);
});
