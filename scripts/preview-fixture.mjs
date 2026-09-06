// Deterministic coach-data fixture for scripts/serve-preview.mjs.
//
// WHY THIS EXISTS
// The preview server previously stubbed only /api/coach-data?mode=triage, so
// Today rendered its queue and every other surface — Squad, Calendar, the
// athlete workspace, the session drawer — loaded against an empty dataset and
// could not be inspected at all. Visual verification of Phase 1-3 was therefore
// impossible without pointing a browser at production data.
//
// This is a VERIFICATION HARNESS, not product data. Nothing here is served by
// api/coach-data.js and nothing reaches Supabase. The shapes are copied from
// api/coach-data.js's mapBody/mapNutrition/mapWeekly/mapGoal/mapSession and from
// the live planned_sessions / run_steps / session_exercises / athlete_data /
// athlete_activity_uploads column sets, so what renders here is what renders in
// production for the same rows.
//
// The roster is chosen to cover the states the validation matrix asks for
// rather than to look tidy:
//   KAI  submitted run with device laps that DO line up with the prescription
//   SARAH  submitted strength, stagnant load, day awaiting review
//   JAMES  submitted long run whose device auto-lapped every km — lap matching
//          must refuse to pair those laps to prescribed steps
//   ANNA   ticked the session but submitted nothing (Rule 1), and has no goal
//          race set (empty-state copy)
//   LUCA   strength only, sharp load increase, no activity file at all
//   TOM    race week, compliance drift, a coach status of "Completed" on a
//          session the athlete never logged (planned_sessions.status must not
//          become athlete truth)

const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');

// Local (Australia/Adelaide) date string, not UTC — the same rule the dashboard
// uses. Building fixtures off toISOString() puts every date 9.5 hours behind and
// silently shifts the whole week for anyone checking a Monday boundary.
export function iso(daysAgo = 0, base = new Date()) {
  const d = new Date(base.getTime() - daysAgo * DAY);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const stamp = (daysAgo = 0) => new Date(Date.now() - daysAgo * DAY).toISOString();

// Monday of the current local week.
function weekStart(base = new Date()) {
  const d = new Date(base);
  const shift = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - shift);
}
const MON = weekStart();
const wk = offsetDays => {
  const d = new Date(MON.getTime() + offsetDays * DAY);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const ATHLETES = [
  { code: 'KAI', name: 'Kai Tran',    startDays: 63,  coach: 'KARL' },
  { code: 'SARAH', name: 'Sarah Chen',    startDays: 112, coach: 'KARL' },
  { code: 'JAMES', name: 'James Okafor',  startDays: 84,  coach: 'KARL' },
  { code: 'ANNA',  name: 'Anna Petrov',   startDays: 21,  coach: 'ALEX' },
  { code: 'LUCA',  name: 'Luca Bianchi',  startDays: 140, coach: 'ALEX' },
  { code: 'TOM',   name: 'Tom Reilly',    startDays: 175, coach: 'KARL' },
];

// ── athletes roster (/api/athletes?action=roster) ────────────────────────────
export const roster = () => ATHLETES.map(a => ({
  code: a.code,
  name: a.name,
  active: true,
  coach: a.coach,
  start_date: iso(a.startDays),
  race_target: a.code === 'ANNA' ? null : 'Marathon',
  archived_at: null,
  notifications_managed: true,
}));

// ── legacy Notion-shaped profiles (/api/athletes?action=profiles) ────────────
export const profiles = () => ATHLETES.map(a => ({
  Code: a.code,
  Athlete: a.name,
  'Start Date': iso(a.startDays),
  'date:Start Date:start': iso(a.startDays),
}));

// ── daily_body_logs → mapBody ────────────────────────────────────────────────
export function body() {
  const rows = [];
  ATHLETES.forEach((a, ai) => {
    for (let d = 27; d >= 0; d--) {
      // ANNA stops logging 6 days ago, which is what raises her "gone quiet"
      // signal. LUCA's soreness climbs alongside his load increase.
      if (a.code === 'ANNA' && d < 6) continue;
      if (a.code === 'TOM' && d % 3 === 0) continue;
      const drift = Math.sin((d + ai) / 4);
      rows.push({
        AthleteID: a.code,
        AthleteName: a.name,
        'date:Date:start': iso(d),
        Date: iso(d),
        Weight: Number((72 + ai * 3.5 - (27 - d) * 0.03 + drift * 0.25).toFixed(1)),
        'Sleep Score': Math.round(74 + drift * 9 - (a.code === 'KAI' && d < 4 ? 14 : 0)),
        Energy: Math.max(1, Math.round(7 + drift - (a.code === 'KAI' && d < 4 ? 3 : 0))),
        Stress: Math.max(1, Math.round(4 - drift + (a.code === 'TOM' && d < 7 ? 2 : 0))),
        Soreness: Math.max(1, Math.round(3 + (a.code === 'LUCA' && d < 8 ? 3 : 0) + drift * 0.5)),
        Notes: a.code === 'KAI' && d === 1 ? 'Right calf tight, 7/10 through the reps.' : '',
        _source: 'portal_supabase',
        _submittedAt: stamp(d),
        _updatedAt: stamp(d),
      });
    }
  });
  return rows;
}

// ── daily_nutrition_logs → mapNutrition ──────────────────────────────────────
export function nutrition() {
  const rows = [];
  ATHLETES.forEach((a, ai) => {
    for (let d = 27; d >= 0; d--) {
      if (a.code === 'ANNA' && d < 6) continue;
      if (a.code === 'JAMES' && d % 4 === 0) continue; // partial logger
      const drift = Math.cos((d + ai) / 5);
      rows.push({
        AthleteID: a.code,
        AthleteName: a.name,
        'date:Date:start': iso(d),
        Date: iso(d),
        Calories: Math.round(2450 + ai * 120 + drift * 210),
        Protein: Math.round(165 + ai * 8 + drift * 12),
        Carbs: Math.round(300 + ai * 14 + drift * 40),
        Fats: Math.round(72 + drift * 8),
        Fibre: Math.round(30 + drift * 5),
        Notes: '',
        _source: 'portal_supabase',
        _submittedAt: stamp(d),
        _updatedAt: stamp(d),
      });
    }
  });
  return rows;
}

// ── weekly_checkins → mapWeekly ──────────────────────────────────────────────
export function weekly() {
  const rows = [];
  ATHLETES.forEach((a, ai) => {
    for (let w = 4; w >= 0; w--) {
      const ending = wk(-7 * w + 6);
      if (a.code === 'ANNA' && w === 0) continue; // no check-in this week
      rows.push({
        Name: a.code,
        'Week Ending': ending,
        'Run Completed': 4 - (a.code === 'TOM' && w === 0 ? 2 : 0),
        'Run Planned': 5,
        'Weekly Run KM': 48 + ai * 6 + (4 - w) * 3 + (a.code === 'LUCA' && w === 0 ? 22 : 0),
        'Run Feel /10': 7 - (a.code === 'KAI' && w === 0 ? 3 : 0),
        'Runs Wins': w === 0 ? 'Held pace on the tempo.' : '',
        'Run Niggles': a.code === 'KAI' && w === 0 ? 'Right calf.' : '',
        'Lift Completed': 2,
        'Lift Planned': 3,
        'Lift Feel /10': 7,
        'Lift Wins': '',
        'Lifts Niggles': '',
        'Sleep hrs': 7.2,
        'Energy /10': 7 - (a.code === 'KAI' && w === 0 ? 2 : 0),
        'Soreness /10': 3 + (a.code === 'LUCA' && w === 0 ? 3 : 0),
        'Nutrition Adherence /10': 8,
        Fuelling: 'On plan',
        'Social Event Upcoming': w === 0 && a.code === 'TOM' ? 'Wedding Saturday' : '',
        Stress: 4,
        Motivation: 8,
        'Upcoming Impact': '',
        Testimonial: '',
        _athleteCode: a.code,
        _weekKey: ending,
        _source: 'portal_supabase',
        _submittedAt: stamp(w * 7),
        _updatedAt: stamp(w * 7),
      });
    }
  });
  return rows;
}

// ── athlete_goals → mapGoal ──────────────────────────────────────────────────
// ANNA is deliberately absent: the athlete owns their goal race in the portal,
// so the dashboard has to render a coach-appropriate empty state rather than an
// invitation to set something the coach cannot set.
export function goals() {
  const races = {
    KAI: { race: 'Adelaide Marathon',   inDays: 42 },
    SARAH: { race: 'Barossa Half',        inDays: 21 },
    JAMES: { race: 'Melbourne Marathon',  inDays: 77 },
    LUCA:  { race: 'City-Bay 12km',       inDays: 119 },
    TOM:   { race: 'Gold Coast Marathon', inDays: 4 },   // race week
  };
  return Object.entries(races).map(([code, r]) => {
    const a = ATHLETES.find(x => x.code === code);
    return {
      athlete_code: code,
      athlete_name: a.name,
      goal_race: r.race,
      race_date: iso(-r.inDays),
      peak_week: iso(-r.inDays + 21),
      start_weight: 78,
      target_weight: 73,
      body_fat: null,
      time_5k: '19:42',
      time_10k: '41:10',
      time_half: '1:31:05',
      time_marathon: code === 'TOM' ? '3:12:40' : null,
      long_run_pace: '5:10',
      why: '',
      milestone_w4: '', milestone_w8: '', milestone_w12: '',
      _source: 'portal_supabase',
      _submittedAt: stamp(30),
      _updatedAt: stamp(30),
    };
  });
}

// ── planned_sessions (raw rows, as coach-data returns them) ──────────────────
// Deliberate cases:
//   - TOM's Wednesday carries status 'Completed' with no athlete log anywhere.
//     planSessionState() must show that as coach-marked, not as athlete truth.
//   - ANNA's Tuesday is ticked but never submitted.
//   - Future sessions later this week must not count against adherence.
let seq = 0;
const psid = () => `ps-${String(++seq).padStart(4, '0')}`;

const PLAN_SPEC = [
  // KAI — marathon build
  ['KAI', -7, 'Easy 10km',            'Run',      'Completed'],
  ['KAI', -5, 'Threshold 5×1km',      'Run',      'Completed'],
  ['KAI', -3, 'Long run 26km',        'Run',      'Completed'],
  ['KAI', -1, 'Threshold 5×1km',      'Run',      'Planned'],
  ['KAI',  0, 'Easy 8km',             'Run',      'Planned'],
  ['KAI',  2, 'Long run 28km',        'Run',      'Planned'],
  ['KAI', -6, 'Lower A',              'Strength', 'Completed'],
  ['KAI',  1, 'Upper B',              'Strength', 'Planned'],
  // SARAH — hybrid
  ['SARAH', -6, 'Easy 8km',             'Run',      'Completed'],
  ['SARAH', -4, 'Upper B',              'Strength', 'Completed'],
  ['SARAH', -2, 'Threshold 4×1km',      'Run',      'Completed'],
  ['SARAH', -1, 'Lower A',              'Strength', 'Completed'],
  ['SARAH',  1, 'Easy 6km',             'Run',      'Planned'],
  ['SARAH',  3, 'Long run 18km',        'Run',      'Planned'],
  // JAMES — long run with auto-lapped file
  ['JAMES', -5, 'Easy 9km',             'Run',      'Completed'],
  ['JAMES', -3, 'Long run 26km',        'Run',      'Completed'],
  ['JAMES', -1, 'Easy 8km',             'Run',      'Planned'],
  ['JAMES',  2, 'Threshold 6×1km',      'Run',      'Planned'],
  // ANNA — ticked, not submitted
  ['ANNA',  -4, 'Easy 5km',             'Run',      'Planned'],
  ['ANNA',  -2, 'Full Body A',          'Strength', 'Planned'],
  ['ANNA',   1, 'Easy 6km',             'Run',      'Planned'],
  // LUCA — strength only, load jump
  ['LUCA',  -6, 'Lower A',              'Strength', 'Completed'],
  ['LUCA',  -4, 'Upper A',              'Strength', 'Completed'],
  ['LUCA',  -2, 'Lower B',              'Strength', 'Completed'],
  ['LUCA',   0, 'Upper B',              'Strength', 'Planned'],
  ['LUCA',   2, 'Lower A',              'Strength', 'Planned'],
  // TOM — race week, coach-marked session with no athlete data
  ['TOM',   -5, 'Easy 8km',             'Run',      'Completed'],
  ['TOM',   -3, 'Race pace 3×2km',      'Run',      'Completed'],
  ['TOM',   -2, 'Easy 6km',             'Run',      'Missed'],
  ['TOM',    0, 'Shakeout 4km',         'Run',      'Planned'],
  ['TOM',    2, 'Gold Coast Marathon',  'Run',      'Planned'],
];

// The dashboard computes an athlete's programme week from their start date, and
// _plannedKmForWeek() then matches planned rows by week_label TEXT. A fixture
// that stamps one label on every row silently reads as "nothing prescribed" for
// any athlete whose computed week differs, so labels are derived here the same
// way the dashboard derives them.
function weekLabelFor(code, dateStr) {
  const a = ATHLETES.find(x => x.code === code);
  const start = new Date(iso(a.startDays));
  const when = new Date(dateStr);
  const days = Math.floor((when - start) / DAY);
  return `Week ${Math.max(0, Math.floor(days / 7))}`;
}

// JAMES's whole current week is labelled "Deload" rather than "Week N". Coaches
// type these labels by hand, so a non-numeric one is ordinary, and it is exactly
// the case that used to render "No volume prescribed this week" while four
// sessions sat on that week's calendar: _plannedKmForWeek matched on the label
// alone. With the date fallback in place his volume resolves and the card says
// it was matched by date. A word rather than a wrong number on purpose: a stray
// "Week 99" would also invent a 99-week programme in the volume strip.
const DRIFTED_LABEL = { code: 'JAMES', label: 'Deload' };

const PLAN = PLAN_SPEC.map(([code, offset, title, type, status]) => {
  const id = psid();
  const plannedDate = wk(offset + 3);
  return {
    id,
    notion_page_id: id,
    athlete_code: code,
    title,
    session_type: type,
    planned_date: plannedDate, // offsets are relative to midweek
    week_label: code === DRIFTED_LABEL.code && weekLabelFor(code, plannedDate) === weekLabelFor(code, wk(3))
      ? DRIFTED_LABEL.label
      : weekLabelFor(code, plannedDate),
    status,
    library_id: null,
    run_details: null,
    intensity: /Threshold|Race pace/.test(title) ? 'Threshold' : 'Easy',
    distance_km: (title.match(/(\d+)km/) || [])[1] ? Number(title.match(/(\d+)km/)[1]) : null,
    target_pace: /Threshold/.test(title) ? '4:05' : /Long run/.test(title) ? '5:20' : '5:45',
    warm_up: /Threshold|Race pace/.test(title) ? '2km easy' : null,
    intervals: /Threshold 5×1km/.test(title) ? '5 × 1km @ 4:05, 90s float' : null,
    working_pace: /Threshold/.test(title) ? '4:05' : null,
    rest: /Threshold/.test(title) ? '90s' : null,
    cool_down: /Threshold|Race pace/.test(title) ? '2km easy' : null,
    notes: '',
    created_at: stamp(20),
    updated_at: stamp(2),
    programme_week_id: null,
    publish_state: 'published',
    prescription_mode: type === 'Run' ? 'structured' : 'exercises',
    part_of_day: 'AM',
    day_order: 1,
    locked_at: null,
    estimated_minutes: 60,
    coach_notes: '',
  };
});

export const planning = () => PLAN.map(r => ({ ...r }));

const planIdFor = (code, titleMatch) =>
  (PLAN.find(p => p.athlete_code === code && titleMatch.test(p.title)) || {}).id;

// ── athlete_data (ticked / logs / ex_picks) ──────────────────────────────────
// This is where Rule 1 lives. `ticked` means the athlete tapped the box.
// `logs` means they sent data. ANNA appears in ticked and not in logs.
export function athleteSettings() {
  const tick = {};
  const logs = {};

  const add = (map, code, id, value) => {
    if (!id) return;
    map[code] = map[code] || {};
    map[code][id] = value;
  };

  PLAN.filter(p => p.status === 'Completed' && p.athlete_code !== 'TOM' ||
                   (p.athlete_code === 'TOM' && /Easy 8km|Race pace/.test(p.title)))
      .forEach(p => {
        add(tick, p.athlete_code, p.id, true);
        add(logs, p.athlete_code, p.id,
          p.session_type === 'Run'
            ? { distance: p.distance_km || 8, pace: '4:58', rpe: 6 }
            : {
                // SARAH's bench is deliberately parked at 70kg across the block:
                // a formal overload recommendation must not be produced for it.
                'Back Squat': [
                  { weight: 110, reps: 8, rpe: 8, done: true },
                  { weight: 110, reps: 8, rpe: 8, done: true },
                  { weight: 110, reps: 7, rpe: 9, done: true },
                ],
                'Barbell Bench Press': [
                  { weight: 70, reps: 9, rpe: 8, done: true },
                  { weight: 70, reps: 9, rpe: 8, done: true },
                  { weight: 70, reps: 8, rpe: 9, done: true },
                ],
                // No rep range on the prescription and no load logged: the
                // engine has nothing to recommend from and must say so.
                'Farmers Carry': [
                  { weight: null, reps: null, rpe: 7, done: true },
                ],
                __submittedAt: stamp(1),
              });
      });

  // ANNA: ticked both sessions, submitted neither. The tick blob has the id,
  // the logs blob does not, so isSessionTicked is true and isSessionSubmitted
  // is false — "Completed, no data".
  add(tick, 'ANNA', planIdFor('ANNA', /Easy 5km/), true);
  add(tick, 'ANNA', planIdFor('ANNA', /Full Body A/), true);

  // TOM's Wednesday is coach-marked only: no tick, no log. It must not read as
  // athlete-completed anywhere.

  const rows = [];
  Object.entries(tick).forEach(([code, value]) =>
    rows.push({ athlete_code: code, key: 'ticked', value: { ...value, __savedAt: stamp(1) }, updated_at: stamp(1) }));
  Object.entries(logs).forEach(([code, value]) =>
    rows.push({ athlete_code: code, key: 'logs', value: { ...value, __savedAt: stamp(1) }, updated_at: stamp(1) }));
  rows.push({
    athlete_code: 'SARAH', key: 'ex_picks',
    value: { 'Barbell Bench Press': 'Dumbbell Bench Press', __savedAt: stamp(4) },
    updated_at: stamp(4),
  });
  return rows;
}

// ── training_session_logs → mapSession ───────────────────────────────────────
export function sessions() {
  const rows = [];
  const push = (code, date, name, category, exerciseLog, extra = {}) => {
    const a = ATHLETES.find(x => x.code === code);
    rows.push({
      'Athlete Code': code,
      AthleteID: code,
      AthleteName: a.name,
      Name: `${code} — ${name} — ${date}`,
      Session: name,
      'Session Category': category,
      'Exercise Log': exerciseLog,
      Notes: extra.notes || '',
      Date: date,
      'date:Date:start': date,
      'Exercise Name': extra.exerciseName || '',
      'Programmed Exercise': extra.programmed || '',
      'Muscle Group': extra.muscle || '',
      'Is Swap': !!extra.swap,
      'Rep Mode': extra.repMode || '',
      _stravaConfirmed: false,
      _stravaSummary: null,
      _clientWriteId: `${code}:${date}-${category}-${rows.length}`,
      _source: 'portal_supabase',
      _submittedAt: extra.submittedAt || `${date}T09:12:00.000Z`,
      _updatedAt: extra.submittedAt || `${date}T09:12:00.000Z`,
    });
  };

  // Strength history — 8 weeks, so progression and 1RM trends have something
  // real to compute from. SARAH's bench is deliberately flat for 5 sessions:
  // progressive-overload must decline to make a formal recommendation and fall
  // back to an observed trend.
  const strength = {
    SARAH: [
      ['Back Squat',           [100, 102.5, 105, 107.5, 110, 110, 112.5, 115]],
      ['Barbell Bench Press',  [70, 70, 70, 70, 70, 70, 70, 70]],
      ['Romanian Deadlift',    [90, 92.5, 95, 97.5, 100, 102.5, 105, 107.5]],
    ],
    LUCA: [
      ['Back Squat',           [120, 122.5, 125, 127.5, 130, 132.5, 135, 140]],
      ['Weighted Pull Up',     [10, 10, 12.5, 12.5, 15, 15, 17.5, 20]],
      ['Bodyweight Push Up',   [0, 0, 0, 0, 0, 0, 0, 0]],
    ],
    KAI: [
      ['Back Squat',           [80, 82.5, 85, 85, 87.5, 90, 90, 92.5]],
      ['Split Squat',          [20, 20, 22.5, 22.5, 25, 25, 27.5, 27.5]],
    ],
  };

  Object.entries(strength).forEach(([code, lifts]) => {
    for (let s = 7; s >= 0; s--) {
      const date = iso(s * 7 + 1);
      const log = lifts.map(([name, loads]) => {
        const load = loads[7 - s];
        // Bodyweight movements carry no load. Tonnage must not invent one.
        const sets = load
          ? [1, 2, 3].map(n => `Set ${n}: ${load}kg x ${n === 3 ? 7 : 8} @ RPE ${n === 3 ? 9 : 8}`)
          : [1, 2, 3].map(n => `Set ${n}: bodyweight x 12`);
        return `${name}: ${sets.join(' | ')}`;
      }).join('\n');
      push(code, date, s === 0 ? 'Lower A' : 'Lower A', 'Strength', log, {
        submittedAt: `${date}T18:40:00.000Z`,
      });
    }
  });

  // One deliberately unparseable strength line — tonnage must skip it rather
  // than manufacture a number.
  push('LUCA', iso(2), 'Upper A', 'Strength',
    'Back Squat: felt heavy, stopped early\nWeighted Pull Up: Set 1: 20kg x 6 @ RPE 8 | Set 2: 20kg x 5 @ RPE 9', {
      submittedAt: `${iso(2)}T18:40:00.000Z`,
    });

  // Running logs
  const runs = [
    ['KAI', 3, 'Long run 26km',   26.1, '5:18'],
    ['KAI', 5, 'Threshold 5×1km', 12.4, '4:41'],
    ['KAI', 7, 'Easy 10km',       10.2, '5:44'],
    ['SARAH', 2, 'Threshold 4×1km', 10.8, '4:29'],
    ['SARAH', 6, 'Easy 8km',         8.1, '5:52'],
    ['JAMES', 3, 'Long run 26km',   26.4, '5:31'],
    ['JAMES', 5, 'Easy 9km',         9.1, '5:49'],
    ['TOM',   3, 'Race pace 3×2km', 14.2, '4:12'],
    ['TOM',   5, 'Easy 8km',         8.0, '5:38'],
  ];
  runs.forEach(([code, d, name, km, pace]) => {
    const date = iso(d);
    push(code, date, name, 'Run',
      `Distance: ${km}km\nAverage pace: ${pace}/km\nRPE: ${/Threshold|Race pace/.test(name) ? 8 : 4}`, {
        submittedAt: `${date}T06:20:00.000Z`,
        notes: code === 'KAI' && d === 3 ? 'Calf tightened at 20km, eased off.' : '',
      });
  });

  // Elevated easy-run RPE for JAMES — one of the Phase 3 queue signals.
  [9, 11, 13].forEach(d => {
    const date = iso(d);
    push('JAMES', date, 'Easy 8km', 'Run',
      `Distance: 8.1km\nAverage pace: 5:47/km\nRPE: 8`, { submittedAt: `${date}T06:20:00.000Z` });
  });

  return rows;
}

// ── athlete_activity_uploads ─────────────────────────────────────────────────
// KAI's threshold file has clean manual laps that correspond 1:1 with the
// prescribed 5 × 1km. JAMES's long run was auto-lapped every kilometre by his
// watch: 26 laps against a prescription of one continuous effort. Pairing those
// is exactly the dishonesty §12.2 forbids, so the dashboard must fall back to
// session totals and say why.
export function activityUploads() {
  // Field names match server/activity-file.js, which is what run-analysis.js reads.
  const lap = (distanceM, seconds, avgHr) => ({
    distanceM, movingTimeS: seconds, elapsedTimeS: seconds,
    avgSpeedMps: Number((distanceM / seconds).toFixed(4)), avgHr,
  });
  const khangLaps = [
    lap(2000, 690, 138),
    ...[0, 1, 2, 3, 4].map(i => lap(1000, 245 + i * 3, 168 + i * 2)), // mild rep fade
    lap(2000, 700, 142),
  ];

  const jamesLaps = Array.from({ length: 26 }, (_, i) =>
    lap(1000, 331 + Math.round(Math.sin(i / 3) * 9), 148 + Math.round(i / 3)));

  return [
    {
      id: 'up-0001',
      athlete_code: 'KAI',
      athlete_name: 'Kai Tran',
      activity_name: 'Threshold 5×1km',
      sport_type: 'Run',
      activity_date: iso(5),
      start_time: `${iso(5)}T06:02:00.000Z`,
      device_name: 'Garmin Forerunner 265',
      source_format: 'fit',
      summary: { distance_km: 12.4, moving_time_s: 3640, avg_hr: 156, max_hr: 178, elevation_gain_m: 68 },
      laps: khangLaps,
      splits: khangLaps,
      parse_warnings: [],
      athlete_notes: '',
      coach_access_granted_at: stamp(5),
      submitted_at: stamp(5),
    },
    {
      id: 'up-0002',
      athlete_code: 'JAMES',
      athlete_name: 'James Okafor',
      activity_name: 'Long run',
      sport_type: 'Run',
      activity_date: iso(3),
      start_time: `${iso(3)}T05:40:00.000Z`,
      device_name: 'Coros Pace 3',
      source_format: 'fit',
      summary: { distance_km: 26.4, moving_time_s: 8740, avg_hr: 152, max_hr: 171, elevation_gain_m: 210 },
      laps: jamesLaps,
      splits: jamesLaps,
      parse_warnings: ['Auto-lap detected: laps are 1km device splits, not session structure.'],
      athlete_notes: '',
      coach_access_granted_at: stamp(3),
      submitted_at: stamp(3),
    },
    {
      // Manual upload with totals only — no lap array at all.
      id: 'up-0003',
      athlete_code: 'TOM',
      athlete_name: 'Tom Reilly',
      activity_name: 'Race pace 3×2km',
      sport_type: 'Run',
      activity_date: iso(3),
      start_time: `${iso(3)}T06:15:00.000Z`,
      device_name: null,
      source_format: 'gpx',
      summary: { distance_km: 14.2, moving_time_s: 3580, avg_hr: null, max_hr: null },
      laps: [],
      splits: [],
      parse_warnings: ['GPX contained no lap markers; session totals only.'],
      athlete_notes: '',
      coach_access_granted_at: stamp(3),
      submitted_at: stamp(3),
    },
  ];
}

// ── run_steps / session_exercises (/api/athletes?action=prescription) ────────
export function prescription(sessionId) {
  const plan = PLAN.find(p => p.id === sessionId);
  if (!plan) return { ok: true, runSteps: [], exercises: [], session: null };

  if (plan.session_type === 'Run') {
    const m = plan.title.match(/(\d+)×(\d+)km/);
    const steps = [];
    let order = 0;
    steps.push({
      id: `${plan.id}-wu`, planned_session_id: plan.id, parent_step_id: null,
      step_order: order++, step_type: 'warmup', repeat_count: null,
      distance_km: 2, duration_sec: null, intensity_type: 'easy',
      pace_min: '5:40', pace_max: '6:00', hr_zone: 'Z2', rpe: 3,
      effort: 'Easy', instructions: 'Build gradually.', coach_notes: '',
    });
    if (m) {
      const parent = {
        id: `${plan.id}-rep`, planned_session_id: plan.id, parent_step_id: null,
        step_order: order++, step_type: 'repeat', repeat_count: Number(m[1]),
        distance_km: null, duration_sec: null, intensity_type: null,
        pace_min: null, pace_max: null, hr_zone: null, rpe: null,
        effort: null, instructions: '', coach_notes: '',
      };
      steps.push(parent);
      steps.push({
        id: `${plan.id}-work`, planned_session_id: plan.id, parent_step_id: parent.id,
        step_order: 0, step_type: 'interval', repeat_count: null,
        distance_km: Number(m[2]), duration_sec: null, intensity_type: 'threshold',
        pace_min: '4:00', pace_max: '4:10', hr_zone: 'Z4', rpe: 8,
        effort: 'Threshold', instructions: '', coach_notes: '',
      });
      steps.push({
        id: `${plan.id}-rec`, planned_session_id: plan.id, parent_step_id: parent.id,
        step_order: 1, step_type: 'recovery', repeat_count: null,
        distance_km: null, duration_sec: 90, intensity_type: 'recovery',
        pace_min: null, pace_max: null, hr_zone: 'Z1', rpe: 2,
        effort: 'Float', instructions: '', coach_notes: '',
      });
    } else {
      steps.push({
        id: `${plan.id}-main`, planned_session_id: plan.id, parent_step_id: null,
        step_order: order++, step_type: 'run', repeat_count: null,
        distance_km: plan.distance_km, duration_sec: null, intensity_type: 'easy',
        pace_min: '5:10', pace_max: '5:40', hr_zone: 'Z2', rpe: 4,
        effort: 'Steady', instructions: '', coach_notes: '',
      });
    }
    steps.push({
      id: `${plan.id}-cd`, planned_session_id: plan.id, parent_step_id: null,
      step_order: order++, step_type: 'cooldown', repeat_count: null,
      distance_km: 2, duration_sec: null, intensity_type: 'easy',
      pace_min: '5:40', pace_max: '6:10', hr_zone: 'Z1', rpe: 3,
      effort: 'Easy', instructions: '', coach_notes: '',
    });
    return { ok: true, session: plan, runSteps: steps, exercises: [] };
  }

  // Strength. One exercise carries no rep range at all, which is the case where
  // a formal overload recommendation must not be produced.
  const exercises = [
    ['Back Squat', 4, 6, 8, 110, 'double_progression'],
    ['Barbell Bench Press', 3, 8, 10, 70, 'double_progression'],
    ['Romanian Deadlift', 3, 8, 10, 100, 'double_progression'],
    ['Farmers Carry', 3, null, null, null, null],
  ].map(([name, sets, repMin, repMax, load, rule], i) => ({
    id: `${plan.id}-ex${i}`,
    planned_session_id: plan.id,
    exercise_id: null,
    exercise_name: name,
    position: i,
    superset_group: null, circuit_group: null,
    sets, warmup_sets: 1, working_sets: sets,
    rep_min: repMin, rep_max: repMax,
    rep_mode: repMin && repMax ? 'range' : 'fixed',
    target_load: load, load_type: load ? 'kg' : null,
    percent_1rm: null, rpe: 8, rir: 2, tempo: '3010', rest_seconds: 150,
    progression_rule: rule, regression: null,
    alternatives: [], left_right_exercises: null,
    coach_notes: '', athlete_notes: '', technique_cues: '',
    source_split_id: null,
  }));
  return { ok: true, session: plan, runSteps: [], exercises };
}

// ── full /api/coach-data payload ─────────────────────────────────────────────
export function coachData() {
  const b = body(), n = nutrition(), s = sessions(), w = weekly(),
        g = goals(), p = planning(), st = athleteSettings(), au = activityUploads();
  return {
    ok: true,
    source: 'preview_fixture',
    generatedAt: new Date().toISOString(),
    counts: {
      body: b.length, nutrition: n.length, sessions: s.length,
      sessionsStructured: s.length, sessionsReconciled: 0,
      weekly: w.length, goals: g.length, planning: p.length,
      nutritionPlans: 0, athleteSettings: st.length,
      sessionLibrary: 0, workoutSplits: 0, applicationDecisions: 0,
      activityUploads: au.length,
      // Both are zero here on purpose: migration 20260906000001 is not applied
      // in the preview, exactly as it is not applied in production. The preview
      // therefore shows the degraded read path, not an imagined one.
      sessionReviews: 0, signalState: 0,
    },
    integrity: { weeklyConflicts: [], weeklySuppressed: 0, reconciledSessions: 0 },
    body: b,
    nutrition: n,
    sessions: s,
    weekly: w,
    goals: g,
    planning: p,
    nutritionPlans: [],
    athleteSettings: st,
    sessionState: st.filter(r => ['ticked', 'logs', 'ex_picks'].includes(r.key)),
    sessionLibrary: [],
    workoutSplits: [],
    applicationDecisions: [],
    sessionReviews: [],
    signalState: [],
    activityUploads: au,
  };
}

export { ATHLETES, PLAN };
