// Coach queue model. Pure functions, no DOM, no network.
//
// Today used to answer "who needs me" with a server-ranked queue AND a
// separate review list beside it, so an athlete with an overdue review showed
// up twice with two different rule sets. This module is the one place that
// decides, per athlete:
//
//   * which category the work belongs to (Urgent / Review / Follow up / Plan),
//   * which of their signals is the primary reason they are in the queue,
//   * what the coach's next action and completion verb are,
//   * and the athlete's status everywhere else in the app (Squad, profile).
//
// It is an ES module so node:test can import it directly. The browser loads it
// as a module script and it publishes itself on window.DP_QUEUE, which the
// classic scripts (triage.js, index.html) read at render time.

export const CATEGORIES = ['urgent', 'review', 'followup', 'plan'];

export const CATEGORY_LABELS = {
  urgent: 'Urgent',
  review: 'Review',
  followup: 'Follow up',
  plan: 'Plan',
};

const CATEGORY_RANK = { urgent: 0, review: 1, followup: 2, plan: 3 };

// Every server flag, including the two Strava rows that are not built yet.
// A missing entry falls back to Follow up rather than silently vanishing.
export const FLAG_CATEGORY = {
  pain: 'urgent',
  awaiting_review: 'review',
  gone_quiet: 'followup',
  compliance_drift: 'plan',
  load_divergence: 'plan',
  pace_mismatch: 'plan',
};

const FLAG_STATUS = {
  pain: 'Pain reported',
  gone_quiet: 'Gone quiet',
  compliance_drift: 'Compliance drift',
  awaiting_review: 'Review overdue',
  load_divergence: 'Load vs recovery',
  pace_mismatch: 'Easy-day pace',
};

// The athlete status hierarchy. The highest active state wins, so an athlete
// can never read "On track" while an unresolved signal or review is open.
export const STATUS = {
  urgent: { key: 'urgent', rank: 1, label: 'Urgent', tone: 'alert' },
  attention: { key: 'attention', rank: 2, label: 'Needs attention', tone: 'warn' },
  review: { key: 'review', rank: 3, label: 'Review due', tone: 'warn' },
  ontrack: { key: 'ontrack', rank: 4, label: 'On track', tone: 'ok' },
  nodata: { key: 'nodata', rank: 5, label: 'No recent data', tone: 'neutral' },
};

export const STATUS_ORDER = ['urgent', 'attention', 'review', 'ontrack', 'nodata'];

const upper = value => String(value || '').trim().toUpperCase();

// Client-computed alert lines are written by the dashboard itself
// (buildActionList and derivedSignalsFor in index.html), so their phrasing is
// a closed set. Each pattern below names the generator it matches; the tests
// run every generated phrase through this function.
export function classifyClientLine(text, critical = false) {
  const t = String(text || '').toLowerCase();
  // Run/Lift niggle — pain words make it critical upstream.
  if (/niggle|pain|injur|strain|physio|tear/.test(t)) return critical ? 'urgent' : 'followup';
  // Stale check-in, stress, motivation, sleep, recovery decline: talk to them.
  if (/check-in|motivation|stress|sleep|recovery|message/.test(t)) return 'followup';
  // Compliance, volume, strength stalls, skipped lifts, easy-run RPE, fuel and
  // weight: these change the plan, not the conversation.
  if (/compliance|volume|stalled|done \d+ of \d+|rpe|calories|protein|weight|load|pace/.test(t)) return 'plan';
  return 'followup';
}

function clientStatusLabel(category, text) {
  const t = String(text || '').toLowerCase();
  if (category === 'urgent') return /niggle/.test(t) ? 'Niggle reported' : 'Urgent';
  if (category === 'followup') {
    if (/check-in/.test(t)) return 'Missed check-in';
    if (/recovery/.test(t)) return 'Low recovery';
    if (/sleep/.test(t)) return 'Poor sleep';
    if (/stress/.test(t)) return 'High stress';
    if (/motivation/.test(t)) return 'Low motivation';
    if (/niggle/.test(t)) return 'Niggle reported';
    return 'Follow up';
  }
  if (/compliance/.test(t)) return 'Low adherence';
  if (/volume/.test(t)) return 'Load change';
  if (/stalled|done \d+ of/.test(t)) return 'Strength stalled';
  if (/calories|protein/.test(t)) return 'Fuel variance';
  if (/weight/.test(t)) return 'Weight drift';
  if (/rpe/.test(t)) return 'Easy runs too hard';
  return 'Plan check';
}

export function ageCopy(days) {
  const n = Number(days) || 0;
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return `${n} days`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function serverSignal(row) {
  const flag = row.flag || '';
  const category = flag === 'client_alert'
    ? classifyClientLine(row.signal, row.severity === 'critical')
    : (FLAG_CATEGORY[flag] || 'followup');
  let status = FLAG_STATUS[flag] || clientStatusLabel(category, row.signal);
  const pain = row.evidence?.pain;
  if (flag === 'pain' && pain) {
    if (pain.score !== null && pain.score !== undefined) status = `Pain ${pain.score}/10`;
    else if (pain.coachAlert) status = 'Coach alert';
  }
  return {
    id: `server:${flag}`,
    source: 'server',
    flag,
    category,
    status,
    text: row.signal || '',
    severity: row.severity || 'medium',
    priority: Number(row.priority) || 0,
    resolve: row.fingerprint ? { kind: 'signal', flag, fingerprint: row.fingerprint } : null,
    action: row.action || null,
    evidence: row.evidence || {},
  };
}

// A client row carries every line buildActionList and the derived signals
// produced, each with its own severity. Lines share one resolve: resolving a
// client_alert acknowledges the athlete's current set as a whole, which is
// what the dashboard's acknowledgement has always meant.
function clientSignals(row) {
  const lines = Array.isArray(row.lines) && row.lines.length
    ? row.lines
    : [row.signal, ...(row.also || [])].filter(Boolean).map((text, i) => ({
      text, critical: i === 0 && row.severity === 'critical',
    }));
  const resolve = row.fingerprint ? { kind: 'signal', flag: 'client_alert', fingerprint: row.fingerprint } : null;
  return lines.map((line, index) => {
    const category = classifyClientLine(line.text, !!line.critical);
    return {
      id: `client:${index}`,
      source: 'client',
      flag: 'client_alert',
      category,
      status: clientStatusLabel(category, line.text),
      text: line.text,
      severity: line.critical ? 'critical' : 'medium',
      // Inside the client band, critical lines lead and order is kept.
      priority: (Number(row.priority) || 1200) - index,
      resolve,
      action: row.action || null,
      evidence: {},
    };
  });
}

function reviewSignal(days, overdueAfter, serverRow) {
  const sorted = days.slice().sort((a, b) => (Number(b.days) || 0) - (Number(a.days) || 0));
  const oldest = sorted[0];
  const sessionCount = days.reduce((sum, day) => sum + Math.max(1, (day.sessions || []).length), 0);
  const overdue = days.some(day => (Number(day.days) || 0) >= overdueAfter);
  const names = days.flatMap(day => (day.sessions || []).map(s => s.name)).filter(Boolean);
  return {
    id: 'review',
    source: 'review',
    flag: 'awaiting_review',
    category: 'review',
    status: overdue ? 'Review overdue' : 'Review due',
    text: `${plural(sessionCount, 'session')} waiting · oldest ${ageCopy(oldest.days)}`,
    detail: names.slice(0, 3).join(', '),
    severity: overdue ? 'high' : 'medium',
    priority: (overdue ? 2000 : 1000) + Math.min(99, Number(oldest.days) || 0) * 10,
    resolve: { kind: 'review', dates: sorted.map(day => day.date) },
    // Keep the server's fingerprint so a stale awaiting_review row can still
    // be resolved the way it always could.
    serverResolve: serverRow?.fingerprint ? { kind: 'signal', flag: 'awaiting_review', fingerprint: serverRow.fingerprint } : null,
    // Oldest first: the day that has waited longest is the one to open.
    action: { type: 'open_review', label: 'Review sessions', date: oldest.date },
    evidence: {},
    overdue,
    sessionCount,
    oldestDays: Number(oldest.days) || 0,
  };
}

function messageSignal(message) {
  const body = String(message.body || '').replace(/\s+/g, ' ').trim();
  return {
    id: `message:${message.id}`,
    source: 'message',
    flag: 'message',
    category: 'followup',
    status: 'Unread message',
    text: body.length > 110 ? `“${body.slice(0, 107)}…”` : `“${body}”`,
    severity: 'medium',
    priority: 1500,
    resolve: { kind: 'message', id: message.id },
    action: { type: 'message', label: 'Reply' },
    evidence: {},
    createdAt: message.createdAt || null,
  };
}

// Which signal leads an athlete's row. Category order, with one refinement:
// a review that is not yet overdue is normal turnaround, so a follow-up the
// coach owes the athlete (gone quiet, a message, low recovery) leads it.
// Overdue review still leads every follow-up.
function signalRank(signal) {
  if (signal.category === 'review' && signal.source === 'review' && !signal.overdue) return 2.5;
  return CATEGORY_RANK[signal.category];
}

function compareSignals(a, b) {
  return (signalRank(a) - signalRank(b)) ||
    ((b.priority || 0) - (a.priority || 0));
}

function completionFor(signal) {
  if (!signal.resolve) return null;
  if (signal.resolve.kind === 'review') return { label: 'Mark reviewed', ...signal.resolve };
  if (signal.resolve.kind === 'message') return { label: 'Mark read', ...signal.resolve };
  return { label: 'Resolve', ...signal.resolve };
}

function primaryActionFor(signal, code) {
  const action = signal.action || {};
  const label = action.label
    || (signal.category === 'review' ? 'Review sessions'
      : signal.category === 'followup' ? 'Message'
        : signal.category === 'plan' ? 'Adjust week' : 'Open athlete');
  const type = action.type
    || (signal.category === 'followup' ? 'message' : signal.category === 'plan' ? 'review' : 'open_athlete');
  return { type, label, athleteCode: action.athleteCode || code, date: action.date || '' };
}

// One item per athlete. `server` is the /api/coach-data?mode=triage payload,
// `client` the rows publishClientSignals hands over, `messages` the portal
// contact messages from the full load.
export function buildCoachQueue({ server = null, client = [], messages = [] } = {}) {
  const athletes = new Map();
  const touch = (code, name) => {
    const key = upper(code);
    if (!key) return null;
    if (!athletes.has(key)) athletes.set(key, { code: key, name: name || key, signals: [], reviewDays: [], serverReview: null });
    const entry = athletes.get(key);
    if (name && (entry.name === key || !entry.name)) entry.name = name;
    return entry;
  };

  for (const row of Array.isArray(server?.queue) ? server.queue : []) {
    const entry = touch(row.athleteCode, row.athleteName);
    if (!entry) continue;
    // The review backlog owns review work; a server awaiting_review row is
    // folded into it rather than becoming a second signal for the same days.
    if (row.flag === 'awaiting_review') { entry.serverReview = row; continue; }
    entry.signals.push(serverSignal(row));
  }

  for (const row of Array.isArray(client) ? client : []) {
    const entry = touch(row.athleteCode, row.athleteName);
    if (!entry) continue;
    entry.signals.push(...clientSignals(row));
  }

  const overdueAfter = Number(server?.review?.overdueAfterDays) || 2;
  for (const day of Array.isArray(server?.review?.queue) ? server.review.queue : []) {
    const entry = touch(day.athleteCode, day.athleteName);
    if (entry && day.date) entry.reviewDays.push(day);
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.readAt) continue;
    const entry = touch(message.athleteCode, null);
    if (entry) entry.signals.push(messageSignal(message));
  }

  const items = [];
  for (const entry of athletes.values()) {
    if (entry.reviewDays.length) {
      entry.signals.push(reviewSignal(entry.reviewDays, overdueAfter, entry.serverReview));
    } else if (entry.serverReview) {
      // Server says overdue but the review list did not carry the days (an
      // older API). Keep the row rather than drop real work.
      const fallback = serverSignal(entry.serverReview);
      fallback.status = 'Review overdue';
      entry.signals.push(fallback);
    }
    if (!entry.signals.length) continue;

    const signals = entry.signals.slice().sort(compareSignals);
    const primary = signals[0];
    // Additional signals, shortest useful form, without repeating the primary.
    const seen = new Set([primary.text]);
    const additional = [];
    for (const signal of signals.slice(1)) {
      const line = signal.category === 'review' || signal.source === 'message'
        ? signal.status
        : signal.text;
      if (!line || seen.has(line)) continue;
      seen.add(line);
      additional.push({ text: line, category: signal.category });
    }

    items.push({
      code: entry.code,
      name: entry.name,
      category: primary.category,
      status: primary.status,
      reason: primary.category === 'review'
        ? (primary.detail ? `Submitted: ${primary.detail}.` : 'Submitted training is waiting for a review.')
        : primary.text,
      summary: primary.category === 'review' ? primary.text : '',
      severity: primary.severity,
      priority: primary.priority,
      primary,
      signals,
      additional,
      reviewDays: entry.reviewDays.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))),
      primaryAction: primaryActionFor(primary, entry.code),
      secondaryAction: { type: 'open_athlete', label: 'Open athlete', athleteCode: entry.code },
      completion: completionFor(primary),
      evidence: primary.evidence || {},
    });
  }

  items.sort((a, b) =>
    (CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]) ||
    ((b.priority || 0) - (a.priority || 0)) ||
    a.name.localeCompare(b.name));

  const resolved = Array.isArray(server?.resolved) ? server.resolved : [];
  const counts = { all: items.length, urgent: 0, review: 0, followup: 0, plan: 0, resolved: resolved.length };
  for (const item of items) counts[item.category] += 1;

  return { items, counts, resolved };
}

export function filterItems(items, filter) {
  if (!filter || filter === 'all') return items.slice();
  return items.filter(item => item.category === filter);
}

// Status for one athlete, from their queue item (if any) plus any unresolved
// client lines the queue has not seen yet (the triage load can finish after
// the roster load, or fail on its own).
export function athleteStatus({ item = null, lines = [], noData = false } = {}) {
  const categories = new Set((item?.signals || []).map(s => s.category));
  for (const line of lines || []) categories.add(classifyClientLine(line.text, !!line.critical));
  if (categories.has('urgent')) return STATUS.urgent;
  if (categories.has('followup') || categories.has('plan')) return STATUS.attention;
  if (categories.has('review')) return STATUS.review;
  if (noData) return STATUS.nodata;
  return STATUS.ontrack;
}

// Focus Mode walks a fixed order captured when the coach presses Start, so
// a reload after each resolve cannot reshuffle what "next" means. Items that
// have left the queue are skipped; nothing is ever revisited unless the
// coach goes back on purpose.
export function nextInSession(session, liveItems) {
  const live = new Map((liveItems || []).map(item => [item.code, item]));
  const order = session?.order || [];
  for (let i = (session?.index ?? -1) + 1; i < order.length; i += 1) {
    if (live.has(order[i]) && !(session.done || []).includes(order[i])) return i;
  }
  return -1;
}

export function remainingInSession(session, liveItems) {
  const live = new Set((liveItems || []).map(item => item.code));
  const done = new Set(session?.done || []);
  return (session?.order || []).filter(code => live.has(code) && !done.has(code)).length;
}

const api = {
  CATEGORIES,
  CATEGORY_LABELS,
  FLAG_CATEGORY,
  STATUS,
  STATUS_ORDER,
  classifyClientLine,
  buildCoachQueue,
  filterItems,
  athleteStatus,
  nextInSession,
  remainingInSession,
  ageCopy,
};

if (typeof window !== 'undefined') {
  window.DP_QUEUE = api;
  window.dispatchEvent?.(new CustomEvent('dp:queue-model-ready'));
}

export default api;
