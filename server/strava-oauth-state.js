import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_TTL_MS = 15 * 60 * 1000;

function stateSecret() {
  return process.env.STRAVA_STATE_SECRET || process.env.DASHBOARD_ACCESS_KEY || '';
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createStravaState(athleteCode, now = Date.now()) {
  const code = String(athleteCode || '').trim().toUpperCase();
  const secret = stateSecret();
  if (!secret) throw new Error('STRAVA_STATE_SECRET is not configured');
  if (!/^[A-Z0-9_-]{1,64}$/.test(code)) throw new Error('Invalid athlete code');
  const payload = base64url(JSON.stringify({ code, iat: now, nonce: randomBytes(12).toString('base64url') }));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyStravaState(state, now = Date.now()) {
  try {
    const secret = stateSecret();
    const [payload, providedSignature, extra] = String(state || '').split('.');
    if (!secret || !payload || !providedSignature || extra) return null;
    const expected = Buffer.from(signature(payload, secret));
    const provided = Buffer.from(providedSignature);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const code = String(parsed?.code || '').trim().toUpperCase();
    const issuedAt = Number(parsed?.iat);
    if (!/^[A-Z0-9_-]{1,64}$/.test(code) || !parsed?.nonce || !Number.isFinite(issuedAt)) return null;
    if (issuedAt > now + 60_000 || now - issuedAt > STATE_TTL_MS) return null;
    return { code, issuedAt };
  } catch {
    return null;
  }
}

export function stravaRedirectUri(req) {
  const configured = String(process.env.STRAVA_REDIRECT_URI || '').trim();
  if (configured) return configured;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  if (!host || !/^https?$/.test(protocol)) throw new Error('STRAVA_REDIRECT_URI is not configured');
  return `${protocol}://${host}/api/strava-callback`;
}

export function createStravaAuthorizeUrl(req, athleteCode) {
  if (!process.env.STRAVA_CLIENT_ID) throw new Error('STRAVA_CLIENT_ID is not configured');
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: stravaRedirectUri(req),
    approval_prompt: 'auto',
    scope: 'activity:read_all,profile:read_all',
    state: createStravaState(athleteCode),
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}
