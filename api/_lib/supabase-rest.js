// Shared by the portal-facing routes (auth, bookings, ingest, reminders, my-logs,
// strava cache). Every call goes through the bounded helper, so a Supabase
// outage fails within the deadline instead of holding the function open, and
// the error is classified (see supabase-fetch.js) rather than a bare Error.
import { supabaseFetch } from './supabase-fetch.js';

function qs(params) {
  return Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export async function supabaseRequest(path, options = {}) {
  return supabaseFetch(path, {
    method: options.method || 'GET',
    body: options.body,
    prefer: options.prefer || 'return=representation',
    headers: options.headers,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
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
