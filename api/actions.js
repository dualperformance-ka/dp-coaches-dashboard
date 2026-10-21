import { allowedCoachNames, coachError, requireCoach, setCoachCors } from '../server/coach-auth.js';
import { isUpstreamUnavailable, supabaseFetch, withSupabaseRoute } from './_lib/supabase-fetch.js';

const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const STATUSES = new Set(['open', 'in_progress', 'waiting', 'done', 'cancelled']);
// What the board shows outside the Completed tab. Cancelled actions are not
// rendered anywhere, so they are never polled.
export const ACTIVE_STATUSES = ['open', 'in_progress', 'waiting'];
// Exactly the columns public/coaching-actions.js renders or edits. source and
// source_key are server bookkeeping the board never reads.
export const ACTION_COLUMNS = 'id,athlete_code,title,category,priority,status,owner,due_at,notes,outcome,created_by,updated_by,completed_by,created_at,updated_at,completed_at';
const ACTION_ORDER = 'order=due_at.asc.nullslast,created_at.desc';
const ACTION_LIMIT = 500;

// /api/actions has maxDuration 15s in vercel.json. All Supabase work for one
// request must finish (or be abandoned) inside 10s so the function always
// answers before Vercel kills it.
export const ACTIONS_BUDGET_MS = 10000;
export const ACTIONS_TIMEOUT_MS = 8000;

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

async function sb(path, { method = 'GET', body, prefer, count } = {}) {
  return supabaseFetch(path, { method, body, prefer, count });
}

// GET query for the board. `status` is:
//   active (default for the board's background refresh) - open, in progress, waiting
//   done   - the Completed tab, loaded only when a coach opens it
//   all    - the previous contract, kept for any older client still polling it
//   <one status> - a single status
export function actionQuery({ status = '', athlete = '' } = {}) {
  const filters = [`select=${ACTION_COLUMNS}`, ACTION_ORDER, `limit=${ACTION_LIMIT}`];
  if (status === 'active') filters.push(`status=in.(${ACTIVE_STATUSES.join(',')})`);
  else if (status && status !== 'all') filters.push(`status=eq.${encodeURIComponent(status)}`);
  if (athlete) filters.push(`athlete_code=eq.${encodeURIComponent(athlete)}`);
  return `coach_actions?${filters.join('&')}`;
}

// The Completed tab's label needs a number, not the rows. HEAD + count=exact on
// the (status, due_at, created_at) index returns no body at all.
export function completedCountQuery({ athlete = '' } = {}) {
  const filters = ['select=id', 'status=eq.done'];
  if (athlete) filters.push(`athlete_code=eq.${encodeURIComponent(athlete)}`);
  return `coach_actions?${filters.join('&')}`;
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

async function handler(req, res) {
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
      if (status && status !== 'all' && status !== 'active' && !STATUSES.has(status)) {
        return res.status(400).json({ ok: false, error: `Invalid value: ${status}` });
      }
      if (status === 'active') {
        const [actions, completed] = await Promise.all([
          sb(actionQuery({ status, athlete })),
          sb(completedCountQuery({ athlete }), { method: 'HEAD', count: true }),
        ]);
        return res.status(200).json({
          ok: true,
          actions: Array.isArray(actions) ? actions : [],
          completedCount: Number.isFinite(completed?.count) ? completed.count : null,
        });
      }
      const actions = await sb(actionQuery({ status, athlete }));
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
    // Upstream failures are already logged as structured supabase_request
    // lines; logging the error object again would add nothing but noise.
    if ((Number(error?.status) || 500) >= 500 && !isUpstreamUnavailable(error)) console.error('[actions]', error);
    return coachError(res, error);
  }
}

export default withSupabaseRoute('/api/actions', {
  budgetMs: ACTIONS_BUDGET_MS,
  timeoutMs: ACTIONS_TIMEOUT_MS,
  mode: req => (req.method === 'GET'
    ? (String(req.query?.mode || '') === 'session' ? 'session' : `list_${String(req.query?.status || 'all')}`)
    : String(req.method || '').toLowerCase()),
}, handler);
