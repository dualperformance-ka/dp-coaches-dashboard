import assert from 'node:assert/strict';
import test from 'node:test';

import handler from '../api/progress-photos.js';

function responseRecorder() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

test('week lookup stays inside the exact Cloudinary week folder', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    DASHBOARD_ACCESS_KEY: process.env.DASHBOARD_ACCESS_KEY,
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  };

  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';

  let requestedUrl = '';
  global.fetch = async url => {
    requestedUrl = String(url);
    return {
      ok: true,
      async json() {
        return {
          resources: [
            { public_id: 'dp_progress/alex/week1/alex_week1_front', secure_url: 'https://img/week1.jpg' },
            { public_id: 'dp_progress/alex/week10/alex_week10_front', secure_url: 'https://img/week10.jpg' },
            { public_id: 'dp_progress/alex/week12/alex_week12_front', secure_url: 'https://img/week12.jpg' },
          ],
        };
      },
    };
  };

  try {
    const req = {
      method: 'GET',
      query: { athlete: 'ALEX', week: '1' },
      headers: { 'x-dashboard-key': 'dashboard-key' },
    };
    const res = responseRecorder();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(new URL(requestedUrl).searchParams.get('prefix'), 'dp_progress/alex/week1/');
    assert.equal(res.body.folder, 'dp_progress/alex/week1');
    assert.deepEqual(res.body.photos.map(photo => photo.publicId), [
      'dp_progress/alex/week1/alex_week1_front',
    ]);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('invalid week input is rejected instead of listing every athlete photo', async () => {
  const originalKey = process.env.DASHBOARD_ACCESS_KEY;
  process.env.DASHBOARD_ACCESS_KEY = 'dashboard-key';
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; };

  try {
    const req = {
      method: 'GET',
      query: { athlete: 'ALEX', week: '12junk' },
      headers: { 'x-dashboard-key': 'dashboard-key' },
    };
    const res = responseRecorder();

    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /non-negative integer/);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DASHBOARD_ACCESS_KEY;
    else process.env.DASHBOARD_ACCESS_KEY = originalKey;
  }
});
