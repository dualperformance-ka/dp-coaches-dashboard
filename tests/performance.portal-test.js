import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionLibrary, trainingRead } from '../api/write.js';

const root = new URL('..', import.meta.url).pathname;
const trainingSource = readFileSync(join(root, 'public', 'js', '08-training.js'), 'utf8');
const loginSource = readFileSync(join(root, 'public', 'js', '02-login-goals.js'), 'utf8');
const bootSource = readFileSync(join(root, 'public', 'js', '10-boot.js'), 'utf8');
const navSource = readFileSync(join(root, 'public', 'js', '03-nav-nudges.js'), 'utf8');
const indexSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');

test('training snapshot settles sections independently and omits a warm cached library', async () => {
  let libraryCalls = 0;
  const result = await trainingRead('KARL', {
    start: '2026-08-03', end: '2026-08-09', includeLibrary: false,
  }, {
    plannedSessions: async () => ({ rows: [{ id: 'plan-1' }], next: null }),
    workoutSplits: async () => { throw new Error('temporary split failure'); },
    sessionLibrary: async () => { libraryCalls++; return { rows: [] }; },
  });

  assert.deepEqual(result.planned.rows, [{ id: 'plan-1' }]);
  assert.equal(result.splits, null);
  assert.equal('nutrition' in result, false);
  assert.deepEqual(result.errors, ['splits']);
  assert.equal(libraryCalls, 0);
});

test('training snapshot includes the library only on a cold client', async () => {
  const result = await trainingRead('KARL', {
    start: '2026-08-03', end: '2026-08-09', includeLibrary: true, libraryRevision: 'old',
  }, {
    plannedSessions: async () => ({ rows: [] }),
    workoutSplits: async () => ({ rows: [] }),
    sessionLibrary: async (body) => ({ rows: [{ id: 'run-1' }], revision: body.libraryRevision + '-new' }),
  });
  assert.equal(result.library.rows[0].id, 'run-1');
  assert.equal(result.library.revision, 'old-new');
});

test('session library revisions suppress unchanged response payloads', async () => {
  const rows = [{ id: 'run-1', name: 'Easy Run', archived: false }];
  const first = await sessionLibrary({}, async () => rows);
  const second = await sessionLibrary({ libraryRevision: first.revision }, async () => rows);
  assert.equal(first.notModified, false);
  assert.deepEqual(first.rows, rows);
  assert.equal(second.notModified, true);
  assert.deepEqual(second.rows, []);
});

test('client persists a compact athlete-scoped week snapshot and preserves compatibility fallbacks', () => {
  assert.match(trainingSource, /portalRequest\('training-read'/);
  assert.match(trainingSource, /loadRunningLibrary\(bundle&&bundle\.library\)/);
  assert.match(trainingSource, /loadWorkoutSplits\(bundle&&bundle\.splits\)/);
  assert.match(trainingSource, /loadPlannedSessions\([^\n]+bundle&&bundle\.planned\)/);
  assert.match(trainingSource, /dp_training_week_v1_/);
  assert.match(trainingSource, /source:'persistent'/);
  assert.match(trainingSource, /library:null/);
  assert.match(trainingSource, /refreshWeekInBackground/);
});

test('secondary metrics and Progress code stay off the primary render path', () => {
  assert.match(loginSource, /var hydrationPromise=hydratePortalData\(code\)/);
  assert.match(loginSource, /var initialWeekPromise=Promise\.resolve\(loadWeek\(\)\)/);
  assert.match(loginSource, /window\._stravaLoadPromise=window\.initStrava/);
  assert.ok(loginSource.indexOf('var initialWeekPromise=Promise.resolve(loadWeek())') < loginSource.indexOf('syncPushSubscription();'));
  assert.ok(loginSource.indexOf('var initialWeekPromise=Promise.resolve(loadWeek())') < loginSource.indexOf('retryPendingCoachWrites(true);'));
  assert.doesNotMatch(indexSource, /<script src="js\/07-progress\.js/);
  assert.match(indexSource, /data-src="\/js\/07-progress\.js\?v=86"/);
  assert.match(navSource, /ensureProgressModule\(\)\.then\(function\(\)\{loadProgress\(\);\}\)/);
});

test('a resolved session athlete is reused instead of authenticated twice', () => {
  assert.match(bootSource, /doLogin\(me\.code,me\)/);
  assert.match(bootSource, /doLogin\(legacyMe\.code,legacyMe\)/);
  assert.match(loginSource, /async function doLogin\(code,prevalidatedRoster\)/);
  assert.match(loginSource, /var roster=prevalidatedRoster\|\|await validateRosterCode\(code\)/);
});
