import { allowedCoachNames, coachError, requireCoach, setCoachCors } from '../server/coach-auth.js';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const STATUSES = new Set(['open', 'in_progress', 'waiting', 'done', 'cancelled']);

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function code(value) {
  const clean = text(value, 24).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) throw Object.assign(new Error('Athlete is required'), { status: 400 });
  return clean;
}

function date(value) {
  if (!value) return null;
  const clean = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    throw Object.assign(new Error('Due date must be YYYY-MM-DD'), { status: 400 });
  }
  return clean;
}

// `fallback` is for a field that was not supplied at all. An explicitly empty
// value used to fall through to it, so a PATCH carrying status:"" silently reset
// a completed action to 'open' and wiped completed_at / completed_by.
function enumValue(value, allowed, fallback) {
  const clean = text(value, 40).toLowerCase();
  if (!clean) return fallback;
  if (!allowed.has(clean)) throw Object.assign(new Error(`Invalid value: ${clean}`), { status: 400 });
  return clean;
}

// Present AND meaningful. A key sent as "" or null is a cleared form field, not
// an instruction to reset the column to its default.
function supplied(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

async function sb(path, { method = 'GET', body, prefer } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase is not configured');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* handled below */ }
  if (!response.ok) throw new Error(data?.message || data?.error || `Action store returned ${response.status}`);
  return data;
}

export function createPayload(input, coach, now = new Date()) {
  const title = text(input.title, 180);
  if (!title) throw Object.assign(new Error('Action title is required'), { status: 400 });
  const status = enumValue(input.status, STATUSES, 'open');
  const payload = {
    athlete_code: code(input.athlete_code),
    title,
    category: text(input.category, 60) || 'coaching',
    priority: enumValue(input.priority, PRIORITIES, 'normal'),
    status,
    owner: text(input.owner, 80) || coach,
    due_at: date(input.due_at),
    source: text(input.source, 60) || 'manual',
    source_key: text(input.source_key, 180) || null,
    notes: text(input.notes, 4000) || null,
    outcome: text(input.outcome, 4000) || null,
    created_by: coach,
    updated_by: coach,
  };
  if (status === 'done') {
    payload.completed_at = now.toISOString();
    payload.completed_by = coach;
  }
  return payload;
}

export function updatePayload(input, coach, now = new Date()) {
  const out = { updated_at: now.toISOString(), updated_by: coach };
  if ('title' in input) {
    out.title = text(input.title, 180);
    if (!out.title) throw Object.assign(new Error('Action title is required'), { status: 400 });
  }
  if ('athlete_code' in input) out.athlete_code = code(input.athlete_code);
  if ('category' in input) out.category = text(input.category, 60) || 'coaching';
  if (supplied(input.priority)) out.priority = enumValue(input.priority, PRIORITIES, 'normal');
  if (supplied(input.status)) out.status = enumValue(input.status, STATUSES, 'open');
  if ('owner' in input) out.owner = text(input.owner, 80) || null;
  if ('due_at' in input) out.due_at = date(input.due_at);
  if ('notes' in input) out.notes = text(input.notes, 4000) || null;
  if ('outcome' in input) out.outcome = text(input.outcome, 4000) || null;
  if (out.status === 'done') {
    out.completed_at = now.toISOString();
    out.completed_by = coach;
  }
  if (out.status && out.status !== 'done') {
    out.completed_at = null;
    out.completed_by = null;
  }
  return out;
}

export default async function handler(req, res) {
  setCoachCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { coach } = requireCoach(req);

    if (req.method === 'GET' && String(req.query.mode || '') === 'session') {
      return res.status(200).json({ ok: true, coach, coaches: allowedCoachNames() });
    }

    if (req.method === 'GET') {
      const status = text(req.query.status, 40).toLowerCase();
      const athlete = text(req.query.athlete, 24).toUpperCase();
      const filters = ['select=*', 'order=due_at.asc.nullslast,created_at.desc', 'limit=500'];
      if (status && status !== 'all') filters.push(`status=eq.${encodeURIComponent(status)}`);
      if (athlete) filters.push(`athlete_code=eq.${encodeURIComponent(athlete)}`);
      const actions = await sb(`coach_actions?${filters.join('&')}`);
      return res.status(200).json({ ok: true, actions: Array.isArray(actions) ? actions : [] });
    }

    if (req.method === 'POST') {
      const payload = createPayload(req.body || {}, coach);
      const rows = await sb('coach_actions', {
        method: 'POST', body: payload, prefer: 'return=representation',
      });
      return res.status(201).json({ ok: true, action: rows?.[0] || null });
    }

    if (req.method === 'PATCH') {
      const id = text(req.body?.id, 80);
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        return res.status(400).json({ ok: false, error: 'Valid action id is required' });
      }
      const updates = updatePayload(req.body || {}, coach);
      const rows = await sb(`coach_actions?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: updates, prefer: 'return=representation',
      });
      if (!rows?.[0]) return res.status(404).json({ ok: false, error: 'Action not found' });
      return res.status(200).json({ ok: true, action: rows[0] });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    if ((Number(error?.status) || 500) >= 500) console.error('[actions]', error);
    return coachError(res, error);
  }
}
