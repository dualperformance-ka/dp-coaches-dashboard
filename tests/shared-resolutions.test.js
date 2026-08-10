import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createPayload, updatePayload } from '../api/actions.js';

test('coaching action completion records the authenticated coach', () => {
  const now = new Date('2026-08-10T07:00:00.000Z');
  const created = createPayload({
    athlete_code: 'ALVIN',
    title: 'Follow up on fuelling',
    status: 'done',
  }, 'Karl', now);

  assert.equal(created.created_by, 'Karl');
  assert.equal(created.updated_by, 'Karl');
  assert.equal(created.completed_by, 'Karl');
  assert.equal(created.completed_at, now.toISOString());

  assert.deepEqual(updatePayload({ status: 'done' }, 'Alex', now), {
    status: 'done',
    updated_at: now.toISOString(),
    updated_by: 'Alex',
    completed_at: now.toISOString(),
    completed_by: 'Alex',
  });
});

test('reopening clears completion attribution while retaining the last editor', () => {
  const now = new Date('2026-08-10T07:05:00.000Z');
  assert.deepEqual(updatePayload({ status: 'open' }, 'Karl', now), {
    status: 'open',
    updated_at: now.toISOString(),
    updated_by: 'Karl',
    completed_at: null,
    completed_by: null,
  });
});

test('shared controls wait for the server and periodically reconcile both coach sessions', () => {
  const dashboard = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/coaching-actions.js', import.meta.url), 'utf8');

  assert.match(dashboard, /await maPost\(\{ action: 'alert_acknowledge'/);
  assert.match(dashboard, /result\.acknowledgement/);
  assert.doesNotMatch(dashboard, /setting_upsert', code: id, key: 'ack_alert'/);
  assert.match(dashboard, /setInterval\(refreshSharedAcknowledgements, 12000\)/);
  assert.match(dashboard, /class="cc-athlete-open"/);
  assert.doesNotMatch(dashboard, /<button class="cc-athlete"[\s\S]{0,600}<button class="cc-ack-btn"/);
  assert.match(actions, /completed by \$\{payload\.action\.completed_by/);
  assert.match(actions, /`Completed \$\{completed\.length\}`/);
  assert.match(actions, /moved to Completed/);
  assert.match(actions, /setInterval\(refresh, 12000\)/);
});
