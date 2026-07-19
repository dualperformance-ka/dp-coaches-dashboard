// /api/apply.js — public application intake → Supabase public.applications
// -----------------------------------------------------------------------------
// Replaces the old "application form → Notion" write. Point the athlete
// application form's submit URL at:
//     POST https://<dashboard-domain>/api/apply
// with a JSON body of the applicant's answers. Field names are matched
// flexibly (camelCase or the old Notion property names), and the full raw
// submission is always stored in raw_payload so nothing is ever lost.
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// No Notion dependency.
// -----------------------------------------------------------------------------

const SB_URL = process.env.SUPABASE_URL || 'https://rugdupplsswxmpoudhpv.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Pick the first present value across a list of accepted key spellings.
function pick(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}
const numOrNull = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!SB_KEY) return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_KEY not configured' });

  let b;
  try { b = await readBody(req); } catch { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }

  // Ignore test pings / empty posts.
  if (String(b.type || '').trim() === 'test_ping') return res.status(200).json({ ok: true, skipped: 'test_ping' });

  const row = {
    name:            pick(b, ['name', 'Name', 'fullName', 'Full Name']),
    age:             numOrNull(pick(b, ['age', 'Age'])),
    email:           pick(b, ['email', 'Email']),
    phone:           pick(b, ['phone', 'Phone', 'phoneNumber', 'Phone Number']),
    instagram:       pick(b, ['instagram', 'Instagram', 'ig']),
    occupation:      pick(b, ['occupation', 'Occupation']),
    current_status:  pick(b, ['currentStatus', 'Current Status', 'status']),
    days_run:        pick(b, ['daysRun', 'Days Per Week (Run)', 'runDays']),
    days_gym:        pick(b, ['daysGym', 'Days per Week (Gym)', 'gymDays']),
    injuries:        pick(b, ['injuries', 'Injuries']),
    biggest_barrier: pick(b, ['biggestBarrier', 'Biggest Barrier', 'barrier']),
    three_month_goal:pick(b, ['threeMonthGoal', 'Three Month Goal', 'goal']),
    nutrition_hurdles:pick(b, ['nutritionHurdles', 'Nutrition Hurdles']),
    life_change:     pick(b, ['lifeChange', 'Life Change']),
    submitted_at:    new Date().toISOString(),
    source:          'form',
    raw_payload:     b,
  };

  // Require at least a name or email so junk/empty posts don't create rows.
  if (!row.name && !row.email) {
    return res.status(400).json({ ok: false, error: 'Missing name and email' });
  }

  try {
    const r = await fetch(`${SB_URL}/rest/v1/applications`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify([row]),
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${JSON.stringify(json)}`);
    const saved = Array.isArray(json) && json[0] ? json[0] : null;
    return res.status(200).json({ ok: true, id: saved && saved.id });
  } catch (err) {
    console.error('[apply] error:', err && err.message);
    return res.status(502).json({ ok: false, error: (err && err.message) || 'Insert failed' });
  }
}
