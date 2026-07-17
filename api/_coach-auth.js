import crypto from 'node:crypto';

function configuredKey() {
  return String(process.env.DASHBOARD_ACCESS_KEY || process.env.ADMIN_KEY || '').trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function allowedCoachNames() {
  return String(process.env.COACH_NAMES || 'Karl,Alex')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function getCoachName(req) {
  const requested = String(req.headers['x-coach-name'] || '').trim();
  const names = allowedCoachNames();
  return names.find(name => name.toLowerCase() === requested.toLowerCase()) || names[0] || 'Coach';
}

export function requireCoach(req) {
  const expected = configuredKey();
  if (!expected) {
    const error = new Error('Dashboard access is not configured');
    error.status = 503;
    throw error;
  }

  const supplied = String(
    req.headers['x-dashboard-key'] ||
    req.headers['x-admin-key'] ||
    ''
  ).trim();

  if (!safeEqual(supplied, expected)) {
    const error = new Error('Dashboard access key rejected');
    error.status = 401;
    throw error;
  }

  return { coach: getCoachName(req) };
}

export function setCoachCors(req, res, methods = 'GET, POST, PATCH, OPTIONS') {
  const origin = String(req.headers.origin || '');
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Dashboard-Key, X-Admin-Key, X-Coach-Name'
  );
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

export function coachError(res, error) {
  const status = Number(error?.status) || 500;
  const publicMessage = status >= 500
    ? 'The dashboard service could not complete that request'
    : String(error?.message || 'Request rejected').slice(0, 240);
  return res.status(status).json({ ok: false, error: publicMessage });
}
