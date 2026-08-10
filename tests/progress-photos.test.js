import assert from 'node:assert/strict';
import test from 'node:test';

import handler from '../api/progress-photos.js';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return undefined; },
  };
}

test('week 2 query uses an exact folder boundary and excludes week 20+', async () => {
  const originalFetch = global.fetch;
  const originalCloudinaryUrl = process.env.CLOUDINARY_URL;
  const originalAccessKey = process.env.DASHBOARD_ACCESS_KEY;
  let requestedUrl = '';

  process.env.CLOUDINARY_URL = 'cloudinary://test-key:test-secret@test-cloud';
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';
  global.fetch = async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      resources: [
        { public_id: 'dp_progress/jacob/week2/jacob_week2_front', secure_url: 'week2.jpg' },
        { public_id: 'dp_progress/jacob/week20/jacob_week20_front', secure_url: 'week20.jpg' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const req = {
      method: 'GET',
      query: { athlete: 'Jacob', week: '2' },
      headers: { 'x-dashboard-key': 'dashboard-key', 'x-coach-name': 'Karl' },
    };
    const res = responseRecorder();
    await handler(req, res);

    const requestUrl = new URL(requestedUrl);
    assert.equal(requestUrl.searchParams.get('prefix'), 'dp_progress/jacob/week2/');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.folder, 'dp_progress/jacob/week2');
    assert.deepEqual(res.body.photos.map(photo => photo.publicId), [
      'dp_progress/jacob/week2/jacob_week2_front',
    ]);
  } finally {
    global.fetch = originalFetch;
    if (originalCloudinaryUrl === undefined) delete process.env.CLOUDINARY_URL;
    else process.env.CLOUDINARY_URL = originalCloudinaryUrl;
    if (originalAccessKey === undefined) delete process.env.DASHBOARD_ACCESS_KEY;
    else process.env.DASHBOARD_ACCESS_KEY = originalAccessKey;
  }
});

test('rejects unsupported methods without calling Cloudinary', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; };

  try {
    const req = { method: 'POST', query: {}, headers: {} };
    const res = responseRecorder();
    await handler(req, res);

    assert.equal(res.statusCode, 405);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});
