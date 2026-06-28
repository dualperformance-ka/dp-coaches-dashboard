// /api/coach-data.js
// Server-side bridge from athlete portal Supabase tables to the coaches dashboard.
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the dashboard Vercel project.

const TABLES = {
  body: 'daily_body_logs',
  nutrition: 'daily_nutrition_logs',
  sessions: 'training_session_logs',
  weekly: 'weekly_checkins',
  goals: 'athlete_goals',
};

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function selectAll(table, orderColumn) {
  const baseUrl = cleanBaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!baseUrl || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY is not configured');
  }

  const rows = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const order = orderColumn ? `&order=${encodeURIComponent(orderColumn)}.desc` : '';
    const url = `${baseUrl}/rest/v1/${table}?select=*${order}`;

    const response = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${to}`,
        Prefer: 'count=exact',
      },
    });

    const body = await response.text();
    let data;

    try {
      data = body ? JSON.parse(body) : [];
    } catch {
      throw new Error(`Invalid Supabase response for ${table}`);
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        `Supabase returned ${response.status} for ${table}`
      );
    }

    const pageRows = Array.isArray(data) ? data : [];
    rows.push(...pageRows);

    if (pageRows.length < PAGE_SIZE) break;
  }

  return rows;
}

function mapBody(row) {
  return {
    AthleteID: row.athlete_code,
    AthleteName: row.athlete_name,
    'date:Date:start': row.log_date,
    Date: row.log_date,
    Weight: row.weight,
    'Sleep Score': row.sleep,
    Energy: row.energy,
    Stress: row.stress,
    Soreness: row.soreness,
    Notes: row.notes,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

function mapNutrition(row) {
  return {
    AthleteID: row.athlete_code,
    AthleteName: row.athlete_name,
    'date:Date:start': row.log_date,
    Date: row.log_date,
    Calories: row.calories,
    Protein: row.protein,
    Carbs: row.carbs,
    Fats: row.fat,
    Fibre: row.fibre,
    Notes: row.notes,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

function mapSession(row) {
  const code = row.athlete_code || '';

  return {
    'Athlete Code': code,
    AthleteID: code,
    AthleteName: row.athlete_name,
    Name: `${code} — ${row.session_name || ''} — ${row.session_date || ''}`,
    Session: row.session_name || '',
    'Session Category': row.session_category || '',
    'Exercise Log': row.exercise_log || '',
    Notes: row.notes || '',
    Date: row.session_date,
    'date:Date:start': row.session_date,
    _clientWriteId: row.client_write_id,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

function mapWeekly(row) {
  return {
    Name: row.athlete_name || row.athlete_code,
    'Week Ending': row.week_ending || null,
    'Run Completed': row.run_completed,
    'Run Planned': row.run_planned,
    'Weekly Run KM': row.run_km,
    'Run Feel /10': row.run_feel,
    'Runs Wins': row.run_wins,
    'Run Niggles': row.run_niggles,
    'Lift Completed': row.lift_completed,
    'Lift Planned': row.lift_planned,
    'Lift Feel /10': row.lift_feel,
    'Lift Wins': row.lift_wins,
    'Lifts Niggles': row.lift_niggles,
    'Sleep hrs': row.sleep,
    'Energy /10': row.energy,
    'Soreness /10': row.soreness,
    'Nutrition Adherence /10': row.nutrition,
    Fuelling: row.fuelling,
    'Social Event Upcoming': row.social_eating,
    Stress: row.stress,
    Motivation: row.motivation,
    'Upcoming Impact': row.upcoming_impact,
    Testimonial: row.testimonial,
    _athleteCode: row.athlete_code,
    _weekKey: row.week_key,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

function mapGoal(row) {
  return {
    athlete_code: row.athlete_code,
    athlete_name: row.athlete_name,
    goal_race: row.goal_race,
    race_date: row.race_date,
    peak_week: row.peak_week,
    start_weight: row.start_weight,
    target_weight: row.target_weight,
    body_fat: row.body_fat,
    time_5k: row.time_5k,
    time_10k: row.time_10k,
    time_half: row.time_half,
    time_marathon: row.time_marathon,
    long_run_pace: row.long_run_pace,
    why: row.why,
    milestone_w4: row.milestone_w4,
    milestone_w8: row.milestone_w8,
    milestone_w12: row.milestone_w12,
    _source: 'portal_supabase',
    _submittedAt: row.submitted_at,
    _updatedAt: row.updated_at,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const [body, nutrition, sessions, weekly, goals] = await Promise.all([
      selectAll(TABLES.body, 'log_date'),
      selectAll(TABLES.nutrition, 'log_date'),
      selectAll(TABLES.sessions, 'session_date'),
      selectAll(TABLES.weekly, 'week_ending'),
      selectAll(TABLES.goals, 'updated_at'),
    ]);

    return res.status(200).json({
      ok: true,
      source: 'portal_supabase',
      generatedAt: new Date().toISOString(),
      counts: {
        body: body.length,
        nutrition: nutrition.length,
        sessions: sessions.length,
        weekly: weekly.length,
        goals: goals.length,
      },
      body: body.map(mapBody),
      nutrition: nutrition.map(mapNutrition),
      sessions: sessions.map(mapSession),
      weekly: weekly.map(mapWeekly),
      goals: goals.map(mapGoal),
    });
  } catch (error) {
    console.error('[coach-data]', error);

    return res.status(200).json({
      ok: false,
      source: 'portal_supabase',
      generatedAt: new Date().toISOString(),
      error: error.message,
      counts: { body: 0, nutrition: 0, sessions: 0, weekly: 0, goals: 0 },
      body: [],
      nutrition: [],
      sessions: [],
      weekly: [],
      goals: [],
    });
  }
}
