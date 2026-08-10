import assert from 'node:assert/strict';
import test from 'node:test';
import { allowPortalRequest, safeError } from '../api/_lib/http.js';

process.env.PORTAL_SESSION_SECRET = 'test-only-portal-session-secret-with-32-characters';
const { createPortalSession, verifyPortalSession } = await import('../api/_lib/legacy-session.js');

function responseMock() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('portal sessions round-trip only for the correct purpose', () => {
  const token = createPortalSession('ATHLETE1');
  assert.equal(verifyPortalSession(token).code, 'ATHLETE1');
  assert.equal(verifyPortalSession(token, 'strava'), null);
});

test('tampered portal sessions are rejected', () => {
  const token = createPortalSession('ATHLETE1');
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyPortalSession(tampered), null);
});

test('cross-origin portal requests are rejected', () => {
  const req = {
    headers: {
      origin: 'https://attacker.example',
      host: 'portal.example',
      'x-forwarded-proto': 'https',
    },
  };
  const res = responseMock();
  assert.equal(allowPortalRequest(req, res), false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, { ok: false, error: 'origin_not_allowed' });
});

test('same-origin portal requests receive hardened headers', () => {
  const req = {
    headers: {
      origin: 'https://portal.example',
      host: 'portal.example',
      'x-forwarded-proto': 'https',
    },
  };
  const res = responseMock();
  assert.equal(allowPortalRequest(req, res), true);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://portal.example');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
});

test('internal errors do not leak details', () => {
  assert.deepEqual(safeError(new Error('secret database detail')), {
    status: 500,
    message: 'Request failed',
  });
  const badRequest = Object.assign(new Error('Invalid date'), { status: 400 });
  assert.deepEqual(safeError(badRequest), { status: 400, message: 'Invalid date' });
});
