import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const index = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const core = readFileSync(join(root, 'public', 'js', '01-core.js'), 'utf8');
const loginGoals = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const boot = readFileSync(join(root, 'public', 'js', '10-boot.js'), 'utf8');

test('athletes never receive a header logout control', () => {
  assert.doesNotMatch(index, /id="logoutBtn"/);
  assert.doesNotMatch(core, /logoutBtn/);
  assert.doesNotMatch(boot, /logoutBtn/);
});

test('Contact sign-out is hidden by default and revealed only for access-code coaches', () => {
  assert.match(index, /id="coachLogoutBtn"[^>]*style="display:none"/);
  assert.match(
    loginGoals,
    /getElementById\('coachLogoutBtn'\).*localStorage\.getItem\('dp_auth_method'\)==='code'\?'flex':'none'/s
  );
  assert.doesNotMatch(boot, /coachLogoutBtn/);
});
