// api/sync-notion.js — Notion → Supabase sync (ESM; repo is "type":"module")
// ---------------------------------------------------------------------------
// Pulls every row from the four athlete Notion databases and inserts anything
// missing into the matching Supabase tables, so the dashboard (which reads
// Supabase) always reflects Notion. Idempotent: dedupes by athlete + date
// (+ session name), so re-running never creates duplicates.
//
// Runs automatically via the Vercel cron in vercel.json, and can be triggered
// manually:  GET /api/sync-notion
//
// Uses env vars already configured in this project:
//   NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Optional: set CRON_SECRET to require ?token=<secret> (or the Vercel cron
// Authorization header). If CRON_SECRET is unset, the endpoint is open
// (harmless — it only copies Notion data and dedupes).
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rugdupplsswxmpoudhpv.supabase.co';
const SVC = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';
const MAX_PAGES = 4000;

const DB = {
  body:      '3405a96c-c70b-80a4-b1b9-cf5b9c236f18',
  nutrition: '3405a96c-c70b-804b-aa9c-f165f2d2e0e9',
  sessions:  '1c55a96c-c70b-825b-9bdf-819abea4ef7c',
  weekly:    '33e5a96c-c70b-8049-b696-d22e5920e0ee',
};

// ── athlete code normalisation (Notion names → canonical Supabase codes) ──
function canon(raw) {
  let v = String(raw || '').toUpperCase().trim().split('—')[0].split(' - ')[0].trim();
  if (!v) return '';
  if (v.startsWith('VINCENT') || v === 'VINO') return 'VINO';
  if (v.startsWith('THOMAS')) return 'THOMAS';
  if (v.startsWith('BRYAN')) return 'BRYAN';
  return v.split(/\s+/)[0].trim();
}
const d10 = s => (s ? String(s).slice(0, 10) : '');
function isoWeek(s) {
  const d = new Date(s); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const wk = 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return d.getFullYear() + '_' + wk;
}

// ── Notion read ──
function extractProp(p) {
  if (!p) return null;
  switch (p.type) {
    case 'title':        return p.title?.map(t => t.plain_text).join('') ?? '';
    case 'rich_text':    return p.rich_text?.map(t => t.plain_text).join('') ?? '';
    case 'number':       return p.number ?? null;
    case 'date':         return p.date?.start ?? null;
    case 'select':       return p.select?.name ?? null;
    case 'multi_select': return (p.multi_select ?? []).map(o => o.name);
    case 'created_time': return p.created_time ?? null;
    case 'checkbox':     return p.checkbox ?? null;
    default:             return null;
  }
}
function parsePage(pg) {
  const o = { _createdTime: pg.created_time };
  for (const [k, v] of Object.entries(pg.properties ?? {})) {
    o[k] = extractProp(v);
    if (v?.type === 'date') o[`date:${k}:start`] = v.date?.start ?? null;
  }
  return o;
}
async function fromNotion(dbId) {
  let all = [], cursor = null, more = true;
  while (more && all.length < MAX_PAGES) {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }),
    });
    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    all = all.concat(data.results.map(parsePage));
    more = data.has_more; cursor = data.next_cursor;
  }
  return all;
}

// ── Supabase (service role) ──
const SBH = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SBH });
  if (!r.ok) throw new Error(`Supabase GET ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}
async function sbInsert(table, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST', headers: { ...SBH, Prefer: 'return=minimal' }, body: JSON.stringify(batch),
    });
    if (!r.ok) throw new Error(`Supabase INSERT ${table} ${r.status}: ${await r.text().catch(() => '')}`);
    inserted += batch.length;
  }
  return inserted;
}
const num = v => (v === null || v === undefined || v === '') ? null : Number(v);

// ── per-type sync ──
async function syncDaily(type, table, mapFields) {
  const notion = await fromNotion(DB[type]);
  const existing = await sbGet(`${table}?select=athlete_code,log_date`);
  const have = new Set(existing.map(e => `${e.athlete_code}|${d10(e.log_date)}`));
  const seen = new Set(), rows = [];
  for (const x of notion) {
    const code = canon(x['AthleteID'] || x['Name']);
    const date = d10(x['date:Date:start'] || x['Date']);
    if (!code || !date) continue;
    const k = `${code}|${date}`;
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);
    rows.push({
      athlete_code: code,
      athlete_name: String(x['Name'] || code).split('—')[0].trim(),
      log_date: date,
      submitted_at: x._createdTime || new Date().toISOString(),
      ...mapFields(x),
      raw_payload: { source: 'notion-sync' },
    });
  }
  const inserted = rows.length ? await sbInsert(table, rows) : 0;
  return { notion: notion.length, existing: existing.length, inserted };
}

async function syncSessions() {
  const notion = await fromNotion(DB.sessions);
  const existing = await sbGet('training_session_logs?select=athlete_code,session_date,session_name');
  const have = new Set(existing.map(e => `${e.athlete_code}|${d10(e.session_date)}|${String(e.session_name || '').slice(0, 30)}`));
  const seen = new Set(), rows = [];
  for (const x of notion) {
    const code = canon(x['Athlete Code'] || x['Name']);
    const date = d10(x['date:Date:start'] || x['Date']);
    const name = String(x['Session'] || x['Name'] || '').trim();
    if (!code || !date) continue;
    const k = `${code}|${date}|${name.slice(0, 30)}`;
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);
    rows.push({
      athlete_code: code,
      athlete_name: String(x['Name'] || code).split('—')[0].trim(),
      session_name: name || null,
      session_category: x['Session Category'] || null,
      session_date: date,
      exercise_log: x['Exercise Log'] || null,
      submitted_at: x._createdTime || new Date().toISOString(),
      raw_payload: { source: 'notion-sync' },
    });
  }
  const inserted = rows.length ? await sbInsert('training_session_logs', rows) : 0;
  return { notion: notion.length, existing: existing.length, inserted };
}

async function syncWeekly() {
  const notion = await fromNotion(DB.weekly);
  const existing = await sbGet("athlete_data?select=athlete_code,key&key=like.checkin_*");
  const have = new Set(existing.map(e => `${e.athlete_code}|${e.key}`));
  const real = x => [x['Testimonial'], x['Run Feel /10'], x['Energy /10'], x['Weekly Run KM'], x['Runs Wins'], x['Lift Wins'], x['Motivation']]
    .some(v => v && String(v).trim() !== '');
  const seen = new Set(), rows = [];
  for (const x of notion) {
    const we = d10(x['date:Week Ending Date:start'] || x['Week Ending Date'] || x['Week Ending']);
    const code = canon(x['Name']);
    if (!we || !code || !real(x)) continue;
    const key = 'checkin_' + isoWeek(we);
    const k = `${code}|${key}`;
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);
    rows.push({
      athlete_code: code, key,
      value: {
        name: x['Name'], athleteName: code, athleteCode: code, weekEnding: we,
        runCompleted: x['Run Completed'], runPlanned: x['Run Planned'], runKm: x['Weekly Run KM'],
        runFeel: x['Run Feel /10'], runNiggles: x['Run Niggles'], runWins: x['Runs Wins'],
        liftCompleted: x['Lift Completed'], liftPlanned: x['Lift Planned'], liftFeel: x['Lift Feel /10'],
        liftWins: x['Lift Wins'], liftNiggles: x['Lifts Niggles'], sleep: x['Sleep hrs'],
        energy: x['Energy /10'], soreness: x['Soreness /10'], nutrition: x['Nutrition Adherence /10'],
        fuelling: x['Fuelling'], upcomingImpact: x['Upcoming Impact'], socialEating: x['Social Event Upcoming'],
        stress: x['Stress'], motivation: x['Motivation'], testimonial: x['Testimonial'],
        submittedAt: x._createdTime, source: 'notion-sync',
      },
      updated_at: x._createdTime || new Date().toISOString(),
    });
  }
  const inserted = rows.length ? await sbInsert('athlete_data', rows) : 0;
  return { notion: notion.length, existing: existing.length, inserted };
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (token !== process.env.CRON_SECRET) { res.status(401).json({ error: 'unauthorized' }); return; }
  }
  if (!SVC || !NOTION_TOKEN) { res.status(500).json({ error: 'Missing SUPABASE_SERVICE_KEY or NOTION_TOKEN' }); return; }

  const out = {};
  try {
    out.body      = await syncDaily('body', 'daily_body_logs', x => ({
      weight: num(x['Weight']), sleep: num(x['Sleep Score']), energy: num(x['Energy']),
      stress: num(x['Stress']), soreness: num(x['Soreness']), notes: x['Notes'] || null,
    }));
    out.nutrition = await syncDaily('nutrition', 'daily_nutrition_logs', x => ({
      calories: num(x['Calories']), protein: num(x['Protein']), carbs: num(x['Carbs']),
      fat: num(x['Fats']), fibre: num(x['Fibre']), notes: x['Notes'] || null,
    }));
    out.sessions  = await syncSessions();
    out.weekly    = await syncWeekly();
    out.ok = true;
    res.status(200).json(out);
  } catch (e) {
    out.ok = false; out.error = e.message;
    res.status(500).json(out);
  }
}
