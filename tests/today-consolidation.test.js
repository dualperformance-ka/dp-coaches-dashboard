import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const redesign = fs.readFileSync(new URL('../public/dashboard-redesign.js', import.meta.url), 'utf8');
const triageCss = fs.readFileSync(new URL('../public/triage.css', import.meta.url), 'utf8');
const triageJs = fs.readFileSync(new URL('../public/triage.js', import.meta.url), 'utf8');

// Today used to stack three answers to "who needs me": the Command Center's
// client-computed red/amber list, the server triage queue, and coach_actions.
// It now carries squad vitals, one decision queue, and the coach's own workload
// in a rail.

test('Today reads vitals, then the one queue, then the coach rail', () => {
  assert.match(redesign, /const content = qs\("#tab-triage-content"\)/);
  assert.match(redesign, /const anchor = qs\("\.today-workspace", content\)/);

  const workspace = html.indexOf('class="today-workspace"');
  const operations = html.indexOf('class="today-operations"');
  const commandCenter = html.indexOf('id="command-center"');
  const triageShell = html.indexOf('class="triage-shell"');
  const rail = html.indexOf('class="today-rail"');
  const reviewQueue = html.indexOf('id="review-queue"');
  const coachingActions = html.indexOf('id="coaching-actions"');

  assert.ok(workspace >= 0 && operations > workspace);
  assert.ok(commandCenter > operations);
  assert.ok(triageShell > commandCenter);
  assert.ok(rail > triageShell);
  assert.ok(reviewQueue > rail && coachingActions > reviewQueue);
  assert.match(html, /'triage', 'athletes', 'programming'/);
});

test('the desktop layout gives the queue the working column and sticks the rail', () => {
  assert.match(triageCss, /grid-template-areas:\s*"operations operations"\s*"queue\s+rail"/);
  assert.match(triageCss, /\.today-rail\s*\{[^}]*position: sticky;[^}]*top: 118px;/s);
  assert.match(triageCss, /@media \(max-width:1060px\)[\s\S]*grid-template-areas:\s*"operations"\s*"queue"\s*"rail"/);
  // The queue is the page's main column now, so it must not scroll inside its
  // own box — that capped it at one viewport regardless of how many rows fired.
  assert.doesNotMatch(triageCss, /\.triage-shell\s*\{[^}]*overflow-y: auto/s);
});

test('the second and third priority lists are gone', () => {
  // The Command Center's own ranked lists and derived to-dos.
  assert.doesNotMatch(html, /function buildCoachActions\(/);
  assert.doesNotMatch(html, /cc-list-title">Highest Priority/);
  assert.doesNotMatch(html, /Overdue Check-ins <span class="cc-list-count/);
  // Checked as rendered markup: the comments explaining the removal legitimately
  // name what was removed.
  assert.doesNotMatch(html, /class="cc-side-title">Coach Next Actions/);
  assert.doesNotMatch(html, /class="cc-action-idx"/);
  // Replaced by squad-level vitals that filter rather than rank.
  assert.match(html, /function buildTodayStrip\(ath\)/);
  assert.match(html, /class="squad-vitals"/);
});

test('client-computed alerts feed the same queue rather than a second list', () => {
  assert.match(html, /function publishClientSignals\(ath\)/);
  assert.match(html, /flag: 'client_alert'/);
  assert.match(html, /window\.DP_TRIAGE\?\.setClientSignals\(rows\)/);
  // Deduped by athlete inside the queue, with the server's ranking winning.
  assert.match(triageJs, /function mergedQueue\(\)/);
  assert.match(triageJs, /existing\.also = existing\.also\.concat/);
  // Client rows must rank below every server band so a server signal leads.
  const priority = html.match(/priority: \(critical\.length \? (\d+) : (\d+)\)/);
  assert.ok(priority, 'client rows must declare a priority');
  assert.ok(Number(priority[1]) < 2000, 'client alerts rank below awaiting_review');
});

test('every queue row can be resolved and reopened', () => {
  assert.match(triageJs, /data-triage-resolve=/);
  assert.match(triageJs, /action: 'signal_resolve'/);
  assert.match(triageJs, /action: 'signal_restore'/);
  assert.match(triageJs, /data-triage-print=/);
});

test('the review queue is reachable and clearable from the rail', () => {
  assert.match(triageJs, /function renderReviewQueue\(review\)/);
  assert.match(triageJs, /action: 'session_review'/);
  assert.match(triageJs, /data-review-done=/);
  // Opening a review lands on the session, not the athlete's overview.
  assert.match(triageJs, /openAthlete\(code, \{ tab: 'training', date \}\)/);
  assert.match(html, /function openAthleteFromTriage\(code, options = \{\}\)/);
});
