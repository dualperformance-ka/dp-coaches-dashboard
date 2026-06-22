// /api/write.js — Vercel serverless function
// Replaces all Make (Integromat) portal write webhooks with direct Notion API writes.
// Routed by a "type" field in the POSTed JSON payload.
//
// Handled types (payload.type):
//   "Run" | "Strength" | "training_log" -> 🏋️ Athlete Session Tracker
//   "weekly_checkin"                     -> 🗓️ Weekly Check-in
//   "daily_body"                         -> 💪 Daily Athlete BODY Check-in
//   "daily_nutrition"                    -> 🍽️ Daily Athlete NUTRITION Check-in
//   "goals"                              -> updates the athlete's profile row in the Athlete DB
//   "test_ping"                          -> ignored (returns ok), matches the old Make "skip test pings" filter
//
// Reads (/api/notion, notion.js) are untouched.
// Env required: NOTION_TOKEN.
// Env required for GHL check-in tagging: SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_API_KEY.
//
// FIX (2026-06): the Supabase client is now loaded lazily inside the GHL helper
// via a guarded dynamic import. Previously a top-level
//   import { createClient } from '@supabase/supabase-js'
// crashed the ENTIRE function with "Cannot find module '@supabase/supabase-js'"
// because the portal has no package.json declaring that dependency — so every
// weekly check-in (and all other writes) failed with 500 before reaching Notion.
// Now a missing module only disables the best-effort GHL tag; Notion writes work.

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

// Database IDs (classic Notion API accepts the 32-char hyphenless form).
const DB = {
  athlete:   '4a25a96cc70b82ffa6790139eaa8b458', // Athlete DB (profile / goals target + relation source)
  training:  '1c55a96cc70b825b9bdf819abea4ef7c', // 🏋️ Athlete Session Tracker
  checkin:   '33e5a96cc70b8049b696d22e5920e0ee', // 🗓️ Weekly Check-in
  body:      '3405a96cc70b80a4b1b9cf5b9c236f18', // 💪 Daily Athlete BODY Check-in
  nutrition: '3405a96cc70b804baa9cf165f2d2e0e9', // 🍽️ Daily Athlete NUTRITION Check-in
};

// ── Notion REST helpers ────────────────────────────────────────────────────
async function notion(path, method, body) {
  const r = await fetch('https://api.notion.com/v1/' + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + NOTION_TOKEN,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (json && json.message) || ('Notion ' + r.status);
    throw new Error(msg);
  }
  return json;
}

// ── Property builders (only emit a property when the value is meaningful) ────
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const rt   = (v) => has(v) ? { rich_text: [{ text: { content: String(v).slice(0, 2000) } }] } : null;
const title= (v) => ({ title: [{ text: { content: String(v == null ? '' : v).slice(0, 2000) } }] });
const num  = (v) => has(v) && !isNaN(Number(v)) ? { number: Number(v) } : null;
const sel  = (v) => has(v) ? { select: { name: String(v) } } : null;
const dat  = (v) => has(v) ? { date: { start: String(v) } } : null;

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const rel = (id) => (has(id) && UUID_RE.test(String(id).trim()))
  ? { relation: [{ id: String(id).trim() }] } : null;

// Assign only non-null properties.
function build(pairs) {
  const out = {};
  for (const [k, v] of pairs) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function ddmmyyyy(iso) {
  // "YYYY-MM-DD" -> "DD-MM-YYYY"
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || '');
}

async function createPage(databaseId, properties) {
  return notion('pages', 'POST', {
    parent: { database_id: databaseId },
    properties,
  });
}

// ── Per-type handlers ──────────────────────────────────────────────────────
async function handleTraining(p) {
  // type is "Run" or "Strength" (Session Category select). athleteId -> Athlete relation.
  const name = p.name || [p.athleteName, p.session, p.date].filter(Boolean).join(' — ');
  const properties = build([
    ['Name', title(name)],
    ['Session', rt(p.session)],
    ['Session Category', sel(p.type)],
    ['Exercise Log', rt(p.exerciseLog)],
    ['Athlete Code', rt(p.athleteCode)],
    ['Date', dat(p.date)],
    ['Athlete', rel(p.athleteId)],
  ]);
  return createPage(DB.training, properties);
}

async function handleCheckin(p) {
  const name = p.name || (p.athleteName || '');
  const fullName = has(p.weekEnding) ? `${name} - ${ddmmyyyy(p.weekEnding)}` : name;
  const properties = build([
    ['Name', title(fullName)],
    ['Week Ending', rt(p.weekEnding)],
    ['Week Ending Date', dat(p.weekEnding)],
    ['Run Completed', rt(p.runCompleted)],
    ['Run Planned', rt(p.runPlanned)],
    ['Weekly Run KM', rt(p.runKm)],
    ['Run Feel /10', rt(p.runFeel)],
    ['Runs Wins', rt(p.runWins)],
    ['Run Niggles', rt(p.runNiggles)],
    ['Lift Completed', rt(p.liftCompleted)],
    ['Lift Planned', rt(p.liftPlanned)],
    ['Lift Feel /10', rt(p.liftFeel)],
    ['Lift Wins', rt(p.liftWins)],
    ['Lifts Niggles', rt(p.liftNiggles)],
    ['Sleep hrs', rt(p.sleep)],
    ['Energy /10', rt(p.energy)],
    ['Soreness /10', rt(p.soreness)],
    ['Nutrition Adherence /10', rt(p.nutrition)],
    ['Fuelling', rt(p.fuelling)],
    ['Upcoming Impact', rt(p.upcomingImpact)],
    ['Social Event Upcoming', rt(p.socialEating)],
    ['Stress', rt(p.stress)],
    ['Motivation', rt(p.motivation)],
    ['Testimonial', rt(p.testimonial)],
    // Note: the Make check-in scenario left the Athlete relation empty (the
    // coaches dashboard matches on the name in the title), so we match that.
  ]);
  return createPage(DB.checkin, properties);
}

async function handleBody(p) {
  // Matches the old Make scenario: AthleteID (text) holds the athlete NAME.
  const properties = build([
    ['Name', title(`${p.athleteName || ''} — ${p.date || ''}`.trim())],
    ['AthleteID', rt(p.athleteName)],
    ['Weight', num(p.weight)],
    ['Date', dat(p.date)],
    ['Sleep Score', num(p.sleep)],
    ['Energy', num(p.energy)],
    ['Soreness', num(p.soreness)],
    ['Stress', num(p.stress)],
    ['Notes', rt(p.notes)],
    // Athlete relation intentionally left empty to match existing Make rows
    // (dashboard groups on the AthleteID text field = athlete name).
  ]);
  return createPage(DB.body, properties);
}

async function handleNutrition(p) {
  // Matches the old Make scenario: AthleteID (text) holds the athlete NAME.
  const properties = build([
    ['Name', title(`${p.athleteName || ''} — ${p.date || ''}`.trim())],
    ['AthleteID', rt(p.athleteName)],
    ['Date', dat(p.date)],
    ['Calories', num(p.calories)],
    ['Protein', num(p.protein)],
    ['Carbs', num(p.carbs)],
    ['Fats', num(p.fat)],
    ['Fibre', num(p.fibre)],
    ['Notes', rt(p.notes)],
    // Athlete relation intentionally left empty to match existing rows
    // (dashboard groups on the AthleteID text field = athlete name).
  ]);
  return createPage(DB.nutrition, properties);
}

async function handleGoals(p) {
  // Find the athlete's profile page, then update goal fields on it.
  let pageId = (has(p.athleteId) && UUID_RE.test(String(p.athleteId).trim()))
    ? String(p.athleteId).trim() : '';

  if (!pageId) {
    if (!has(p.athleteCode)) throw new Error('goals: missing athleteId and athleteCode');
    const q = await notion(`databases/${DB.athlete}/query`, 'POST', {
      filter: { property: 'Code', rich_text: { equals: String(p.athleteCode) } },
      page_size: 1,
    });
    if (!q.results || !q.results.length) throw new Error('goals: athlete not found for code ' + p.athleteCode);
    pageId = q.results[0].id;
  }

  const properties = build([
    ['Goal Race', rt(p.goalRace)],
    ['Race Date', rt(p.raceDate)],
    ['Weekly KM Target', rt(p.peakWeek)],
    ['Body Weight (kg)', rt(p.weight)],
    ['Target Weight', rt(p.targetWeight)],
    ['Body Fat %', rt(p.bodyFat)],
    ['5km Time', rt(p.time5k)],
    ['10km Time', rt(p.time10k)],
    ['Half Marathon Time', rt(p.timeHalf)],
    ['Marathon Time', rt(p.timeMarathon)],
    ['Long Run Pace', rt(p.lrPace)],
    ['Your Why', rt(p.why)],
    ['Milestone W4', rt(p.m4)],
    ['Milestone W8', rt(p.m8)],
    ['Milestone W12', rt(p.m12)],
  ]);
  return notion(`pages/${pageId}`, 'PATCH', { properties });
}

// ── GHL check-in tagging ────────────────────────────────────────────────────
// On a weekly check-in submit, find the athlete's GHL contact via the
// Supabase ghl_map table (athlete_code -> ghl_contact_id) and add the
// "checkin_done" tag, so the GHL reminder workflow skips them this week.
// Best-effort: any failure here must NOT block the check-in write.
//
// The Supabase client is imported LAZILY here (not at the top of the file) so a
// missing '@supabase/supabase-js' dependency cannot crash the whole function.
async function tagGhlCheckinDone(athleteCode) {
  if (!has(athleteCode)) return;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GHL_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GHL_API_KEY) {
    console.warn('[write] GHL tagging skipped — missing env vars');
    return;
  }

  let createClient;
  try {
    ({ createClient } = await import('@supabase/supabase-js'));
  } catch (e) {
    console.warn('[write] GHL tagging skipped — @supabase/supabase-js not installed');
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await sb
    .from('ghl_map')
    .select('ghl_contact_id')
    .eq('athlete_code', String(athleteCode))
    .single();

  if (error || !data || !data.ghl_contact_id) {
    console.warn('[write] no ghl_map row for code', athleteCode);
    return;
  }

  const resp = await fetch(
    `https://services.leadconnectorhq.com/contacts/${data.ghl_contact_id}/tags`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: ['checkin_done'] }),
    }
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`GHL tag ${resp.status}: ${t}`);
  }
}

// ── Body parsing (robust to Vercel auto-parse or raw stream) ────────────────
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!NOTION_TOKEN) return res.status(500).json({ ok: false, error: 'NOTION_TOKEN not configured' });

  let p;
  try { p = await readBody(req); } catch { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }

  const type = String(p && p.type || '').trim();
  if (type === 'test_ping') return res.status(200).json({ ok: true, skipped: 'test_ping' });

  try {
    let result;
    switch (type) {
      case 'Run':
      case 'Strength':
      case 'training_log':
        result = await handleTraining(p); break;
      case 'weekly_checkin':
        result = await handleCheckin(p);
        // Best-effort GHL tag — never let this fail the check-in write.
        try { await tagGhlCheckinDone(p.athleteCode); }
        catch (e) { console.warn('[write] GHL tag failed:', e && e.message); }
        break;
      case 'daily_body':
        result = await handleBody(p); break;
      case 'daily_nutrition':
        result = await handleNutrition(p); break;
      case 'goals':
        result = await handleGoals(p); break;
      default:
        return res.status(400).json({ ok: false, error: 'Unknown type: "' + type + '"' });
    }
    return res.status(200).json({ ok: true, type, id: result && result.id });
  } catch (err) {
    console.error('[write] type=' + type + ' error:', err && err.message);
    return res.status(502).json({ ok: false, type, error: (err && err.message) || 'Write failed' });
  }
}
