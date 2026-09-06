// Local static preview of public/ — no build step, no Supabase. Used for visual
// checks only. A handful of /api routes answer with fixtures so screens that
// depend on them can be seen; everything else 404s.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import * as FIXTURE from './preview-fixture.mjs';

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
      signal: `Pain 7/10 reported yesterday after Threshold 5×1km.`,
      action: { type: 'open_athlete', label: 'Open session', athleteCode: 'KAI' },
      evidence: {},
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
  [/^\/api\/coach-data.*mode=triage/, TRIAGE],
  [/^\/api\/coach-data.*mode=activity_streams/, () => ({ ok: true, id: 'up-0001', streams: [] })],
  [/^\/api\/coach-data/, () => FIXTURE.coachData()],
  [/^\/api\/athletes\?action=acknowledgements/, () => ({ ok: true, acknowledgements: [], signals: [] })],
  [/^\/api\/athletes\?action=roster/, () => ({ ok: true, athletes: FIXTURE.roster() })],
  [/^\/api\/athletes\?action=profiles/, () => ({ ok: true, results: FIXTURE.profiles() })],
  [/^\/api\/athletes\?action=prescription/, target => {
    const id = new URL(target, 'http://x').searchParams.get('id');
    return FIXTURE.prescription(id);
  }],
  [/^\/api\/athletes\?action=daily_macro_overrides/, () => ({ ok: true, overrides: [] })],
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

  for (const [pattern, build] of FIXTURES) {
    if (pattern.test(target)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(build(target)));
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
