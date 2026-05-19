const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const BASE = 'https://api.notion.com/v1';

function headers() {
  return {
    'Authorization': `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

function rt(arr) {
  if (!arr || !arr.length) return '';
  return arr.map(t => t.plain_text || '').join('');
}

function flattenProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    switch (v.type) {
      case 'title':        out[k] = rt(v.title); break;
      case 'rich_text':    out[k] = rt(v.rich_text); break;
      case 'number':       out[k] = v.number; break;
      case 'select':       out[k] = v.select ? v.select.name : null; break;
      case 'multi_select': out[k] = v.multi_select.map(s => s.name).join(', '); break;
      case 'date':
        out[k] = v.date ? v.date.start : null;
        out[`date:${k}:start`] = v.date ? v.date.start : null;
        out[`date:${k}:end`]   = v.date ? v.date.end   : null;
        out[`date:${k}:is_datetime`] = v.date ? (v.date.start && v.date.start.includes('T') ? 1 : 0) : 0;
        break;
      case 'checkbox':     out[k] = v.checkbox; break;
      case 'url':          out[k] = v.url; break;
      case 'email':        out[k] = v.email; break;
      case 'phone_number': out[k] = v.phone_number; break;
      case 'formula':
        out[k] = v.formula ? (v.formula.string || v.formula.number || v.formula.boolean) : null;
        break;
      case 'relation': out[k] = null; break;
      case 'rollup':
        if (v.rollup && v.rollup.type === 'array') {
          out[k] = v.rollup.array.map(i => flattenProps({_: i})['_']).filter(Boolean);
        } else if (v.rollup) {
          out[k] = v.rollup.number || v.rollup.date || null;
        }
        break;
      case 'people': out[k] = v.people.map(p => p.name || p.id).join(', '); break;
      case 'files': out[k] = v.files.map(f => f.name).join(', '); break;
      case 'created_time': out[k] = v.created_time; break;
      case 'last_edited_time': out[k] = v.last_edited_time; break;
      default:             out[k] = null;
    }
  }
  return out;
}

function flattenBlock(block) {
  const type = block.type;
  const data = block[type] || {};
  return {
    id: block.id,
    type,
    text: rt(data.rich_text),
    checked: data.checked ?? null,
    color: data.color ?? null,
    has_children: block.has_children ?? false,
    url: data.url ?? null
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { db, cursor, page } = req.query;

  // ── Page block fetching ──────────────────────────────────────────────────
  if (page) {
    try {
      const all = [];
      let next = undefined;
      do {
        const url = `${BASE}/blocks/${page}/children?page_size=100${next ? `&start_cursor=${next}` : ''}`;
        const r = await fetch(url, { headers: headers() });
        const data = await r.json();
        if (data.object === 'error') return res.status(400).json({ error: data.message });
        (data.results || []).forEach(b => all.push(flattenBlock(b)));
        next = data.has_more ? data.next_cursor : null;
      } while (next);
      return res.json({ results: all });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Database query ───────────────────────────────────────────────────────
  if (!db) return res.status(400).json({ error: 'Missing ?db= query parameter' });

  try {
    const all = [];
    let next = cursor || undefined;
    let hasMore = true;
    while (hasMore) {
      const body = { page_size: 100 };
      if (next) body.start_cursor = next;
      const r = await fetch(`${BASE}/databases/${db}/query`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (data.object === 'error') return res.status(400).json({ error: data.message });
      (data.results || []).forEach(row => {
        const flat = flattenProps(row.properties);
        flat._id = row.id;
        flat._url = row.url;
        flat._createdTime = row.created_time;
        all.push(flat);
      });
      hasMore = data.has_more && !cursor;
      next = data.next_cursor;
    }
    return res.json({ results: all });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
