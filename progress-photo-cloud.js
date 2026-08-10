import crypto from 'crypto';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_SLOTS = new Set(['front', 'side', 'back', 'front_flexed', 'back_flexed']);

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function parseCloudinaryUrl() {
  // Prefer individual env vars (simpler, no URL-format mistakes)
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (cloudName && apiKey && apiSecret) {
    return { cloudName, apiKey, apiSecret };
  }

  // Fall back to CLOUDINARY_URL (format: cloudinary://API_KEY:API_SECRET@cloud_name)
  const value = process.env.CLOUDINARY_URL;
  if (!value) throw new Error('Cloudinary credentials not configured.');

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('CLOUDINARY_URL is not a valid URL. Expected: cloudinary://API_KEY:API_SECRET@cloud_name');
  }

  return {
    cloudName: parsed.hostname,
    apiKey: decodeURIComponent(parsed.username),
    apiSecret: decodeURIComponent(parsed.password),
  };
}

function cleanSlug(value, fallback = '') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function athleteCandidates(payload) {
  // Identity is the athlete CODE only — never the athlete's name. This keeps
  // every photo filed under a stable key that doesn't change if the athlete
  // renames, and stops two athletes with similar names from colliding.
  return Array.from(new Set([
    cleanSlug(payload.athleteCode),
  ].filter(Boolean)));
}

function cleanWeek(value) {
  const match = String(value || '').match(/\d+/);
  const number = match ? Math.max(0, Math.min(80, Number(match[0]))) : 1;
  return `week${number}`;
}

function cleanSlot(value) {
  const slot = cleanSlug(value || 'front');
  return ALLOWED_SLOTS.has(slot) ? slot : 'front';
}

function authHeader(apiKey, apiSecret) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

function signParams(params, apiSecret) {
  const payload = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');

  return crypto.createHash('sha1').update(payload + apiSecret).digest('hex');
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error('Expected a jpeg, png, or webp data URL');

  const bytes = Buffer.byteLength(match[2], 'base64');
  if (bytes > MAX_IMAGE_BYTES) throw new Error('Image is too large');

  return dataUrl;
}

function normalizeResource(resource) {
  const parts = String(resource.public_id || '').split('/');
  const filename = parts[parts.length - 1] || '';
  const week = parts.find((part) => /^week\d+$/i.test(part)) || '';
  const slot = filename
    .replace(/^.*?_week\d+_/i, '')
    .replace(/\.(jpg|jpeg|png|webp)$/i, '') || 'front';

  return {
    publicId: resource.public_id,
    secureUrl: resource.secure_url,
    createdAt: resource.created_at,
    week: week.toLowerCase(),
    slot: slot.toLowerCase(),
    width: resource.width,
    height: resource.height,
  };
}

async function listPhotosForAthlete({ cloudName, apiKey, apiSecret }, athlete) {
  const prefixes = Array.from(new Set([
    `dp_progress/${athlete}/`,
    `dp_progress/${athlete.toUpperCase()}/`,
  ]));

  const all = [];

  for (const prefix of prefixes) {
    const url = new URL(`https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload`);
    url.searchParams.set('type', 'upload');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max_results', '100');

    const response = await fetch(url, {
      headers: { Authorization: authHeader(apiKey, apiSecret) },
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'Unable to list Cloudinary photos');
    all.push(...(data.resources || []));
  }

  return all;
}

async function listPhotos(config, candidates) {
  const byPublicId = new Map();

  for (const athlete of candidates) {
    const resources = await listPhotosForAthlete(config, athlete);
    resources.forEach((resource) => byPublicId.set(resource.public_id, resource));
  }

  return Array.from(byPublicId.values())
    .map(normalizeResource)
    .sort((a, b) => String(a.week).localeCompare(String(b.week), undefined, { numeric: true }) || String(a.slot).localeCompare(String(b.slot)));
}

async function uploadPhoto(config, payload) {
  // Store strictly under the athlete CODE. If no code is supplied we reject the
  // upload rather than silently filing the photo under the athlete's name.
  const athlete = cleanSlug(payload.athleteCode);
  if (!athlete) throw new Error('athleteCode is required');

  const week = cleanWeek(payload.week);
  const slot = cleanSlot(payload.slot);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `dp_progress/${athlete}/${week}/${athlete}_${week}_${slot}`;
  const tags = `dp_progress,${athlete},${week}`;
  const params = {
    overwrite: true,
    public_id: publicId,
    tags,
    timestamp,
  };

  const form = new FormData();
  form.set('file', parseDataUrl(payload.imageData));
  form.set('api_key', config.apiKey);
  form.set('timestamp', String(timestamp));
  form.set('public_id', publicId);
  form.set('overwrite', 'true');
  form.set('tags', tags);
  form.set('signature', signParams(params, config.apiSecret));

  const response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, {
    method: 'POST',
    body: form,
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Unable to upload Cloudinary photo');

  return normalizeResource(data);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    const config = parseCloudinaryUrl();
    const body = req.body || {};
    const action = String(body.action || 'list');
    const candidates = athleteCandidates(body);

    if (candidates.length === 0) return send(res, 400, { error: 'athleteCode is required' });

    if (action === 'list') {
      return send(res, 200, { photos: await listPhotos(config, candidates) });
    }

    if (action === 'upload') {
      return send(res, 201, { photo: await uploadPhoto(config, body) });
    }

    return send(res, 400, { error: 'Unknown action' });
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
}
