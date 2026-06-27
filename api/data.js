// api/data.js — Supabase-first data proxy with automatic Notion fallback
// ---------------------------------------------------------------------------
// Drop-in companion to api/notion.js. The dashboard currently calls
//   /api/notion?db=<notion-database-id>
// Point those calls at
//   /api/data?db=<notion-database-id>
// (same query param, same response shape) and the dashboard will read from
// Supabase — where the athlete portals now write — instead of Notion.
//
// Behaviour per database:
//   • weekly     → MERGE of Supabase (recent, authoritative) + Notion (history)
//   • body       → Supabase daily_body_logs        (full history lives here)
//   • nutrition  → Supabase daily_nutrition_logs   (full history lives here)
//   • sessions   → Supabase training_session_logs  (full history lives here)
// If Supabase errors or returns nothing for a database, it transparently
// falls back to the Notion proxy logic, so nothing breaks during cutover.
//
// Response shape is identical to api/notion.js: { results, total }.
// Each row uses the SAME property names the dashboard already reads from
// Notion (e.g. "Run Completed", "Weekly Run KM", "Weight"), plus the
// date:<Prop>:start / :end / :is_datetime expansions.
//
// ES Module syntax (this repo's package.json has "type": "module").
// Environment variables — ALL ALREADY SET in this project:
//   SUPABASE_URL          (set Jun 3)
//   SUPABASE_SERVICE_KEY  (service role key — bypasses RLS for reads)
//   NOTION_TOKEN          (already set — fallback + weekly history + unmapped DBs)
// The dashboard's index.html already calls /api/data?db=<id>, so this file
// must exist. Unmapped database IDs fall through to Notion automatically.
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rugdupplsswxmpoudhpv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const MAX_PAGES = 600;

// Notion database IDs the dashboard already requests (public/index.html → DB object)
const DB = {
  weekly:    '33e5a96c-c70b-8049-b696-d22e5920e0ee',
  sessions:  '1c55a96c-c70b-825b-9bdf-819abea4ef7c',
  body:      '3405a96c-c70b-80a4-b1b9-cf5b9c236f18',
  nutrition: '3405a96c-c70b-804b-aa9c-f165f2d2e0e9',
};
const norm = id => (id || '').replace(/-/g, '');
const TYPE_BY_ID   = Object.fromEntries(Object.entries(DB).map(([k, v]) => [v, k]));
const TYPE_BY_NORM = Object.fromEntries(Object.entries(DB).map(([k, v]) => [norm(v), k]));

// Notion "Athlete Database" roster id. We serve it from Notion but overlay the
// athlete's own portal-submitted goals (Supabase athlete_goals) on top.
const ATHLETE_DB = '4a25a96c-c70b-82ff-a679-0139eaa8b458';

// ─── small helpers ────────────────────────────────────────────────────────
const s = v => (v === null || v === undefined) ? '' : String(v);
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
function dateFields(name, val) {
  const start = val || null;
  return {
    [`date:${name}:start`]: start,
    [`date:${name}:end`]: null,
    [`date:${name}:is_datetime`]: start && String(start).includes('T') ? 1 : 0,
  };
}

// ─── Supabase (PostgREST) fetch ───────────────────────────────────────────
async function sbFetch(path) {
  if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// ─── Mappers: Supabase row → Notion-shaped row the dashboard expects ──────
function mapWeekly(rows) {
  return rows
    // Skip "checked-in" flag entries (value is a bare number) and empty
    // placeholders — only render rows that carry real check-in content.
    .filter(r => r.value && typeof r.value === 'object'
      && (r.value.weekEnding || r.value.testimonial || r.value.runKm || r.value.runFeel))
    .map(r => {
    const v = r.value || {};
    const who = (v.athleteName || v.athleteCode || r.athlete_code || '').toString().toUpperCase();
    return {
      _id: r.id, _url: '', _createdTime: r.updated_at,
      'Name': `${who} — ${v.weekEnding || ''}`,
      'Week Ending': s(v.weekEnding),
      'Week Ending Date': s(v.weekEnding),
      ...dateFields('Week Ending Date', v.weekEnding || null),
      'Run Completed': s(v.runCompleted),
      'Run Planned': s(v.runPlanned),
      'Weekly Run KM': s(v.runKm),
      'Run Feel /10': s(v.runFeel),
      'Run Niggles': s(v.runNiggles),
      'Runs Wins': s(v.runWins),
      'Lift Completed': s(v.liftCompleted),
      'Lift Planned': s(v.liftPlanned),
      'Lift Feel /10': s(v.liftFeel),
      'Lift Wins': s(v.liftWins),
      'Lifts Niggles': s(v.liftNiggles),
      'Sleep hrs': s(v.sleep),
      'Energy /10': s(v.energy),
      'Soreness /10': s(v.soreness),
      'Nutrition Adherence /10': s(v.nutrition),
      'Fuelling': s(v.fuelling),
      'Upcoming Impact': s(v.upcomingImpact),
      'Social Event Upcoming': s(v.socialEating),
      'Stress': s(v.stress),
      'Motivation': s(v.motivation),
      'Testimonial': s(v.testimonial),
      'Notes': s(v.notes),
      'Submitted At': r.updated_at,
      'Athlete Code': s(v.athleteCode || r.athlete_code),
      'Athlete': null,
    };
  });
}

function mapBody(rows) {
  // Portal collects: weight, sleep, energy, stress, soreness, notes.
  // (Motivation / RPE / Pain / Session / Coach Alert are not athlete inputs → null.)
  return rows.map(r => ({
    _id: r.id, _url: '', _createdTime: r.submitted_at,
    'Name': s(r.athlete_name || r.athlete_code),
    'AthleteID': s(r.athlete_code),
    'Date': s(r.log_date),
    ...dateFields('Date', r.log_date),
    'Weight': num(r.weight),
    'Sleep Score': num(r.sleep),
    'Energy': num(r.energy),
    'Stress': num(r.stress),
    'Soreness': num(r.soreness),
    'Motivation': null,
    'RPE': null,
    'Pain': null,
    'Session': '',
    'Notes': s(r.notes),
    'Coach Alert': null,
    'Submitted At': r.submitted_at,
    'Athlete': null,
  }));
}

function mapNutrition(rows) {
  return rows.map(r => ({
    _id: r.id, _url: '', _createdTime: r.submitted_at,
    'Name': s(r.athlete_name || r.athlete_code),
    'AthleteID': s(r.athlete_code),
    'Date': s(r.log_date),
    ...dateFields('Date', r.log_date),
    'Calories': num(r.calories),
    'Protein': num(r.protein),
    'Carbs': num(r.carbs),
    'Fats': num(r.fat),       // Notion property is "Fats"; Supabase column is "fat"
    'Fibre': num(r.fibre),
    'Notes': s(r.notes),
    'Created time': r.submitted_at,
    'Athlete': null,
  }));
}

function mapSessions(rows) {
  return rows.map(r => ({
    _id: r.id, _url: '', _createdTime: r.submitted_at,
    'Name': s(r.session_name || r.athlete_name || r.athlete_code),
    'Session': s(r.session_name),
    'Session Category': s(r.session_category),
    // Dashboard's parseExerciseLine splits exercises by newline; Supabase
    // separates them with "  ||  ". Convert so names/sets align correctly.
    'Exercise Log': s(r.exercise_log).replace(/\s*\|\|\s*/g, '\n'),
    'Athlete Code': s(r.athlete_code),
    'Date': s(r.session_date),
    ...dateFields('Date', r.session_date),
    'Submitted At': r.submitted_at,
    'Athlete': null,
  }));
}

async function fromSupabase(type) {
  switch (type) {
    case 'weekly':
      return mapWeekly(await sbFetch(
        'athlete_data?key=like.checkin_*&select=id,athlete_code,value,updated_at&order=updated_at.desc'));
    case 'body':
      return mapBody(await sbFetch('daily_body_logs?select=*&order=submitted_at.desc'));
    case 'nutrition':
      return mapNutrition(await sbFetch('daily_nutrition_logs?select=*&order=submitted_at.desc'));
    case 'sessions':
      return mapSessions(await sbFetch('training_session_logs?select=*&order=submitted_at.desc'));
    default:
      return null;
  }
}

// ─── Notion fallback (mirrors api/notion.js exactly) ──────────────────────
function extractProp(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case 'title':        return prop.title?.map(t => t.plain_text).join('') ?? '';
    case 'rich_text':    return prop.rich_text?.map(t => t.plain_text).join('') ?? '';
    case 'number':       return prop.number ?? null;
    case 'date':         return prop.date?.start ?? null;
    case 'select':       return prop.select?.name ?? null;
    case 'multi_select': return (prop.multi_select ?? []).map(o => o.name);
    case 'relation':     return (prop.relation ?? []).map(r => r.id);
    case 'created_time': return prop.created_time ?? null;
    case 'checkbox':     return prop.checkbox ?? null;
    case 'url':          return prop.url ?? null;
    case 'email':        return prop.email ?? null;
    case 'phone_number': return prop.phone_number ?? null;
    default:             return null;
  }
}
function parsePage(page) {
  const out = { _id: page.id, _url: page.url, _createdTime: page.created_time };
  for (const [key, val] of Object.entries(page.properties ?? {})) {
    out[key] = extractProp(val);
    if (val?.type === 'date') {
      out[`date:${key}:start`] = val.date?.start ?? null;
      out[`date:${key}:end`] = val.date?.end ?? null;
      out[`date:${key}:is_datetime`] = val.date?.start?.includes('T') ? 1 : 0;
    }
  }
  return out;
}
async function queryNotion(dbId, cursor = null) {
  const body = { page_size: 100 };
  if (cursor) body.start_cursor = cursor;
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Notion API ${res.status}: ${err.message || res.statusText}`);
  }
  return res.json();
}
async function fromNotion(dbId) {
  let all = [], cursor = null, hasMore = true;
  while (hasMore && all.length < MAX_PAGES) {
    const data = await queryNotion(dbId, cursor);
    all = all.concat(data.results.map(parsePage));
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }
  return all;
}

// Overlay portal-submitted goals (Supabase athlete_goals) onto the Notion
// roster rows, matched by athlete Code. Portal value wins when present.
function overlayGoals(rosterRows, goals) {
  const byKey = {};
  for (const g of goals) {
    if (g.athlete_code) byKey[String(g.athlete_code).toUpperCase().trim()] = g;
    if (g.athlete_name) byKey[String(g.athlete_name).toUpperCase().trim()] ??= g;
  }
  const MAP = {
    goal_race: 'Goal Race', race_date: 'Race Date', target_weight: 'Target Weight',
    body_fat: 'Body Fat %', time_5k: '5km Time', time_10k: '10km Time',
    time_half: 'Half Marathon Time', time_marathon: 'Marathon Time',
    long_run_pace: 'Long Run Pace', why: 'Your Why',
    milestone_w4: 'Milestone W4', milestone_w8: 'Milestone W8', milestone_w12: 'Milestone W12',
  };
  for (const row of rosterRows) {
    const key = String(row['Code'] || row['Athlete'] || '').toUpperCase().trim();
    const g = byKey[key];
    if (!g) continue;
    for (const [col, prop] of Object.entries(MAP)) {
      const v = g[col];
      if (v !== null && v !== undefined && String(v).trim() !== '') row[prop] = String(v);
    }
  }
  return rosterRows;
}

// Merge Supabase weekly (recent) with Notion weekly (history), deduped by
// athlete + week-ending. Supabase wins on conflict.
function mergeWeekly(sup, notion) {
  const keyOf = r => {
    const who = String(r['Name'] || '').split('—')[0].trim().toUpperCase();
    const wk = r['Week Ending Date'] || r['Week Ending'] || '';
    return `${who}|${wk}`;
  };
  const seen = new Set(sup.map(keyOf));
  const extra = notion.filter(r => !seen.has(keyOf(r)));
  return [...sup, ...extra];
}

// ─── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { db } = req.query;
  if (!db) { res.status(400).json({ error: 'Missing ?db= query parameter' }); return; }

  // Migration helper: ?raw=notion returns the raw Notion rows for this db,
  // bypassing Supabase. Used to diff/backfill Notion-only history into Supabase.
  if (req.query.raw === 'notion' && NOTION_TOKEN) {
    try {
      const rows = await fromNotion(db);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ results: rows, total: rows.length, source: 'notion-raw' });
    } catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // Athlete roster: serve Notion roster + overlay live portal goals from Supabase.
  if (norm(db) === norm(ATHLETE_DB)) {
    let roster = [];
    try { roster = await fromNotion(db); } catch (e) { console.error('[data] roster notion:', e.message); }
    let goals = [];
    if (SUPABASE_KEY) {
      try { goals = await sbFetch('athlete_goals?select=*'); }
      catch (e) { console.error('[data] athlete_goals:', e.message); }
    }
    const results = overlayGoals(roster, goals);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    res.setHeader('X-Data-Source', 'notion+supabase-goals');
    res.status(200).json({ results, total: results.length, source: 'notion+supabase-goals' });
    return;
  }

  const type = TYPE_BY_ID[db] || TYPE_BY_NORM[norm(db)] || null;
  let results = null;
  let source = 'supabase';

  // 1) Try Supabase for known databases
  if (type && SUPABASE_KEY) {
    try { results = await fromSupabase(type); }
    catch (e) { console.error('[data] supabase error:', e.message); results = null; }
  }

  // 2) Fall back to Notion only when Supabase has nothing — keeps Notion as a
  //    pure backup. (All real weekly history has been backfilled into Supabase,
  //    so weekly no longer needs the always-on merge.)
  try {
    if ((!results || results.length === 0) && NOTION_TOKEN) {
      results = await fromNotion(db);
      source = 'notion';
    }
  } catch (e) {
    console.error('[data] notion fallback error:', e.message);
    if (!results) { res.status(500).json({ error: e.message }); return; }
  }

  if (!results) { res.status(500).json({ error: 'No data source available' }); return; }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  res.setHeader('X-Data-Source', source);
  res.status(200).json({ results, total: results.length, source });
};
