import crypto from 'crypto';
import { normCode } from './roster.js';

const TOKEN_PREFIX = 'dp1';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function secret() {
  const value = String(process.env.PORTAL_SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || '');
  if (value.length < 32) {
    const error = new Error('Portal session secret is not configured');
    error.status = 503;
    throw error;
  }
  return value;
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function signature(encodedPayload) {
  return crypto.createHmac('sha256', secret()).update(`${TOKEN_PREFIX}.${encodedPayload}`).digest('base64url');
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createPortalSession(code, options = {}) {
  const athleteCode = normCode(code);
  if (!athleteCode) throw new Error('Invalid athlete code');
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(Number(options.ttlSeconds) || DEFAULT_TTL_SECONDS, 7 * 24 * 60 * 60));
  const payload = {
    sub: athleteCode,
    purpose: options.purpose || 'portal',
    iat: now,
    exp: now + ttl,
    nonce: crypto.randomBytes(12).toString('base64url'),
  };
  const encoded = encode(JSON.stringify(payload));
  return `${TOKEN_PREFIX}.${encoded}.${signature(encoded)}`;
}

export function verifyPortalSession(token, purpose = 'portal') {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  if (!constantTimeEqual(parts[2], signature(parts[1]))) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.purpose !== purpose || !payload.exp || payload.exp <= now || payload.iat > now + 60) return null;
    const code = normCode(payload.sub);
    return code ? { code, exp: payload.exp, purpose: payload.purpose } : null;
  } catch {
    return null;
  }
}

export function authFingerprint(value) {
  return crypto.createHmac('sha256', secret()).update(String(value || 'unknown')).digest('hex');
}
