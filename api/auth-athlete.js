// /api/auth-athlete.js — email-auth identity resolution for the portal.
//
// Actions:
//   GET ?action=eligibility&email=x@y.z
//     Pre-OTP gate used by the login screen BEFORE any code is sent.
//     → { ok, enabled, eligible, active }
//     `enabled`  = EMAIL_AUTH_ENABLED env flag (global rollout switch)
//     `eligible` = a non-archived roster row has this email with
//                  auth_mode 'both' or 'email' (per-athlete rollout switch)
//     Prevents OTP sends (and stray auth.users rows) for emails the coach has
//     not enrolled. Response is deliberately coarse — no names/codes leak.
//
//   GET (default, Authorization: Bearer <supabase access token>)
//     Verifies the session server-side, resolves (and on first sign-in links)
//     the auth user to their EXISTING athlete row, and returns the profile
//     shape used by the shared portal boot pipeline.
//     Never creates athlete rows; never changes `code`.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (existing), EMAIL_AUTH_ENABLED (new).

import { select } from './_lib/supabase-rest.js';
import {
  getRequestAthlete,
  emailAuthEnabled,
  emailIlikePattern,
} from './_lib/auth.js';
import { getRosterAthlete, isBlockedRow, normCode } from './_lib/roster.js';
import { createPortalSession } from './_lib/legacy-session.js';
import { assertLoginAllowed, recordLoginAttempt } from './_lib/login-rate-limit.js';
import { allowPortalRequest, safeError } from './_lib/http.js';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

async function handleEligibility(req) {
  await assertLoginAllowed(req);
  const enabled = emailAuthEnabled();
  const email = cleanEmail(req.query && req.query.email);
  if (!enabled || !email) return { ok: true, enabled, eligible: false, active: false };
  const rows = await select('athletes', {
    email: `ilike.${emailIlikePattern(email)}`,
    archived_at: 'is.null',
    auth_mode: 'in.(both,email)',
    select: 'code,active',
    limit: 1,
  });
  const row = (rows || [])[0];
  await recordLoginAttempt(req, !!row);
  return { ok: true, enabled, eligible: !!row, active: !!row && row.active === true };
}

async function handleMe(req) {
  const resolved = await getRequestAthlete(req);
  if (!resolved) return { status: 401, body: { ok: false, error: 'invalid_session' } };
  const athlete = resolved.athlete;
  return {
    status: 200,
    body: {
      ok: true,
      exists: true,
      active: athlete.active === true,
      code: athlete.code, // ← legacy business key; everything downstream keys off this
      name: athlete.name,
      start_date: athlete.start_date,
      race_target: athlete.race_target,
      email: athlete.email,
      auth_mode: athlete.auth_mode,
      auth_method: resolved.method,
    },
  };
}

async function handleLegacyLogin(req) {
  await assertLoginAllowed(req);
  const code = normCode(req.body && req.body.code);
  const athlete = code ? await getRosterAthlete(code) : null;

  if (!athlete) {
    await recordLoginAttempt(req, false);
    return { status: 401, body: { ok: false, error: 'invalid_credentials' } };
  }
  if (isBlockedRow(athlete)) {
    await recordLoginAttempt(req, true);
    return {
      status: 403,
      body: { ok: false, error: 'access_paused', name: athlete.name || '' },
    };
  }

  await recordLoginAttempt(req, true);
  return {
    status: 200,
    body: {
      ok: true,
      exists: true,
      active: true,
      code: athlete.code,
      name: athlete.name,
      start_date: athlete.start_date,
      race_target: athlete.race_target,
      auth_method: 'legacy',
      access_token: createPortalSession(athlete.code),
      expires_in: 24 * 60 * 60,
    },
  };
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res)) return;

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'POST') {
      const action = String((req.body && req.body.action) || 'legacy-login');
      if (action !== 'legacy-login') return send(res, 400, { ok: false, error: 'unknown_action' });
      const { status, body } = await handleLegacyLogin(req);
      return send(res, status, body);
    }

    if (req.method === 'GET') {
      const action = String((req.query && req.query.action) || 'me');
      if (action === 'eligibility') return send(res, 200, await handleEligibility(req));
      if (action !== 'me') return send(res, 400, { ok: false, error: 'unknown_action' });
      const { status, body } = await handleMe(req);
      return send(res, status, body);
    }

    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  } catch (err) {
    console.error('[auth-athlete]', err && err.message);
    const safe = safeError(err, 'Authentication is temporarily unavailable');
    return send(res, safe.status, { ok: false, error: safe.message });
  }
}
