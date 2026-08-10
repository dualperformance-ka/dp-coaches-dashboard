import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const redesign = fs.readFileSync(new URL('../public/dashboard-redesign.js', import.meta.url), 'utf8');

test('Today keeps live triage beside priorities and before coaching actions when stacked', () => {
  assert.match(redesign, /const content = qs\("#tab-triage-content"\)/);
  assert.match(redesign, /const anchor = qs\("\.today-workspace", content\)/);
  const workspace = html.indexOf('class="today-workspace"');
  const operations = html.indexOf('class="today-operations"');
  const commandCenter = html.indexOf('id="command-center"');
  const coachingActions = html.indexOf('id="coaching-actions"');
  const triageShell = html.indexOf('class="triage-shell"');
  assert.ok(workspace >= 0 && operations > workspace);
  assert.ok(commandCenter > operations);
  assert.ok(triageShell > commandCenter);
  assert.ok(coachingActions > triageShell);
  assert.match(html, /'triage', 'athletes', 'planning'/);
});

test('desktop Today layout uses a sticky triage rail and stacks triage second', () => {
  const css = fs.readFileSync(new URL('../public/triage.css', import.meta.url), 'utf8');
  assert.match(css, /grid-template-areas:\s*"priorities triage"\s*"actions triage"/);
  assert.match(css, /\.triage-shell\s*\{[^}]*position: sticky;[^}]*top: 118px;/s);
  assert.match(css, /@media \(max-width:1060px\)[\s\S]*grid-template-areas:\s*"priorities"\s*"triage"\s*"actions"/);
});
