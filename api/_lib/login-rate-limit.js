import { insert, select, supabaseRequest, tablePath } from './supabase-rest.js';
import { authFingerprint } from './legacy-session.js';
import { clientIp } from './http.js';

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 10;

function fingerprint(req) {
  return authFingerprint(`legacy-login:${clientIp(req)}`);
}

export async function assertLoginAllowed(req) {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const rows = await select('portal_auth_attempts', {
    fingerprint: `eq.${fingerprint(req)}`,
    success: 'eq.false',
    attempted_at: `gte.${since}`,
    select: 'id',
    limit: String(MAX_FAILURES),
  });
  if (Array.isArray(rows) && rows.length >= MAX_FAILURES) {
    const error = new Error('Too many attempts. Wait 15 minutes and try again.');
    error.status = 429;
    throw error;
  }
}

export async function recordLoginAttempt(req, success) {
  await insert('portal_auth_attempts', {
    fingerprint: fingerprint(req),
    success: success === true,
    attempted_at: new Date().toISOString(),
  });

  // Keep this intentionally best-effort. Authentication itself must not fail
  // merely because old rate-limit records could not be pruned.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  supabaseRequest(tablePath('portal_auth_attempts', { attempted_at: `lt.${cutoff}` }), {
    method: 'DELETE',
    prefer: 'return=minimal',
  }).catch(() => {});
}
