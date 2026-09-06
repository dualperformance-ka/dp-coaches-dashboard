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

  // Resolution is one mechanism across the server triage queue and the
  // client-computed alerts: a coach_signal_state row keyed by athlete and
  // signal type, fingerprinted so it reopens when the situation moves.
  assert.match(dashboard, /action: 'signal_resolve'/);
  assert.match(dashboard, /signal_type: 'client_alert'/);
  assert.match(dashboard, /action: 'signal_restore', code: id, signal_type: 'client_alert'/);
  assert.match(dashboard, /fingerprint: signature/);
  assert.doesNotMatch(dashboard, /setting_upsert', code: id, key: 'ack_alert'/);
  assert.match(dashboard, /setInterval\(refreshSharedAcknowledgements, 12000\)/);
  // Acknowledgements made before the migration are still honoured on read.
  assert.match(dashboard, /function useAckRows\(rows, signalRows\)/);
  assert.match(dashboard, /r\.key === 'ack_alert'/);
  assert.match(actions, /completed by \$\{payload\.action\.completed_by/);
  assert.match(actions, /`Completed \$\{completed\.length\}`/);
  assert.match(actions, /moved to Completed/);
  assert.match(actions, /setInterval\(refresh, 12000\)/);
});
