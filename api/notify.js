// /api/notify.js
// Custom coach → athlete-portal push notifications.
//
// Sends an INSTANT web push to an athlete's subscribed devices (or every
// athlete), landing exactly like the automatic "Coach update" pings — same
// push_subscriptions table, same VAPID keys, same service-worker handler on
// the portal. Nothing is written to coach_change_log, so no duplicate
// automatic ping follows.
//
//   GET  /api/notify            (x-admin-key) -> recipients + device counts
//   POST /api/notify            (x-admin-key) -> send
//     body: { code: 'ABC123' | 'ALL', title?, message }
//
// Env required on the DASHBOARD Vercel project:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (already configured for /api/coach-data)
//   ADMIN_KEY                            (already configured for /api/athletes)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
//     -> copy these three from the dp-athlete-portal Vercel project. Pushes
//        MUST be signed with the same VAPID keys the athletes subscribed with.

import webpush from 'web-push';

const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();
const MAX_TITLE = 80;
const MAX_MESSAGE = 500;

function requireAdmin(req) {
  if (!ADMIN_KEY) throw new Error('ADMIN_KEY is not configured');
  const supplied = String(req.headers['x-admin-key'] || '').trim();
  if (!supplied || supplied !== ADMIN_KEY) {
    const error = new Error('Admin key rejected');
    error.status = 401;
    throw error;
  }
}

function configureVapid() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:coach@dualperformance.co';
  if (!publicKey || !privateKey) {
    throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not configured — copy them from the athlete portal Vercel project');
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

// ── Minimal Supabase REST helpers (same pattern as /api/coach-data) ──────────
function sbEnv() {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  return { baseUrl, key };
}

async function sb(path, options = {}) {
  const { baseUrl, key } = sbEnv();
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { /* DELETE returns empty */ }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase ${response.status} on ${path}`);
  }
  return data;
}

// ── Recipient resolution ─────────────────────────────────────────────────────
async function loadSubscriptions(code) {
  const select = 'select=id,athlete_code,endpoint,p256dh,auth';
  if (code === 'ALL') return (await sb(`push_subscriptions?${select}`)) || [];

  // Exact athlete_code match first (subscriptions store the roster code).
  let subs = await sb(`push_subscriptions?athlete_code=eq.${encodeURIComponent(code)}&${select}`);
  if (subs && subs.length) return subs;

  // Fall back to resolving a name (the dashboard sometimes only has names).
  const athletes = await sb(
    `athletes?or=(code.eq.${encodeURIComponent(code)},name.ilike.${encodeURIComponent(code)})&select=code&limit=1`
  );
  if (athletes && athletes.length) {
    subs = await sb(`push_subscriptions?athlete_code=eq.${encodeURIComponent(athletes[0].code)}&${select}`);
    if (subs && subs.length) return subs;
  }
  return [];
}

// ── GET: recipients with device counts ───────────────────────────────────────
async function handleRecipients(req, res) {
  const [athletes, subs] = await Promise.all([
    sb('athletes?archived_at=is.null&select=code,name&order=name.asc'),
    sb('push_subscriptions?select=athlete_code'),
  ]);
  const counts = {};
  for (const s of subs || []) counts[s.athlete_code] = (counts[s.athlete_code] || 0) + 1;
  const recipients = (athletes || []).map((a) => ({
    code: a.code,
    name: a.name,
    devices: counts[a.code] || 0,
  }));
  const totalDevices = (subs || []).length;
  return res.status(200).json({ ok: true, recipients, totalDevices });
}

// ── POST: send ───────────────────────────────────────────────────────────────
async function handleSend(req, res) {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE) || 'Message from your coach';
  const message = String(req.body?.message || '').trim().slice(0, MAX_MESSAGE);

  if (!code) return res.status(400).json({ ok: false, error: 'code required (athlete code or ALL)' });
  if (!message) return res.status(400).json({ ok: false, error: 'message required' });

  configureVapid();

  const subs = await loadSubscriptions(code);
  if (!subs.length) {
    return res.status(404).json({
      ok: false,
      error: code === 'ALL'
        ? 'No athletes have push notifications enabled yet'
        : `No subscribed devices for ${code} — the athlete needs to enable notifications in their portal`,
    });
  }

  // Unique tag so consecutive custom messages stack instead of replacing
  // each other on the athlete's device.
  const payload = JSON.stringify({
    title,
    body: message,
    tag: `dp-coach-msg-${Date.now()}`,
    url: '/',
  });

  let sent = 0;
  let removed = 0;
  const failed = [];
  const reached = new Set();

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 12 * 3600 }
      );
      sent++;
      reached.add(sub.athlete_code);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        // Subscription is dead — clean it up like /api/reminders does.
        await sb(`push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' }).catch(() => {});
        removed++;
      } else {
        failed.push({
          athlete: sub.athlete_code,
          error: String(error.message || error).slice(0, 200),
        });
      }
    }
  }

  return res.status(200).json({
    ok: sent > 0,
    sent,
    athletes: reached.size,
    devices: subs.length,
    removed,
    failed,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    requireAdmin(req);
    if (req.method === 'GET') return await handleRecipients(req, res);
    if (req.method === 'POST') return await handleSend(req, res);
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ ok: false, error: String(error.message || error).slice(0, 500) });
  }
}
