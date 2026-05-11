// api/progress-photos.js — Cloudinary progress photo lookup
// Reads Cloudinary credentials server-side and returns matched athlete/week assets.

function parseCloudinaryUrl() {
  const raw = process.env.CLOUDINARY_URL;
  if (raw) {
    try {
      const url = new URL(raw);
      return {
        cloudName: url.hostname,
        apiKey: decodeURIComponent(url.username),
        apiSecret: decodeURIComponent(url.password),
      };
    } catch {
      throw new Error('CLOUDINARY_URL is not valid');
    }
  }

  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  };
}

function cleanSegment(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, '');
}

function inferPhotoType(publicId) {
  const name = String(publicId || '').split('/').pop() || '';
  const raw = name
    .replace(/^[a-z0-9_-]+_week\d+_/i, '')
    .replace(/\.(jpg|jpeg|png|webp)$/i, '');

  return raw
    .split(/[_-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Progress Photo';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { athlete, week } = req.query;
  const athleteSlug = cleanSegment(athlete);
  const weekNum = parseInt(week, 10);

  if (!athleteSlug) {
    res.status(400).json({ error: 'Missing ?athlete= query parameter' });
    return;
  }

  const { cloudName, apiKey, apiSecret } = parseCloudinaryUrl();
  if (!cloudName || !apiKey || !apiSecret) {
    res.status(500).json({ error: 'Cloudinary credentials are not configured' });
    return;
  }

  const folder = weekNum >= 0
    ? `dp_progress/${athleteSlug}/week${weekNum}`
    : `dp_progress/${athleteSlug}`;

  const expression = `folder="${folder}"`;
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  try {
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/resources/search`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expression,
        max_results: 30,
        sort_by: [{ public_id: 'asc' }],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error?.message || `Cloudinary API ${response.status}`);
    }

    const photos = (data.resources || []).map(asset => ({
      publicId: asset.public_id,
      type: inferPhotoType(asset.public_id),
      url: asset.secure_url,
      thumbUrl: asset.secure_url?.replace('/upload/', '/upload/f_auto,q_auto,c_fill,g_auto,w_420,h_560/'),
      width: asset.width,
      height: asset.height,
      createdAt: asset.created_at,
      format: asset.format,
    }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    res.status(200).json({ athlete: athleteSlug, week: weekNum, folder, photos });
  } catch (e) {
    console.error('[progress-photos]', e.message);
    res.status(500).json({ error: e.message });
  }
};
