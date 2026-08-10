// api/_lib/auth.js — Supabase Auth helpers for the email-OTP identity layer.
//
// Identity model: auth.users.id -> athletes.auth_user_id -> athletes.code.
// The athlete's legacy `code` remains the business key for ALL data tables and
// sync flows; these helpers only translate an authenticated session into that
// code so endpoints can trust the session instead of a client-supplied code.
//
// Dependency-free on purpose (this repo has no @supabase/supabase-js server
// dep): the access token is verified by asking Supabase Auth itself via
// GET /auth/v1/user, which checks signature, expiry and revocation for us.

import { select, patch } from './supabase-rest.js';
import { getRosterAthlete, isBlockedRow, normCode } from './roster.js';
import { verifyPortalSession } from './legacy-session.js';

export function emailAuthEnabled() {
  // Global rollout switch. Default OFF so deploying this code changes nothing
  // until the flag is explicitly set in Vercel env.
  return String(process.env.EMAIL_AUTH_ENABLED || '').toLowerCase() === 'true';
}

export function bearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  const m = /^Bearer\s+(.+)$/i.exec(String(h || '').trim());
  return m ? m[1] : null;
}

// Escape LIKE wildcards so an email is matched literally (but
// case-insensitively) by PostgREST's ilike. `_` is a single-char wildcard in
// LIKE and a perfectly legal email character — it must be escaped, not removed.
export function emailIlikePattern(email) {
  return String(email || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// Verify a Supabase access token → { id, email } or null. Never throws.
export async function getUserFromToken(token) {
  if (!token) return null;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const user = await r.json();
    return user && user.id ? { id: user.id, email: String(user.email || '').toLowerCase() } : null;
  } catch (e) {
    console.warn('[auth] token verification failed:', e && e.message);
    return null;
  }
}

// Resolve an auth user to their existing athlete row.
// 1) By auth_user_id (already linked).
// 2) By email, when the row is email-eligible (auth_mode 'both'/'email') and
//    not yet linked → link it now (first successful OTP sign-in completes the
//    migration for that athlete). Linking PATCHes auth_user_id only — it never
//    creates rows, never touches `code`, so all history keeps resolving.
// Returns the athlete row or null. Archived athletes never resolve.
export async function resolveAthleteForUser(user) {
  if (!user || !user.id) return null;

  const linked = await select('athletes', {
    auth_user_id: `eq.${user.id}`,
    select: '*',
    limit: 1,
  });
  if (Array.isArray(linked) && linked[0]) {
    return linked[0].archived_at == null ? linked[0] : null;
  }

  if (!user.email) return null;
  const candidates = await select('athletes', {
    email: `ilike.${emailIlikePattern(user.email)}`,
    archived_at: 'is.null',
    auth_user_id: 'is.null',
    auth_mode: 'in.(both,email)',
    select: '*',
    limit: 2,
  });
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    // 0 = not enrolled; 2+ = ambiguous (should be impossible with the unique
    // email index, but never guess an identity).
    return null;
  }
  const row = candidates[0];
  const updated = await patch(
    'athletes',
    { code: `eq.${normCode(row.code)}`, auth_user_id: 'is.null' },
    { auth_user_id: user.id, email_verified_at: new Date().toISOString() }
  );
  return (Array.isArray(updated) && updated[0]) || row;
}

// One-call helper for endpoints: Authorization header → { user, athlete }.
// Null when there is no/invalid token or no linked athlete. Never throws.
export async function getAuthedAthlete(req) {
  try {
    const token = bearerToken(req);
    if (!token) return null;
    const user = await getUserFromToken(token);
    if (!user) return null;
    const athlete = await resolveAthleteForUser(user);
    return athlete ? { user, athlete } : null;
  } catch (e) {
    console.warn('[auth] athlete resolution failed:', e && e.message);
    return null;
  }
}

// Resolve either supported portal credential:
// - Supabase Auth access token created by the email OTP flow.
// - A short-lived, server-signed legacy session created after a code login.
//
// Bare athlete codes are never accepted as authorization. Every protected
// endpoint calls this helper and derives the athlete code server-side.
export async function getRequestAthlete(req) {
  try {
    const token = bearerToken(req);
    if (!token) return null;

    const legacy = verifyPortalSession(token, 'portal');
    if (legacy) {
      const athlete = await getRosterAthlete(legacy.code);
      if (!athlete || isBlockedRow(athlete)) return null;
      return {
        user: null,
        athlete,
        method: 'legacy',
        expiresAt: legacy.exp,
      };
    }

    const authed = await getAuthedAthlete(req);
    return authed ? { ...authed, method: 'email' } : null;
  } catch (e) {
    console.warn('[auth] request athlete resolution failed:', e && e.message);
    return null;
  }
}
