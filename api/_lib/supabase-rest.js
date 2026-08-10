function env() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase service credentials not configured');
  return { url: url.replace(/\/+$/, ''), key };
}

function qs(params) {
  return Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export async function supabaseRequest(path, options = {}) {
  const { url, key } = env();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.message || data?.error || `Supabase ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export function tablePath(table, query) {
  const queryString = qs(query);
  return queryString ? `${table}?${queryString}` : table;
}

export async function upsert(table, rows, onConflict) {
  const path = tablePath(table, onConflict ? { on_conflict: onConflict } : {});
  return supabaseRequest(path, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: Array.isArray(rows) ? rows : [rows],
  });
}

export async function insert(table, rows) {
  return supabaseRequest(table, {
    method: 'POST',
    prefer: 'return=representation',
    body: Array.isArray(rows) ? rows : [rows],
  });
}

export async function patch(table, query, values) {
  return supabaseRequest(tablePath(table, query), {
    method: 'PATCH',
    prefer: 'return=representation',
    body: values,
  });
}

export async function remove(table, query) {
  return supabaseRequest(tablePath(table, query), {
    method: 'DELETE',
    prefer: 'return=minimal',
  });
}

export async function select(table, query) {
  return supabaseRequest(tablePath(table, query), { method: 'GET' });
}
