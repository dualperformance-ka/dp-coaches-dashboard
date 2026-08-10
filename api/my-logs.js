// /api/my-logs.js — athlete-facing read of the structured, source-of-truth logs.
// The progress tab cannot read daily_body_logs directly (anon access is revoked
// by design), so this serverless function returns the athlete's own body logs
// using the service key, scoped to their athlete_code. This keeps the athlete's
// progress view in sync with exactly what the coach dashboard sees.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY (already set for /api/ingest).
import { select } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest } from './_lib/http.js';

function send(res, status, payload) {
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'GET, OPTIONS')) return;

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });

  try {
    const identity = await getRequestAthlete(req);
    if (!identity) return send(res, 401, { ok: false, error: 'invalid_session', body: [] });
    const code = identity.athlete.code;
    const body = await select('daily_body_logs', {
      athlete_code: `eq.${code}`,
      select: 'log_date,weight,sleep,energy,stress,soreness,notes,raw_payload,submitted_at',
      order: 'log_date.desc',
      limit: '400',
    });
    return send(res, 200, { ok: true, body: Array.isArray(body) ? body : [] });
  } catch (e) {
    return send(res, 502, { ok: false, error: 'Unable to load body logs', body: [] });
  }
}
