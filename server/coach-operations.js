// Coach operational queues: private athlete messages, data-rights requests and
// notification delivery health.
//
// All three tables are written by the athlete portal and are service-role only
// (RLS on, no policies). The dashboard reads them through /api/coach-data and
// changes them only through the coach-authenticated actions in api/athletes.js.
// The browser never reaches them directly.
//
// Contract: see docs/INTEGRATION.md "Shared Supabase contract".

export const DATA_REQUEST_SLA_DAYS = 30;
export const DATA_REQUEST_DUE_SOON_DAYS = 7;
const DAY_MS = 86400000;

// Coach attribution columns arrive with
// supabase/migrations/20260923100000_coach_inbox_attribution.sql. Until that has
// run the reads and writes still work, just without the "by" names.
export const MESSAGE_OPTIONAL_COLUMNS = ['read_by'];
export const REQUEST_OPTIONAL_COLUMNS = ['acknowledged_by', 'completed_by'];

function code(value) {
  return String(value || '').trim().toUpperCase();
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function text(value, max) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim().slice(0, max);
  return out || null;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function mapContactMessage(row = {}) {
  return {
    id: row.id == null ? null : String(row.id),
    athleteCode: code(row.athlete_code),
    body: text(row.body, 4000) || '',
    createdAt: iso(row.created_at),
    readAt: iso(row.read_at),
    readBy: text(row.read_by, 80),
  };
}

// Unread first (oldest unread at the top: those are the ones going stale),
// then read messages newest first.
export function sortMessages(messages) {
  return [...messages].sort((a, b) => {
    const au = a.readAt ? 1 : 0;
    const bu = b.readAt ? 1 : 0;
    if (au !== bu) return au - bu;
    if (!au) return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

// ── Data requests ────────────────────────────────────────────────────────────

export function dataRequestState(row, now = new Date()) {
  if (row.completedAt) return 'completed';
  const requested = Date.parse(row.requestedAt || '');
  if (!Number.isFinite(requested)) return 'open';
  const due = requested + DATA_REQUEST_SLA_DAYS * DAY_MS;
  const left = due - now.getTime();
  if (left < 0) return 'overdue';
  if (left <= DATA_REQUEST_DUE_SOON_DAYS * DAY_MS) return 'due_soon';
  return 'open';
}

export function mapDataRequest(row = {}, now = new Date()) {
  const requestedAt = iso(row.requested_at);
  const requestedMs = Date.parse(requestedAt || '');
  const out = {
    id: row.id == null ? null : String(row.id),
    athleteCode: code(row.athlete_code),
    kind: text(row.kind, 40),
    note: text(row.note, 2000),
    requestedAt,
    acknowledgedAt: iso(row.acknowledged_at),
    acknowledgedBy: text(row.acknowledged_by, 80),
    completedAt: iso(row.completed_at),
    completedBy: text(row.completed_by, 80),
    dueAt: Number.isFinite(requestedMs) ? new Date(requestedMs + DATA_REQUEST_SLA_DAYS * DAY_MS).toISOString() : null,
    daysOpen: Number.isFinite(requestedMs)
      ? Math.max(0, Math.floor(((Date.parse(iso(row.completed_at) || '') || now.getTime()) - requestedMs) / DAY_MS))
      : null,
  };
  out.state = dataRequestState(out, now);
  return out;
}

// Outstanding first, oldest first (closest to the 30-day line), then
// completed newest first.
export function sortDataRequests(requests) {
  return [...requests].sort((a, b) => {
    const ad = a.completedAt ? 1 : 0;
    const bd = b.completedAt ? 1 : 0;
    if (ad !== bd) return ad - bd;
    if (!ad) return String(a.requestedAt || '').localeCompare(String(b.requestedAt || ''));
    return String(b.completedAt || '').localeCompare(String(a.completedAt || ''));
  });
}

// ── Notification health ─────────────────────────────────────────────────────
// notify_status is the portal's view (20260820150000_notify_status_managed).
// "In inbox" and "pushed to a device" are different facts: an athlete with no
// registered device still gets every notification in their portal inbox, it
// just never buzzes a phone.

export function mapNotifyStatus(row = {}) {
  const devices = count(row.devices);
  const lastPush = iso(row.last_push);
  let delivery = 'no_device';
  if (devices > 0) delivery = lastPush ? 'pushing' : 'registered_not_pushed';
  return {
    athleteCode: code(row.athlete_code),
    devices,
    managed: row.notifications_managed !== false,
    exempt: row.notifications_managed === false,
    coachPref: row.coach_pref === true,
    queued: count(row.queued),
    unread: count(row.unread),
    lastNotification: iso(row.last_notification),
    lastPush,
    lastCoachSent: iso(row.last_coach_sent),
    delivery,
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

function isMissingColumn(error, column) {
  const message = String(error?.message || '');
  return message.includes(column) && /column|schema cache|does not exist|could not find/i.test(message);
}

export async function selectWithOptionalColumns(select, table, query, columns, optional) {
  let current = [...columns];
  for (let attempt = 0; attempt <= optional.length; attempt += 1) {
    try {
      return await select(table, { ...query, select: current.join(',') });
    } catch (error) {
      const missing = optional.find(column => current.includes(column) && isMissingColumn(error, column));
      if (!missing) throw error;
      current = current.filter(column => column !== missing);
    }
  }
  return select(table, { ...query, select: current.join(',') });
}

export function emptyOperations() {
  return {
    contactMessages: [],
    dataRequests: [],
    notifyStatus: [],
    operationsCounts: {
      messagesUnread: 0,
      messagesTotal: 0,
      dataRequestsOpen: 0,
      dataRequestsOverdue: 0,
      dataRequestsTotal: 0,
      notifyAthletes: 0,
      notifyNoDevice: 0,
      notifyQueued: 0,
    },
    operationsMissing: [],
  };
}

// Each source degrades on its own. A failed read is named in
// operationsMissing and never reported as an empty, successful queue.
export async function loadOperations(select, now = new Date()) {
  const out = emptyOperations();
  const [messages, requests, notify] = await Promise.all([
    selectWithOptionalColumns(select, 'contact_messages', {
      order: 'created_at.desc',
      limit: 300,
    }, ['id', 'athlete_code', 'body', 'created_at', 'read_at', 'read_by'], MESSAGE_OPTIONAL_COLUMNS)
      .catch(error => { console.warn('[coach-data] contact_messages unavailable:', error.message); return null; }),
    selectWithOptionalColumns(select, 'data_requests', {
      order: 'requested_at.desc',
      limit: 300,
    }, ['id', 'athlete_code', 'kind', 'note', 'requested_at', 'acknowledged_at', 'acknowledged_by', 'completed_at', 'completed_by'], REQUEST_OPTIONAL_COLUMNS)
      .catch(error => { console.warn('[coach-data] data_requests unavailable:', error.message); return null; }),
    select('notify_status', {
      select: 'athlete_code,devices,coach_pref,last_coach_sent,queued,notifications_managed,unread,last_notification,last_push',
    }).catch(error => { console.warn('[coach-data] notify_status unavailable:', error.message); return null; }),
  ]);

  if (messages === null) out.operationsMissing.push('contact_messages');
  else out.contactMessages = sortMessages((Array.isArray(messages) ? messages : []).map(mapContactMessage));

  if (requests === null) out.operationsMissing.push('data_requests');
  else out.dataRequests = sortDataRequests((Array.isArray(requests) ? requests : []).map(row => mapDataRequest(row, now)));

  if (notify === null) out.operationsMissing.push('notify_status');
  else out.notifyStatus = (Array.isArray(notify) ? notify : []).map(mapNotifyStatus).filter(row => row.athleteCode);

  const c = out.operationsCounts;
  c.messagesTotal = out.contactMessages.length;
  c.messagesUnread = out.contactMessages.filter(m => !m.readAt).length;
  c.dataRequestsTotal = out.dataRequests.length;
  c.dataRequestsOpen = out.dataRequests.filter(r => !r.completedAt).length;
  c.dataRequestsOverdue = out.dataRequests.filter(r => r.state === 'overdue').length;
  c.notifyAthletes = out.notifyStatus.length;
  c.notifyNoDevice = out.notifyStatus.filter(r => r.devices === 0).length;
  c.notifyQueued = out.notifyStatus.reduce((sum, r) => sum + r.queued, 0);
  return out;
}

// ── Mutations (called from api/athletes.js after coach auth) ────────────────

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validMessageId(value) {
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d{0,17}$/.test(id)) throw httpError('A valid message id is required', 400);
  return id;
}

export function validRequestId(value) {
  const id = String(value ?? '').trim();
  if (!UUID.test(id)) throw httpError('A valid data request id is required', 400);
  return id;
}

export const MESSAGE_ACTIONS = new Set(['message_read', 'message_unread']);
export const REQUEST_ACTIONS = new Set(['data_request_acknowledge', 'data_request_complete', 'data_request_reopen']);

// Server-side state machine. The browser names an intent; the server decides
// whether it is legal from the row's current state.
export function planRequestTransition(action, row, coach, now = new Date()) {
  const at = now.toISOString();
  const by = String(coach || '').trim().slice(0, 80) || 'Coach';
  if (action === 'data_request_acknowledge') {
    if (row.completed_at) throw httpError('That request is already completed', 409);
    if (row.acknowledged_at) return null; // idempotent
    return { acknowledged_at: at, acknowledged_by: by };
  }
  if (action === 'data_request_complete') {
    if (row.completed_at) return null; // idempotent
    const patch = { completed_at: at, completed_by: by };
    // Completing implies it was seen; keep the evidence trail whole.
    if (!row.acknowledged_at) Object.assign(patch, { acknowledged_at: at, acknowledged_by: by });
    return patch;
  }
  if (action === 'data_request_reopen') {
    if (!row.completed_at) throw httpError('Only a completed request can be reopened', 409);
    return { completed_at: null, completed_by: null };
  }
  throw httpError('Unsupported data request action', 400);
}

export function planMessageTransition(action, row, coach, now = new Date()) {
  const by = String(coach || '').trim().slice(0, 80) || 'Coach';
  if (action === 'message_read') {
    if (row.read_at) return null;
    return { read_at: now.toISOString(), read_by: by };
  }
  if (action === 'message_unread') {
    if (!row.read_at) return null;
    return { read_at: null, read_by: null };
  }
  throw httpError('Unsupported message action', 400);
}

// PATCH, dropping attribution columns this environment does not have yet.
async function patchTolerant(sb, path, patch, optional) {
  let body = { ...patch };
  for (let attempt = 0; attempt <= optional.length; attempt += 1) {
    try {
      return await sb(path, { method: 'PATCH', body, prefer: 'return=representation' });
    } catch (error) {
      const missing = optional.find(column => Object.hasOwn(body, column) && isMissingColumn(error, column));
      if (!missing) throw error;
      body = { ...body };
      delete body[missing];
    }
  }
  return sb(path, { method: 'PATCH', body, prefer: 'return=representation' });
}

/**
 * @param {object} deps { sb, assertAllowed(code), coach, now }
 */
export async function updateContactMessage(action, id, deps) {
  if (!MESSAGE_ACTIONS.has(action)) throw httpError('Unsupported message action', 400);
  const messageId = validMessageId(id);
  const rows = await deps.sb(`contact_messages?id=eq.${messageId}&select=id,athlete_code,read_at&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  // Same 404 for "missing" and "not yours" so ids cannot be probed.
  if (!row) throw httpError('Message not found', 404);
  try { await deps.assertAllowed(row.athlete_code); } catch (error) {
    if (Number(error?.status) === 403) throw httpError('Message not found', 404);
    throw error;
  }
  const patch = planMessageTransition(action, row, deps.coach, deps.now || new Date());
  if (!patch) return { ok: true, changed: false, message: mapContactMessage(row) };
  const updated = await patchTolerant(deps.sb, `contact_messages?id=eq.${messageId}`, patch, MESSAGE_OPTIONAL_COLUMNS);
  const next = Array.isArray(updated) && updated[0] ? updated[0] : { ...row, ...patch };
  return { ok: true, changed: true, message: mapContactMessage(next) };
}

export async function updateDataRequest(action, id, deps) {
  if (!REQUEST_ACTIONS.has(action)) throw httpError('Unsupported data request action', 400);
  const requestId = validRequestId(id);
  const rows = await deps.sb(`data_requests?id=eq.${requestId}&select=id,athlete_code,kind,note,requested_at,acknowledged_at,completed_at&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError('Data request not found', 404);
  try { await deps.assertAllowed(row.athlete_code); } catch (error) {
    if (Number(error?.status) === 403) throw httpError('Data request not found', 404);
    throw error;
  }
  const now = deps.now || new Date();
  const patch = planRequestTransition(action, row, deps.coach, now);
  if (!patch) return { ok: true, changed: false, request: mapDataRequest(row, now) };
  const updated = await patchTolerant(deps.sb, `data_requests?id=eq.${requestId}`, patch, REQUEST_OPTIONAL_COLUMNS);
  const next = Array.isArray(updated) && updated[0] ? updated[0] : { ...row, ...patch };
  return { ok: true, changed: true, request: mapDataRequest(next, now) };
}
