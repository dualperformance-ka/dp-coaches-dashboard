// Local static preview of public/ — no build step, no Supabase. Used for visual
// checks only. A handful of /api routes answer with fixtures so screens that
// depend on them can be seen; everything else 404s.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import * as FIXTURE from './preview-fixture.mjs';
import { loadCoachStravaActivities } from '../server/coach-strava-activities.js';

const root = new URL('../public/', import.meta.url).pathname;
const fontRoot = new URL('./preview-fonts/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const iso = days => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

// ── Preview-only state ──────────────────────────────────────────────────────
// Coach actions (review, resolve, read) are remembered in memory so a full
// Focus Mode pass can be driven end to end: a reviewed day leaves the review
// queue, a resolved signal leaves the triage queue, a read message stops being
// unread. GET /__preview/scenario?name=… switches the fixture to an edge case
// (empty, triage-fail, coach-data-fail, long-notes) and resets that state.
const STATE = { scenario: 'default', reviewed: new Set(), resolved: new Map(), read: new Set() };
function resetState(scenario = 'default') {
  STATE.scenario = scenario;
  STATE.reviewed = new Set();
  STATE.resolved = new Map();
  STATE.read = new Set();
}

function applyState(payload) {
  if (STATE.scenario === 'empty') {
    return { ...payload, queue: [], resolved: [], counts: { ...payload.counts, flagged: 0, critical: 0, high: 0, medium: 0, resolved: 0, clear: payload.counts.active, reviewPending: 0, reviewOverdue: 0 },
      review: { ...payload.review, queue: [], counts: { pending: 0, overdue: 0, athletes: 0 } } };
  }
  const reviewQueue = payload.review.queue.filter(e => !STATE.reviewed.has(`${e.athleteCode}|${e.date}`));
  const resolvedRows = [...payload.resolved];
  const queue = payload.queue.filter(row => {
    const key = `${row.athleteCode}|${row.flag}`;
    if (STATE.resolved.get(key) === row.fingerprint) {
      resolvedRows.push({ athleteCode: row.athleteCode, athleteName: row.athleteName, flag: row.flag, signal: row.signal,
        fingerprint: row.fingerprint, resolvedBy: 'KARL', resolvedAt: new Date().toISOString() });
      return false;
    }
    if (row.flag === 'awaiting_review') return reviewQueue.some(e => e.athleteCode === row.athleteCode);
    return true;
  });
  return {
    ...payload,
    queue,
    resolved: resolvedRows,
    counts: { ...payload.counts, flagged: queue.length, resolved: resolvedRows.length, reviewPending: reviewQueue.length,
      reviewOverdue: reviewQueue.filter(e => e.days >= 2).length },
    review: { ...payload.review, queue: reviewQueue, counts: { pending: reviewQueue.length,
      overdue: reviewQueue.filter(e => e.days >= 2).length, athletes: new Set(reviewQueue.map(e => e.athleteCode)).size } },
  };
}

function coachDataWithState() {
  const data = FIXTURE.coachData();
  data.contactMessages = data.contactMessages.map(m => (STATE.read.has(m.id) ? { ...m, readAt: new Date().toISOString(), readBy: 'KARL' } : m));
  if (STATE.scenario === 'empty') data.contactMessages = data.contactMessages.map(m => ({ ...m, readAt: m.readAt || new Date().toISOString() }));
  if (STATE.scenario === 'long-notes') {
    const essay = 'Felt flat for the first 3km and the calf was tight again on the downhill.\n\nSettled once I hit threshold pace, but the last rep I backed off because the calf started to grab. Iced it after and it feels okay this morning. Work has been brutal this week so sleep has been 5–6 hours most nights, and I skipped breakfast before the session which probably did not help.\n\nShould I swap tomorrow for an easy spin? Also wondering if I should move the long run to Sunday.';
    data.sessions = data.sessions.map(row => (row['Athlete Code'] === 'KAI' && row['Session Category'] === 'Run' ? { ...row, Notes: essay } : row));
  }
  return data;
}

function coachAction(body) {
  const { action, code, session_date: date, signal_type: flag, fingerprint, id } = body || {};
  const upper = String(code || '').toUpperCase();
  if (action === 'session_review') { STATE.reviewed.add(`${upper}|${date}`); return { ok: true, reviewedBy: 'KARL' }; }
  if (action === 'session_unreview') { STATE.reviewed.delete(`${upper}|${date}`); return { ok: true }; }
  if (action === 'signal_resolve') { STATE.resolved.set(`${upper}|${flag}`, fingerprint); return { ok: true }; }
  if (action === 'signal_restore') { STATE.resolved.delete(`${upper}|${flag}`); return { ok: true }; }
  if (action === 'message_read' || action === 'message_unread') {
    if (action === 'message_read') STATE.read.add(String(id)); else STATE.read.delete(String(id));
    const message = coachDataWithState().contactMessages.find(m => m.id === String(id));
    return { ok: true, message };
  }
  return { ok: true };
}

const TRIAGE = () => ({
  ok: true,
  source: 'fixture',
  generatedAt: new Date().toISOString(),
  timeZone: 'Australia/Adelaide',
  week: { start: iso(2), dayIndex: 3, halfElapsed: false },
  counts: {
    active: 12, flagged: 3, critical: 1, high: 1, medium: 1,
    resolved: 1, clear: 8, reviewPending: 5, reviewOverdue: 2,
  },
  queue: [
    {
      athleteCode: 'KAI', athleteName: 'Kai Tran', flag: 'pain', severity: 'critical',
      priority: 10070, fingerprint: 'pain|' + iso(1) + '|7|none',
      signal: `Coach alert with pain 7/10 (right calf) reported yesterday after Threshold 5×1km.`,
      action: { type: 'open_athlete', label: 'Open session', athleteCode: 'KAI' },
      evidence: { pain: { date: iso(1), score: 7, coachAlert: true, location: 'right calf' } },
    },
    {
      athleteCode: 'ANNA', athleteName: 'Anna Petrov', flag: 'gone_quiet', severity: 'high',
      priority: 5000, fingerprint: 'quiet|' + iso(2),
      signal: 'No completed session and no body log for at least 5 days.',
      action: { type: 'message', label: 'Check in', athleteCode: 'ANNA' },
      evidence: {},
    },
    {
      athleteCode: 'JAMES', athleteName: 'James Okafor', flag: 'awaiting_review', severity: 'medium',
      priority: 2030, fingerprint: 'review|' + iso(3) + '|3',
      signal: 'Long run submitted 3 days ago and not yet reviewed.',
      action: { type: 'open_review', label: 'Review session', athleteCode: 'JAMES', date: iso(3) },
      evidence: {},
    },
  ],
  resolved: [{
    athleteCode: 'TOM', athleteName: 'Tom Reilly', flag: 'compliance_drift',
    signal: 'Completed 2 of 5 sessions planned so far this week.',
    fingerprint: 'drift|x', resolvedBy: 'KARL', resolvedAt: new Date().toISOString(),
  }],
  review: {
    overdueAfterDays: 2,
    windowStart: iso(13),
    counts: { pending: 5, overdue: 2, athletes: 4 },
    queue: [
      { athleteCode: 'JAMES', athleteName: 'James Okafor', date: iso(3), days: 3, sessions: [{ name: 'Long run 26km' }] },
      { athleteCode: 'SARAH', athleteName: 'Sarah Chen', date: iso(2), days: 2, sessions: [{ name: 'Threshold 5×1km' }] },
      { athleteCode: 'SARAH', athleteName: 'Sarah Chen', date: iso(1), days: 1, sessions: [{ name: 'Upper B' }] },
      { athleteCode: 'ANNA', athleteName: 'Anna Petrov', date: iso(1), days: 1, sessions: [{ name: 'Easy 8km' }] },
      { athleteCode: 'LUCA', athleteName: 'Luca Bianchi', date: iso(0), days: 0, sessions: [{ name: 'Lower A' }] },
    ],
  },
});

// Order matters: the first pattern that matches wins, so the narrow
// coach-data modes are listed before the bare full-payload route.
const FIXTURES = [
  [/^\/api\/coach-data.*mode=triage/, () => applyState(TRIAGE())],
  [/^\/api\/coach-data.*mode=weekly_summary/, target => FIXTURE.weeklySummary(new URL(target, 'http://x').searchParams.get('code') || 'KAI')],
  [/^\/api\/coach-data.*mode=activity_streams/, () => ({ ok: true, id: 'up-0001', streams: [] })],
  [/^\/api\/coach-data/, () => coachDataWithState()],
  [/^\/api\/athletes\?action=acknowledgements/, () => ({ ok: true, acknowledgements: [], signals: [] })],
  [/^\/api\/athletes\?action=roster/, () => ({ ok: true, athletes: FIXTURE.roster() })],
  [/^\/api\/athletes\?action=profiles/, () => ({ ok: true, results: FIXTURE.profiles() })],
  [/^\/api\/athletes\?action=prescription/, target => {
    const id = new URL(target, 'http://x').searchParams.get('id');
    return FIXTURE.prescription(id);
  }],
  [/^\/api\/athletes\?action=daily_macro_overrides/, () => ({ ok: true, overrides: [] })],
  // The real loader and classifier over fixture cache rows; only the database
  // is faked. See stravaCache() in preview-fixture.mjs.
  [/^\/api\/athletes\?action=strava_activities/, async target => {
    const params = new URL(target, 'http://x').searchParams;
    const code = String(params.get('code') || '').toUpperCase();
    const sb = async path => {
      const table = path.split('?')[0];
      if (table === 'strava_activities') {
        const rows = FIXTURE.stravaCache(code);
        return path.includes('order=synced_at') ? rows.slice(-1) : rows;
      }
      if (table === 'planned_sessions') {
        return FIXTURE.PLAN.filter(row => row.athlete_code === code)
          .map(row => ({ ...row, notion_page_id: null, estimated_minutes: null }));
      }
      if (table === 'session_logs') {
        return FIXTURE.PLAN.filter(row => row.athlete_code === code && row.status === 'Completed')
          .map(row => ({ session_key: `session_${code}_${row.id}` }));
      }
      if (table === 'athlete_data' && path.includes('strava_tokens')) return FIXTURE.stravaConnection(code);
      return [];
    };
    return { ok: true, ...(await loadCoachStravaActivities({
      code, start: params.get('start'), end: params.get('end'), sb, env: {},
    })) };
  }],
  // Notion is still a second source in production. The preview returns it empty
  // so what renders is provably the Supabase path and not a blended legacy shape.
  [/^\/api\/data/, () => ({ results: [], has_more: false, next_cursor: null })],
  [/^\/api\/actions/, () => ({ ok: true, actions: [] })],
  [/^\/api\/notify/, () => ({ ok: true, status: [], queue: [] })],
  [/^\/api\/progress-photos/, () => ({ ok: true, photos: [] })],
];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const target = url.pathname + url.search;

  if (url.pathname === '/__preview/scenario') {
    resetState(url.searchParams.get('name') || 'default');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, scenario: STATE.scenario }));
  }
  if (req.method === 'POST' && url.pathname === '/api/athletes') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(coachAction(body)));
  }
  // Failure scenarios answer 500 for one source so partial-failure states
  // can be seen without touching production.
  if ((STATE.scenario === 'triage-fail' && /mode=triage/.test(target)) ||
      (STATE.scenario === 'coach-data-fail' && /^\/api\/coach-data(?!.*mode=)/.test(target))) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'preview: simulated failure' }));
  }

  for (const [pattern, build] of FIXTURES) {
    if (pattern.test(target)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await build(target)));
    }
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'No fixture for this route' }));
  }

  // Local IBM Plex, so the harness can prove the condensed face is really
  // applied on a machine with no route to fonts.googleapis.com. Production is
  // untouched: index.html still carries the Google Fonts link, and this only
  // rewrites the copy the preview serves.
  if (url.pathname.startsWith('/preview-fonts/')) {
    const name = url.pathname.slice('/preview-fonts/'.length).replace(/[^A-Za-z0-9._-]/g, '');
    try {
      const body = await readFile(join(fontRoot, name));
      res.writeHead(200, {
        'Content-Type': name.endsWith('.css') ? 'text/css' : 'font/woff2',
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    } catch {
      res.writeHead(404); return res.end('font not found');
    }
  }

  const path = decodeURIComponent(url.pathname);
  const file = join(root, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''));
  try {
    let body = await readFile(file);
    if (extname(file) === '.html') {
      // Point the page at the local faces instead of Google Fonts. Same families,
      // same weights, so what renders is what production renders.
      body = Buffer.from(String(body).replace(
        /<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]*" rel="stylesheet">/,
        '<link href="/preview-fonts/plex.css" rel="stylesheet">'
      ));
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(4173, () => console.log('preview on http://localhost:4173'));
