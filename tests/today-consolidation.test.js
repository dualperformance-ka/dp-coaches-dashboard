import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const redesign = fs.readFileSync(new URL('../public/dashboard-redesign.js', import.meta.url), 'utf8');

test('Today contains the greeting, weekly priorities, actions, and triage in that order', () => {
  assert.match(redesign, /const content = qs\("#tab-triage-content"\)/);
  assert.match(redesign, /const anchor = qs\("\.today-operations", content\)/);
  const operations = html.indexOf('class="today-operations"');
  const commandCenter = html.indexOf('id="command-center"');
  const coachingActions = html.indexOf('id="coaching-actions"');
  const triageShell = html.indexOf('class="triage-shell"');
  assert.ok(operations >= 0);
  assert.ok(commandCenter > operations);
  assert.ok(coachingActions > commandCenter);
  assert.ok(triageShell > coachingActions);
  assert.match(html, /'triage', 'athletes', 'planning'/);
});
