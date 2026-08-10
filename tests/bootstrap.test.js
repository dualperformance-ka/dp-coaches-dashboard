import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapRead } from '../api/write.js';

test('bootstrap combines read-only startup data without changing response shapes', async () => {
  const calls = [];
  const result = await bootstrapRead('ATHLETE1', {
    stateRead: async (code) => {
      calls.push(['state', code]);
      return { rows: [{ key: 'logs', value: { a: 1 } }], checkins: [] };
    },
    bodyLogs: async (code) => {
      calls.push(['body', code]);
      return { rows: [{ log_date: '2026-08-04', sleep: 8 }] };
    },
    sessionLogsRead: async (code) => {
      calls.push(['sessions', code]);
      return { rows: [{ session_key: 'session_ATHLETE1_1' }] };
    },
  });

  assert.deepEqual(result, {
    state: { rows: [{ key: 'logs', value: { a: 1 } }], checkins: [] },
    bodyLogs: { rows: [{ log_date: '2026-08-04', sleep: 8 }] },
    sessionLogs: { rows: [{ session_key: 'session_ATHLETE1_1' }] },
  });
  assert.deepEqual(calls.sort(), [
    ['body', 'ATHLETE1'],
    ['sessions', 'ATHLETE1'],
    ['state', 'ATHLETE1'],
  ]);
});
