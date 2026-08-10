function requestOrigin(req) {
  const origin = String((req.headers && req.headers.origin) || '').trim();
  return origin || null;
}

function sameOrigin(req) {
  const headers = req.headers || {};
  const host = String(headers['x-forwarded-host'] || headers.host || '').trim();
  if (!host) return null;
  const proto = String(headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

function configuredOrigins() {
  return String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export function allowPortalRequest(
  req,
  res,
  methods = 'GET, POST, OPTIONS',
  allowedHeaders = 'Content-Type, Authorization',
) {
  secureHeaders(res);
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
  res.setHeader('Vary', 'Origin');

  const origin = requestOrigin(req);
  if (!origin) return true;

  const normalized = origin.replace(/\/+$/, '');
  const allowed = new Set(configuredOrigins());
  const own = sameOrigin(req);
  if (own) allowed.add(own.replace(/\/+$/, ''));

  if (!allowed.has(normalized)) {
    res.status(403).json({ ok: false, error: 'origin_not_allowed' });
    return false;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  return true;
}

export function clientIp(req) {
  const headers = req.headers || {};
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim();
}

export function safeError(error, fallback = 'Request failed') {
  const status = Number(error && error.status);
  return {
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    message: status && status < 500
      ? String(error.message || fallback).slice(0, 200)
      : fallback,
  };
}
