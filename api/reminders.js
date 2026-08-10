// ── ATHLETE REMINDERS ─────────────────────────────────────────────────────────
// POST (from portal client): save / remove a push subscription + preferences.
//   The client includes its device timezone, so reminders arrive at 5am local.
// GET  ?code=X            : return which reminders are due today for one athlete.
// GET  (scheduled)        : authorised with REMINDERS_CRON_SECRET or CRON_SECRET.
//   Triggered every minute by Supabase pg_cron (job: send-athlete-reminders) and
//   once daily by Vercel cron as a backstop. Each run only sends to athletes whose
//   LOCAL time matches: 5am for morning reminders, 5am–11:30pm for coach updates.
import webpush from 'web-push';
import { select, upsert, patch, supabaseRequest, tablePath } from './_lib/supabase-rest.js';
import { getRequestAthlete } from './_lib/auth.js';
import { allowPortalRequest } from './_lib/http.js';

const DONE_STATUS = /^(done|completed?|complete|skipped|missed)$/i;
const DEFAULT_TZ = 'Australia/Adelaide';
const MORNING_HOUR = 5;

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:coach@dualperformance.co';
  if (!publicKey || !privateKey) throw new Error('VAPID keys not configured');
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

// Local date / weekday / hour for a timezone. Returns null for invalid zones.
function localNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : null; };
    return {
      iso: `${get('year')}-${get('month')}-${get('day')}`,
      dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
      hour: parseInt(get('hour'), 10),
      minute: parseInt(get('minute'), 10),
    };
  } catch (e) { return null; }
}

function safeTz(tz) {
  return (tz && localNow(tz)) ? tz : DEFAULT_TZ;
}

function inList(values) {
  return `in.(${[...new Set(values)].map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`;
}

// For each athlete code, work out which reminder types are due on this local day.
async function computeDue(codes, { iso, dow }) {
  const due = {};
  codes.forEach((c) => { due[c] = { sessions: [], checkin: false, photos: false, coach: [] }; });
  const list = inList(codes);

  // 1. Training sessions planned today (local) and not already completed.
  const sessions = await select('planned_sessions', {
    athlete_code: list, planned_date: `eq.${iso}`, select: 'athlete_code,title,session_type,status',
  });
  for (const row of sessions || []) {
    if (row.status && DONE_STATUS.test(String(row.status).trim())) continue;
    if (due[row.athlete_code]) due[row.athlete_code].sessions.push(row.title || row.session_type || 'Session');
  }

  // 2. Weekly check-in: Sunday morning, if nothing submitted in the last 6 days.
  if (dow === 0) {
    const since = new Date(Date.now() - 6 * 864e5).toISOString();
    const done = await select('weekly_checkins', {
      athlete_code: list, submitted_at: `gte.${since}`, select: 'athlete_code',
    });
    const submitted = new Set((done || []).map((r) => r.athlete_code));
    codes.forEach((c) => { if (!submitted.has(c)) due[c].checkin = true; });
  }

  // 3. Progress photos: requested weekly — every Monday, start of the week.
  if (dow === 1) {
    codes.forEach((c) => { due[c].photos = true; });
  }

  // 4. Coach updates: any coach-side change logged in the last 24h.
  //    (DB triggers on planned_sessions, nutrition_plans, workout_splits and
  //    session_overrides write to coach_change_log, ignoring athlete-driven
  //    fields like session status.)
  const since24 = new Date(Date.now() - 24 * 36e5).toISOString();
  const changes = await select('coach_change_log', {
    athlete_code: list, changed_at: `gte.${since24}`, select: 'athlete_code,source,changed_at,detail',
  });
  for (const c of changes || []) {
    const d = due[c.athlete_code];
    if (d) d.coach.push({ source: c.source, at: c.changed_at, detail: c.detail });
  }

  return due;
}

// "Tue 14 Jul" from a YYYY-MM-DD planned date (locale-independent).
function formatChangeDate(iso) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()];
}

// Build the coach-update body from change details: name up to three changes
// ("Tempo Run (Tue 14 Jul) updated - Long Run added"), falling back to
// per-area counts when there are too many or details are missing.
function coachBody(changes) {
  const seen = new Set();
  const named = [];
  for (const c of changes) { // newest first
    const det = c.detail || {};
    if (!det.item) continue;
    const key = det.action + '|' + det.item + '|' + (det.date || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const date = det.date ? formatChangeDate(det.date) : null;
    named.push(det.item + (date ? ' (' + date + ')' : '') + ' ' + (det.action || 'updated'));
  }
  const allNamed = named.length && named.length === seen.size && changes.every((c) => c.detail && c.detail.item);
  if (allNamed && named.length <= 3) {
    const body = named.join(' \u00b7 ');
    if (body.length <= 140) return body + ' \u2014 open the portal for details.';
  }
  // Fallback: counts per area, e.g. "4 training changes \u00b7 nutrition updated".
  const bySource = {};
  for (const c of changes) bySource[c.source] = (bySource[c.source] || 0) + 1;
  const parts = Object.entries(bySource)
    .map(([src, n]) => (n > 1 ? n + ' ' + src + ' changes' : src + ' updated'));
  return 'Your coach made changes: ' + parts.join(' \u00b7 ') + ' \u2014 see the portal.';
}

function buildMessages(dueForAthlete, prefs, allowed, coachChanges) {
  const messages = [];
  if (allowed.morning && prefs.sessions && dueForAthlete.sessions.length) {
    messages.push({
      type: 'sessions', title: 'Training today',
      body: dueForAthlete.sessions.join(' · ') + ' — open the portal for the full prescription.',
    });
  }
  if (allowed.morning && prefs.checkins && dueForAthlete.checkin) {
    messages.push({
      type: 'checkins', title: 'Weekly check-in due',
      body: 'Take three minutes to review your week before it resets tomorrow.',
    });
  }
  if (allowed.morning && prefs.photos && dueForAthlete.photos) {
    messages.push({
      type: 'photos', title: 'Progress photo week',
      body: 'New week — grab your four angles. Same time, same lighting.',
    });
  }
  if (allowed.coach && prefs.coach && coachChanges && coachChanges.length) {
    messages.push({ type: 'coach', title: 'Coach update', body: coachBody(coachChanges) });
  }
  return messages;
}

async function handleSubscribe(req, res, identity) {
  const { action, subscription, prefs, endpoint, userAgent, timezone } = req.body || {};
  const code = String(identity.athlete.code).toUpperCase();

  if (action === 'unsubscribe') {
    if (!endpoint) return send(res, 400, { ok: false, error: 'endpoint required' });
    await supabaseRequest(tablePath('push_subscriptions', {
      endpoint: `eq.${endpoint}`,
      athlete_code: `eq.${code}`,
    }), { method: 'DELETE' });
    return send(res, 200, { ok: true });
  }

  if (action !== 'subscribe') return send(res, 400, { ok: false, error: 'Unknown action' });
  const keys = subscription && subscription.keys;
  if (!code || !subscription || !subscription.endpoint || !keys || !keys.p256dh || !keys.auth) {
    return send(res, 400, { ok: false, error: 'code and subscription required' });
  }

  await upsert('push_subscriptions', {
    athlete_code: code,
    endpoint: subscription.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    prefs: prefs || {},
    timezone: safeTz(timezone),
    user_agent: (userAgent || '').slice(0, 500),
    updated_at: new Date().toISOString(),
  }, 'endpoint');

  return send(res, 200, { ok: true });
}

async function handleDueCheck(req, res, identity) {
  const code = String(identity.athlete.code).toUpperCase();
  const subs = await select('push_subscriptions', { athlete_code: `eq.${code}`, select: 'timezone', limit: '1' });
  const tz = safeTz(subs && subs[0] && subs[0].timezone);
  const due = await computeDue([code], localNow(tz));
  const d = due[code];
  d.coach = [...new Set((d.coach || []).map((c) => c.source))];
  return send(res, 200, { ok: true, timezone: tz, due: d });
}

async function handleCronSend(req, res) {
  const secrets = [process.env.REMINDERS_CRON_SECRET, process.env.CRON_SECRET].filter(Boolean);
  if (!secrets.length) return send(res, 503, { ok: false, error: 'Cron secret is not configured' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secrets.includes(token)) return send(res, 401, { ok: false, error: 'Unauthorized' });

  configureVapid();
  const subs = await select('push_subscriptions', { order: 'created_at.asc' });
  if (!subs || !subs.length) return send(res, 200, { ok: true, sent: 0, note: 'No subscriptions' });

  // Group subscriptions by timezone; only process zones in an active window.
  const groups = new Map();
  for (const sub of subs) {
    const tz = safeTz(sub.timezone);
    if (!groups.has(tz)) groups.set(tz, []);
    groups.get(tz).push(sub);
  }

  let sent = 0, removed = 0, skippedZones = 0;
  const errors = [];

  for (const [tz, zoneSubs] of groups) {
    const now = localNow(tz);
    const allowed = {
      morning: now.hour === MORNING_HOUR,               // 5am local: sessions, check-ins, photos
      coach: now.hour >= MORNING_HOUR && (now.hour < 23 || (now.hour === 23 && now.minute < 30)), // coach updates: 5am–11:30pm local
    };
    if (!allowed.morning && !allowed.coach) { skippedZones++; continue; }

    const due = await computeDue(zoneSubs.map((s) => s.athlete_code), now);

    for (const sub of zoneSubs) {
      const prefs = sub.prefs || {};
      const lastSent = sub.last_sent || {};

      // Coach updates: notify per batch of changes, not once per day.
      // A change qualifies once it is newer than the last coach alert AND the
      // newest change is >2 min old (debounce, so an editing session lands
      // as a single ping rather than one per save).
      const coachEntries = (due[sub.athlete_code] || {}).coach || [];
      const lastCoach = lastSent.coach ? new Date(lastSent.coach).getTime() : 0;
      const freshChanges = coachEntries.filter((c) => new Date(c.at).getTime() > lastCoach);
      const newest = freshChanges.length ? Math.max(...freshChanges.map((c) => new Date(c.at).getTime())) : 0;
      const coachChanges = (freshChanges.length && Date.now() - newest >= 2 * 60 * 1000)
        ? freshChanges.slice().sort((a, b) => new Date(b.at) - new Date(a.at)) : [];

      const messages = buildMessages(due[sub.athlete_code] || {}, prefs, allowed, coachChanges)
        .filter((m) => m.type === 'coach' || lastSent[m.type] !== now.iso); // morning types: one per local day

      let delivered = false;
      for (const msg of messages) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title: msg.title, body: msg.body, tag: 'dp-' + msg.type, url: '/' }),
            { TTL: 12 * 3600 }
          );
          lastSent[msg.type] = msg.type === 'coach' ? new Date().toISOString() : now.iso;
          sent++; delivered = true;
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await supabaseRequest(tablePath('push_subscriptions', { id: `eq.${sub.id}` }), { method: 'DELETE' });
            removed++;
            break;
          }
          errors.push({ athlete: sub.athlete_code, type: msg.type, error: String(error.message || error).slice(0, 200) });
        }
      }
      if (delivered) {
        await patch('push_subscriptions', { id: `eq.${sub.id}` }, { last_sent: lastSent, updated_at: new Date().toISOString() });
      }
    }
  }

  return send(res, 200, { ok: true, subscriptions: subs.length, timezones: groups.size, sent, removed, skippedZones, errors });
}

export default async function handler(req, res) {
  if (!allowPortalRequest(req, res, 'GET, POST, OPTIONS')) return;
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'POST') {
      const identity = await getRequestAthlete(req);
      if (!identity) return send(res, 401, { ok: false, error: 'invalid_session' });
      return await handleSubscribe(req, res, identity);
    }
    if (req.method === 'GET' && req.query.portal === '1') {
      const identity = await getRequestAthlete(req);
      if (!identity) return send(res, 401, { ok: false, error: 'invalid_session' });
      return await handleDueCheck(req, res, identity);
    }
    if (req.method === 'GET') return await handleCronSend(req, res);
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error.message || error).slice(0, 500) });
  }
}
