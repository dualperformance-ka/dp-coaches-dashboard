// api/notion.js — Vercel serverless function
// Proxies Notion API calls so the token stays server-side and CORS is handled.

const NOTION_VERSION = '2022-06-28';
const MAX_PAGES = 600; // safety cap

// ─── Property parser ──────────────────────────────────────────────────────────

function extractProp(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':
      return prop.title?.map(t => t.plain_text).join('') ?? '';
    case 'rich_text':
      return prop.rich_text?.map(t => t.plain_text).join('') ?? '';
    case 'number':
      return prop.number ?? null;
    case 'date':
      return prop.date?.start ?? null;
    case 'select':
      return prop.select?.name ?? null;
    case 'multi_select':
      return (prop.multi_select ?? []).map(s => s.name);
    case 'relation':
      return (prop.relation ?? []).map(r => r.id);
    case 'created_time':
      return prop.created_time ?? null;
    case 'checkbox':
      return prop.checkbox ?? null;
    case 'url':
      return prop.url ?? null;
    case 'email':
      return prop.email ?? null;
    case 'phone_number':
      return prop.phone_number ?? null;
    default:
      return null;
  }
}

function parsePage(page) {
  const out = {
    _id: page.id,
    _url: page.url,
    _createdTime: page.created_time,
  };
  for (const [key, val] of Object.entries(page.properties ?? {})) {
    out[key] = extractProp(val);
    // Mirror the MCP tool's date expansion for date-type properties
    if (val?.type === 'date') {
      out[`date:${key}:start`] = val.date?.start ?? null;
      out[`date:${key}:end`] = val.date?.end ?? null;
      out[`date:${key}:is_datetime`] = val.date?.start?.includes('T') ? 1 : 0;
    }
  }
  return out;
}

// ─── Notion API call ──────────────────────────────────────────────────────────

async function queryDatabase(dbId, token, startCursor = null) {
  const body = { page_size: 100 };
  if (startCursor) body.start_cursor = startCursor;

  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Notion API ${res.status}: ${err.message || res.statusText}`);
  }

  return res.json();
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS – open so the dashboard can be hosted anywhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { db } = req.query;
  if (!db) {
    res.status(400).json({ error: 'Missing ?db= query parameter' });
    return;
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'NOTION_TOKEN environment variable is not set' });
    return;
  }

  try {
    let allResults = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore && allResults.length < MAX_PAGES) {
      const data = await queryDatabase(db, token, cursor);
      allResults = allResults.concat(data.results.map(parsePage));
      hasMore = data.has_more;
      cursor = data.next_cursor;
    }

    // Cache for 60 seconds at the CDN edge
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    res.status(200).json({ results: allResults, total: allResults.length });
  } catch (e) {
    console.error('[notion-proxy]', e.message);
    res.status(500).json({ error: e.message });
  }
};
