/**
 * Weekly performance summary — pure metric rules, shared with the athlete portal.
 *
 * THIS FILE IS A VERBATIM COPY of the pure half (everything above the
 * "── DATABASE ──" divider) of dp-athlete-portal/api/_lib/performance-summary.js
 * at portal commit 7d4f3cc, with only the Supabase import removed. The two repos
 * deploy separately, so the rules are copied rather than imported; the parity
 * test (tests/coach-weekly-summary.test.js) pins the hash of the copied block so
 * a portal change that is not mirrored here fails the build instead of letting
 * the athlete card and the coach card silently disagree.
 *
 * The coach side never passes stravaRows (see server/coach-weekly-summary.js):
 * Strava data is shown back to the athlete only.
 */

export const SUMMARY_VERSION = 1;

// Australia/Adelaide is the product's timezone: the portal's `localISO()` and
// every planned_date are local dates, so "today" has to be resolved there too.
export const PRODUCT_TIMEZONE = 'Australia/Adelaide';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── DATES ────────────────────────────────────────────────────────────────────
//
// All date maths is done on the YYYY-MM-DD string through a UTC-noon Date, then
// read back with the UTC getters. Building a local Date from an ISO date and
// reading it back with local getters is the classic way a week silently shifts
// a day for anyone east or west of the server, and Vercel runs in UTC while the
// athlete lives in UTC+9:30.

export function isUuid(value) {
  return UUID_PATTERN.test(String(value || ''));
}

export function isIsoDate(value) {
  return ISO_DATE.test(String(value || ''));
}

export function toIsoDate(value) {
  const candidate = String(value == null ? '' : value).slice(0, 10);
  return ISO_DATE.test(candidate) ? candidate : null;
}

export function addDaysISO(iso, days) {
  const date = toIsoDate(iso);
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  const base = Date.UTC(year, month - 1, day, 12, 0, 0);
  const moved = new Date(base + days * 86_400_000);
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

// A programme week is the start date plus six calendar days, inclusive — the
// same seven-day block the calendar draws.
export function weekRangeFromStart(startDate) {
  const start = toIsoDate(startDate);
  if (!start) return null;
  return { startDate: start, endDate: addDaysISO(start, 6) };
}

export function adelaideToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PRODUCT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function weekState(startDate, endDate, todayISO) {
  if (todayISO < startDate) return 'future';
  if (todayISO > endDate) return 'past';
  return 'current';
}

// Discovery week is week 0 everywhere in the portal, and is stored under both
// spellings ("Week 0" and "Discovery Week") depending on the athlete. The
// number is the authority; the label is display only.
export function programmeWeekLabel(weekNumber, storedLabel) {
  const number = Number(weekNumber);
  if (Number.isFinite(number) && number === 0) return 'Discovery Week';
  if (Number.isFinite(number)) return `Week ${number}`;
  const label = String(storedLabel || '').trim();
  return label || 'Week';
}

// ── SESSION CLASSIFICATION ───────────────────────────────────────────────────
//
// One helper, not regular expressions scattered through the aggregation. This
// follows the browser's getType() (public/js/01-core.js) and then extends it
// with the two sports getType() has never needed to name, because the portal's
// calendar only ever draws run/strength/rest.
//
// KNOWN LIMIT: a planned cycling or swimming session is only recognised when
// the coach types it as one. Nothing in planned_sessions carries a sport
// column, so an untyped endurance session still classifies as running exactly
// as it does in the calendar today. Documented rather than guessed at.

export const SESSION_TYPES = ['running', 'cycling', 'swimming', 'strength', 'other'];
export const ENDURANCE_SPORTS = ['running', 'cycling', 'swimming'];

// public/config.js ships these four; Supabase workout_splits adds the rest at
// runtime, which is why classifySession() takes the extra names as an argument.
export const BASE_GYM_KEYS = ['Upper A', 'Upper B', 'Lower A', 'Lower B'];

const NOTE_TYPES = new Set(['note', 'notes', 'general', 'discovery', 'custom']);

function lower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

export function isRestSession(row) {
  const type = lower(row && row.session_type);
  const name = lower(row && row.title).trim();
  if (type === 'rest' || name === 'rest') return true;
  // The calendar treats these placeholder titles as "nothing was programmed".
  return /^(free|free day|rest|rest day|open|open day|recovery day)$/.test(name);
}

/**
 * @param {object} row planned_sessions row
 * @param {object} [context] { gymKeys, structured } — structured is a Map of
 *   planned_session_id -> { exercises: n, runSteps: n } for coach-built sessions.
 */
export function classifySession(row, context = {}) {
  const type = lower(row && row.session_type);
  const title = lower(row && row.title);
  const haystack = `${type} ${title}`;

  if (/\bswim|swimming\b/.test(haystack)) return 'swimming';
  if (/\bride\b|\bbike\b|cycl/.test(haystack)) return 'cycling';

  if (NOTE_TYPES.has(type)) return 'other';

  // A coach-built session carries its own exercise list, so it no longer has to
  // be named after one of the legacy splits. Sessions that also carry run steps
  // stay run-led, exactly as getType() decides it.
  const structured = context.structured && context.structured.get(row && row.id);
  if (structured && structured.exercises > 0 && !(structured.runSteps > 0)) return 'strength';

  if (type === 'strength' || type === 'gym') return 'strength';
  const gymKeys = Array.isArray(context.gymKeys) && context.gymKeys.length
    ? context.gymKeys
    : BASE_GYM_KEYS;
  if (gymKeys.some((key) => key && title.includes(lower(key)))) return 'strength';

  return 'running';
}

// The browser keys every session by `notion_page_id || id` — logs, drafts and
// reschedules all hang off that key (loadPlannedSessions in js/01-core.js), and
// session_logs.session_key stores exactly that. Completion must be keyed
// identically or nothing lines up.
export function sessionKeyFor(row) {
  return (row && (row.notion_page_id || row.id)) || null;
}

// ── DISTANCE ─────────────────────────────────────────────────────────────────
//
// Parity port of safeKm / titleKmFromName / plannedKmFromRow from
// public/js/05-handbook.js. tests/performance-summary-parity.test.js runs the
// browser's own copies against these, so a change there fails here.

export function safeKm(raw) {
  const str = String(raw == null ? '' : raw).replace(',', '.').trim();
  if (!str || /min|hour|hr\b|sec/i.test(str)) return 0;
  const match = str.match(/(\d+(?:\.\d+)?)/);
  const value = match ? parseFloat(match[1]) : 0;
  return (Number.isNaN(value) || value <= 0 || value > 200) ? 0 : value;
}

// Distance written into a session title, e.g. "Easy Run — 12km". Interval names
// like "5x1km Threshold" or "3km pace" are NOT weekly distance, so the digit
// immediately after an x/× is skipped and pace/rep suffixes are excluded.
export function titleKmFromName(name) {
  const match = String(name == null ? '' : name)
    .match(/(?:^|[^0-9xX×])(\d+(?:\.\d+)?)\s*km\b(?!\s*(?:pace|reps?|repeats?))/i);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Planned km for one planned_sessions row, in the portal's own order of trust:
 * the explicit typed distance, then the library entry it points at, then the
 * title. Returns the figure AND where it came from, so the response can say how
 * solid the number is instead of presenting a title guess as a prescription.
 */
export function plannedKmFromRow(row, library = null) {
  const explicit = safeKm(row && row.distance_km);
  if (explicit) return { km: explicit, source: 'typed' };
  const entry = library && row && row.library_id ? library[row.library_id] : null;
  const fromLibrary = safeKm(entry && entry.distance);
  if (fromLibrary) return { km: fromLibrary, source: 'library' };
  const fromTitle = titleKmFromName(row && row.title);
  if (fromTitle) return { km: fromTitle, source: 'title' };
  return { km: 0, source: 'none' };
}

// ── STRAVA MAPPING ───────────────────────────────────────────────────────────
//
// Parity port of sportForStravaActivity (public/js/05-handbook.js), reading the
// cache's column name as well as the API's.
export function sportForStravaActivity(activity) {
  const type = lower((activity && (activity.sport_type || activity.type)) || '');
  if (type.includes('swim')) return 'swimming';
  if (type.includes('ride') || type.includes('cycl') || type.includes('bike')) return 'cycling';
  if (type.includes('run')) return 'running';
  return null;
}

/**
 * The sport of a portal training log. Unlike a Strava sport_type, a log's name
 * is free text, so substrings lie: "Easy 6km + Strides" contains "ride". The
 * category the athlete logged under decides first; the name is only read for
 * whole words, and an endurance log that names no sport is a run, as before.
 */
export function sportForLogRow(row) {
  const category = lower(row && row.session_category);
  if (category === 'strength') return null;
  const fromCategory = category ? sportForStravaActivity({ sport_type: category }) : null;
  if (fromCategory) return fromCategory;
  const name = lower(row && row.session_name);
  if (/\bswim/.test(name)) return 'swimming';
  if (/\b(ride|rides|riding|cycl\w*|bike|biking)\b/.test(name)) return 'cycling';
  if (/\b(run|running|jog)/.test(name)) return 'running';
  return category ? 'running' : null;
}

function isStravaConfirmedLog(row) {
  return /^strava_/.test(String((row && row.client_write_id) || ''));
}

/**
 * One endurance session per day, sport and session name. Athletes regularly
 * confirm a run from Strava and also type it in by hand, which wrote two rows
 * for one run. The Strava-confirmed row is kept because it was measured; then a
 * row with a distance; then the first. Unnamed rows are never merged, and two
 * differently named sessions on one day (a double day) stay two.
 */
export function dedupeEnduranceLogs(rows) {
  const kept = [];
  const byKey = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const name = lower(row && row.session_name).replace(/\s+/g, ' ').trim();
    const sport = sportForLogRow(row);
    if (!name || !sport) { kept.push(row); return; }
    const key = `${toIsoDate(row.session_date)}|${sport}|${name}`;
    if (!byKey.has(key)) { byKey.set(key, kept.length); kept.push(row); return; }
    const index = byKey.get(key);
    const current = kept[index];
    const rank = (r) => (isStravaConfirmedLog(r) ? 2 : 0) + ((finiteOrNull(r.distance_km) || 0) > 0 ? 1 : 0);
    if (rank(row) > rank(current)) kept[index] = row;
  });
  return kept;
}

// ── NUMBERS ──────────────────────────────────────────────────────────────────

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, places = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  // -0 serialises as -0 and reads as a negative change that never happened.
  return rounded === 0 ? 0 : rounded;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

// ── TRAINING ─────────────────────────────────────────────────────────────────

/**
 * @param {object} input
 *  - plannedRows: published planned_sessions rows for this programme week
 *  - loggedKeys: Set of session_logs.session_key values for this athlete
 *  - todayISO: the Adelaide local date
 *  - classify: (row) => type
 */
export function aggregateTraining({ plannedRows = [], loggedKeys = new Set(), todayISO, classify }) {
  const byType = {};
  SESSION_TYPES.forEach((type) => { byType[type] = { planned: 0, completed: 0 }; });

  const missedSessions = [];
  let planned = 0;
  let completed = 0;

  plannedRows.forEach((row) => {
    if (isRestSession(row)) return;
    const type = classify(row);
    planned += 1;
    byType[type].planned += 1;

    const key = sessionKeyFor(row);
    // An exact session_key match is the authority. A `Completed` status on the
    // planned row is a documented compatibility fallback for sessions marked
    // done before the portal wrote session_logs — nothing else may complete a
    // session, and an unrelated activity on the same date never does.
    const isComplete = (key != null && loggedKeys.has(String(key)))
      || String(row.status || '') === 'Completed';

    if (isComplete) {
      completed += 1;
      byType[type].completed += 1;
      return;
    }

    const date = toIsoDate(row.planned_date);
    // Only a session whose day has fully passed can be missed. Today's session
    // is still in progress, and a future session has not been asked for yet.
    if (date && date < todayISO) {
      missedSessions.push({ id: String(row.id), title: String(row.title || 'Session'), date, type });
    }
  });

  missedSessions.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  return {
    plannedSessions: planned,
    completedSessions: completed,
    // No sessions planned is not 0% adherence and not 100% — there is nothing
    // to be a percentage of.
    completionPercent: planned ? Math.round((completed / planned) * 100) : null,
    byType,
    missedSessions,
  };
}

// ── ENDURANCE ────────────────────────────────────────────────────────────────

export function aggregatePlannedEndurance({ plannedRows = [], classify, library = null }) {
  const planned = {};
  ENDURANCE_SPORTS.forEach((sport) => { planned[sport] = { km: 0, sources: new Set() }; });

  plannedRows.forEach((row) => {
    if (isRestSession(row)) return;
    const type = classify(row);
    if (!planned[type]) return;
    const { km, source } = plannedKmFromRow(row, library);
    if (!km) return;
    planned[type].km += km;
    planned[type].sources.add(source);
  });

  const out = {};
  ENDURANCE_SPORTS.forEach((sport) => {
    const entry = planned[sport];
    // Nothing parsed is not "0 km planned" — it is "no planned distance we can
    // stand behind", which is null.
    const km = entry.km > 0 ? round(entry.km, 1) : null;
    let quality = 'none';
    if (km != null) quality = entry.sources.has('title') && entry.sources.size === 1 ? 'title' : 'typed';
    out[sport] = { plannedDistanceKm: km, plannedDistanceSource: quality };
  });
  return out;
}

/**
 * Actual endurance work, from ONE source per sport. Strava wins when it is
 * available because it measures the work; the athlete's confirmed portal logs
 * are the fallback. The two are never added together — a run logged in both
 * places is one run.
 */
export function aggregateActualEndurance({
  stravaRows = null,
  trainingLogs = [],
  startDate,
  endDate,
}) {
  const out = {};

  const stravaBySport = stravaRows ? {} : null;
  if (stravaRows) {
    ENDURANCE_SPORTS.forEach((sport) => {
      stravaBySport[sport] = { sessions: 0, metres: 0, seconds: 0 };
    });
    stravaRows.forEach((row) => {
      const sport = sportForStravaActivity(row);
      if (!sport || !stravaBySport[sport]) return;
      const date = toIsoDate(row.start_date_local);
      if (!date || date < startDate || date > endDate) return;
      const metres = finiteOrNull(row.distance_m);
      const seconds = finiteOrNull(row.moving_time_s != null ? row.moving_time_s : row.elapsed_time_s);
      stravaBySport[sport].sessions += 1;
      if (metres != null && metres > 0) stravaBySport[sport].metres += metres;
      if (seconds != null && seconds > 0) stravaBySport[sport].seconds += seconds;
    });
  }

  const portalBySport = {};
  ENDURANCE_SPORTS.forEach((sport) => { portalBySport[sport] = { sessions: 0, km: 0, minutes: 0 }; });
  dedupeEnduranceLogs(trainingLogs).forEach((row) => {
    const date = toIsoDate(row.session_date);
    if (!date || date < startDate || date > endDate) return;
    const sport = sportForLogRow(row);
    if (!sport || !portalBySport[sport]) return;
    const km = finiteOrNull(row.distance_km);
    const minutes = finiteOrNull(row.duration_min);
    portalBySport[sport].sessions += 1;
    if (km != null && km > 0) portalBySport[sport].km += km;
    if (minutes != null && minutes > 0) portalBySport[sport].minutes += minutes;
  });

  ENDURANCE_SPORTS.forEach((sport) => {
    const strava = stravaBySport && stravaBySport[sport];
    if (strava && strava.sessions > 0) {
      out[sport] = {
        actualSessions: strava.sessions,
        actualDistanceKm: strava.metres > 0 ? round(strava.metres / 1000, 1) : null,
        actualDurationMinutes: strava.seconds > 0 ? Math.round(strava.seconds / 60) : null,
        actualSource: 'strava',
      };
      return;
    }
    const portal = portalBySport[sport];
    if (portal.sessions > 0) {
      out[sport] = {
        actualSessions: portal.sessions,
        actualDistanceKm: portal.km > 0 ? round(portal.km, 1) : null,
        actualDurationMinutes: portal.minutes > 0 ? Math.round(portal.minutes) : null,
        actualSource: 'portal_logs',
      };
      return;
    }
    // Strava answered and this athlete did nothing in this sport → a verified
    // zero sessions. Distance and duration still stay null: there is no
    // measured distance, and a 0 km would read as a judgement rather than a
    // fact. Strava did not answer at all → the source is unavailable.
    out[sport] = {
      actualSessions: 0,
      actualDistanceKm: null,
      actualDurationMinutes: null,
      actualSource: stravaRows ? 'strava' : 'unavailable',
    };
  });

  return out;
}

export function buildEndurance(plannedBySport, actualBySport) {
  const out = {};
  ENDURANCE_SPORTS.forEach((sport) => {
    out[sport] = { ...plannedBySport[sport], ...actualBySport[sport] };
  });
  return out;
}

// ── STRENGTH ─────────────────────────────────────────────────────────────────
//
// The recorded number on an assisted movement is help supplied by the machine,
// not load lifted, so assisted work is excluded from tonnage and from every PB
// type. Same rule and same expression as _isAssistedExercise in
// public/js/08-training.js.
const ASSISTED_PATTERN = /\bassist(?:ed|ance)?\b/i;

export function isAssistedExercise(name) {
  return ASSISTED_PATTERN.test(String(name || ''));
}

// Parity port of exerciseHistoryKey (public/js/08-training.js): casing and
// whitespace variants of the same lift share one history; genuinely different
// exercises stay independent.
export function exerciseHistoryKey(name) {
  const key = String(name == null ? '' : name).toLowerCase().replace(/\s+/g, ' ').trim();
  if (key === 'dumbbell split squat' || key === 'dumbbell bulgarian split squat') {
    return 'bulgarian split squat';
  }
  return key;
}

function setNumber(value) {
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function setInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Measurable volume for one logged exercise row.
 *
 * bilateral  : weight × reps
 * left_right : weight × (repsLeft + repsRight)
 *
 * A set missing a weight or missing reps is NOT a zero-volume set — it is an
 * unmeasured set, counted in `eligible` and excluded from `measured`, which is
 * what volumeCoverage reports. Bodyweight work legitimately raises the logged
 * set count while leaving measurable volume unchanged.
 */
export function volumeForRow(row) {
  const name = row && (row.exercise_name || row.programmed_exercise);
  const assisted = isAssistedExercise(name);
  const sets = Array.isArray(row && row.raw_sets) ? row.raw_sets : null;

  // Only structured raw_sets are parsed. A historic row without them cannot be
  // calculated reliably, so it is excluded and surfaces through volumeCoverage
  // instead of being guessed at from the exercise_log string.
  if (!sets) return { workingSets: 0, eligible: 0, measured: 0, excluded: 0, volumeKg: 0, parsed: false };

  let workingSets = 0;
  let eligible = 0;
  let measured = 0;
  let volumeKg = 0;

  sets.forEach((set) => {
    if (!set || typeof set !== 'object') return;
    const weight = setNumber(set.weight);
    const reps = setInt(set.reps);
    const left = setInt(set.repsLeft);
    const rightRaw = setInt(set.repsRight);
    const hasWork = (reps != null && reps > 0) || (left != null && left > 0) || (rightRaw != null && rightRaw > 0);
    const hasLoad = weight != null && weight > 0;
    // A working set is one the athlete actually performed: some reps, or a
    // load. An untouched empty row is neither.
    if (!hasWork && !hasLoad) return;
    workingSets += 1;
    if (assisted) return;         // counted as work, never as tonnage
    eligible += 1;
    if (!hasLoad) return;         // bodyweight — real work, no measurable load
    if (left != null || rightRaw != null) {
      const totalReps = (left || 0) + (rightRaw || 0);
      if (totalReps <= 0) return;
      measured += 1;
      volumeKg += weight * totalReps;
      return;
    }
    if (reps == null || reps <= 0) return;
    measured += 1;
    volumeKg += weight * reps;
  });

  return { workingSets, eligible, measured, excluded: eligible - measured, volumeKg, parsed: true };
}

/**
 * A strength SESSION is a training day, not a row. The portal writes one
 * training_session_logs row per exercise, so counting rows would report nine
 * completed sessions for one gym visit.
 */
export function aggregateStrength({
  trainingLogs = [],
  startDate,
  endDate,
  plannedStrength = 0,
  completedPlannedStrength = 0,
}) {
  const exercises = new Set();
  let workingSets = 0;
  let eligibleSets = 0;
  let measuredSets = 0;
  let volumeKg = 0;
  let sawUnparsedRow = false;

  trainingLogs.forEach((row) => {
    const date = toIsoDate(row.session_date);
    if (!date || date < startDate || date > endDate) return;
    if (!isStrengthLogRow(row)) return;
    const name = row.exercise_name || row.programmed_exercise;
    if (name) exercises.add(exerciseHistoryKey(name));
    const volume = volumeForRow(row);
    if (!volume.parsed) { sawUnparsedRow = true; return; }
    workingSets += volume.workingSets;
    eligibleSets += volume.eligible;
    measuredSets += volume.measured;
    volumeKg += volume.volumeKg;
  });

  return {
    plannedSessions: plannedStrength,
    completedSessions: completedPlannedStrength,
    exercisesLogged: exercises.size,
    workingSets,
    measurableVolumeKg: measuredSets > 0 ? round(volumeKg, 0) : (eligibleSets > 0 ? 0 : null),
    volumeCoverage: {
      eligibleSets,
      measuredSets,
      excludedSets: eligibleSets - measuredSets,
      unparsedRows: sawUnparsedRow,
    },
  };
}

export function isStrengthLogRow(row) {
  const category = lower(row && row.session_category);
  if (category === 'strength') return true;
  // Older rows predate session_category; structured sets are the giveaway.
  return !category && Array.isArray(row && row.raw_sets);
}

// ── PERSONAL BESTS ───────────────────────────────────────────────────────────
//
// Parity port of the portal's own rules (public/js/09-logging.js):
//   1 Load PB  — a single set heavier than the stored best load, at any reps
//   2 Rep PB   — more reps at the same or greater weight than the stored record
//   3 e1RM PB  — Brzycki w*36/(37-r), valid for 1–10 reps only
//   4 Volume   — session total Σ w*r, sets over PB_REP_CAP excluded
// Guards: load/rep/volume cap at PB_REP_CAP reps; e1RM caps at 10; a set below
// 60% of the stored load PB never flags (the portal captures no RPE, so the
// "no RPE" branch of that guard always applies); a first-ever entry seeds
// history silently; assisted movements are excluded entirely.
//
// tests/performance-summary-parity.test.js runs the browser's own
// detectExercisePBs against this one, so the two cannot drift apart.

export const PB_REP_CAP = 12;

export function pbRound1(value) {
  return Math.round(value * 10) / 10;
}

export function pbE1rm(weight, reps) {
  if (reps < 1 || reps > 10) return null;
  return weight * 36 / (37 - reps);
}

// The browser's pbCleanSets keys on `reps` alone, so a purely unilateral set
// (repsLeft/repsRight and no reps) drops out and never produces a PB. That
// behaviour is deliberate here too: a per-side rep count is not comparable to a
// bilateral one, and inventing a comparison would invent PBs.
export function pbCleanSets(sets) {
  return (Array.isArray(sets) ? sets : [])
    .map((set, index) => ({
      set: index + 1,
      weight: setNumber(set && set.weight),
      reps: parseInt(set && set.reps, 10),
      rpe: setNumber(set && set.rpe),
    }))
    .filter((set) => set.weight != null && set.weight > 0 && !Number.isNaN(set.reps) && set.reps > 0);
}

export function pbFold(stored, sets) {
  const clean = pbCleanSets(sets);
  if (!clean.length) return;
  clean.forEach((set) => {
    if (stored.load == null || set.weight > setNumber(stored.load.weight)) {
      stored.load = { weight: set.weight, reps: set.reps };
    }
    if (stored.reps == null || set.reps > stored.reps.reps) {
      stored.reps = { weight: set.weight, reps: set.reps };
    }
    const e1rm = pbE1rm(set.weight, set.reps);
    if (e1rm != null && (stored.e1rm == null || e1rm > stored.e1rm.value)) {
      stored.e1rm = { value: pbRound1(e1rm) };
    }
  });
  const volume = clean.reduce((total, set) => total + (set.reps <= PB_REP_CAP ? set.weight * set.reps : 0), 0);
  if (stored.volume == null || volume > stored.volume.value) stored.volume = { value: pbRound1(volume) };
}

export function detectExercisePBs(exerciseName, sets, stored) {
  if (isAssistedExercise(exerciseName)) return [];
  const history = stored || { load: null, reps: null, e1rm: null, volume: null };
  const clean = pbCleanSets(sets);
  const hits = [];
  if (!clean.length) return hits;
  const firstEver = history.load == null && history.reps == null
    && history.e1rm == null && history.volume == null;
  if (firstEver) return hits;

  const loadW = history.load ? setNumber(history.load.weight) : null;
  const minLoad = loadW != null ? loadW * 0.6 : 0;

  if (loadW != null) {
    let best = null;
    clean.forEach((set) => {
      if (set.weight < minLoad && set.rpe == null) return;
      if (set.weight > loadW && (!best || set.weight > best.weight)) best = set;
    });
    if (best) {
      hits.push({
        type: 'load', exercise: exerciseName, value: best.weight, unit: 'kg',
        previous: loadW, delta: pbRound1(best.weight - loadW),
      });
    }
  }

  if (history.reps) {
    const recordWeight = setNumber(history.reps.weight);
    const recordReps = history.reps.reps;
    let best = null;
    clean.forEach((set) => {
      if (set.reps > PB_REP_CAP) return;
      if (loadW != null && set.weight < minLoad && set.rpe == null) return;
      if (set.weight >= recordWeight && set.reps > recordReps && (!best || set.reps > best.reps)) best = set;
    });
    if (best) {
      hits.push({
        type: 'reps', exercise: exerciseName, value: best.reps, unit: 'reps',
        previous: recordReps, delta: best.reps - recordReps,
      });
    }
  }

  if (history.e1rm) {
    let bestValue = null;
    clean.forEach((set) => {
      if (set.reps > 10) return;
      if (loadW != null && set.weight < minLoad && set.rpe == null) return;
      const e1rm = pbE1rm(set.weight, set.reps);
      if (e1rm != null && e1rm > history.e1rm.value && (bestValue == null || e1rm > bestValue)) bestValue = e1rm;
    });
    if (bestValue != null) {
      hits.push({
        type: 'e1rm', exercise: exerciseName, value: pbRound1(bestValue), unit: 'kg e1RM',
        previous: history.e1rm.value, delta: pbRound1(bestValue - history.e1rm.value),
      });
    }
  }

  if (history.volume) {
    const volume = clean.reduce((total, set) => total + (set.reps <= PB_REP_CAP ? set.weight * set.reps : 0), 0);
    if (volume > history.volume.value) {
      hits.push({
        type: 'volume', exercise: exerciseName, value: pbRound1(volume), unit: 'kg',
        previous: history.volume.value, delta: pbRound1(volume - history.volume.value),
      });
    }
  }

  return hits;
}

/**
 * Walk the athlete's strength history in date order up to the end of the
 * requested week, folding each session into the stored records and flagging the
 * ones set inside the week.
 *
 * DELIBERATE DIVERGENCE from the browser: pbComputeStored() folds every OTHER
 * session including later ones, so a back-filled session is compared against
 * work done after it. This walks strictly forward in time, which is what "a PB
 * this week" has to mean. Documented in docs/weekly-performance-summary.md.
 */
export function detectPersonalBests({ historyRows = [], startDate, endDate }) {
  const sessions = new Map();
  historyRows.forEach((row) => {
    const date = toIsoDate(row.session_date);
    if (!date || date > endDate) return;
    if (!isStrengthLogRow(row)) return;
    const name = row.exercise_name || row.programmed_exercise;
    if (!name || !Array.isArray(row.raw_sets)) return;
    // One gym visit = one session. Rows arrive one per exercise.
    const sessionId = `${date}|${String(row.session_name || '')}`;
    if (!sessions.has(sessionId)) sessions.set(sessionId, { date, exercises: [] });
    sessions.get(sessionId).exercises.push({ name, sets: row.raw_sets });
  });

  const ordered = [...sessions.entries()]
    .sort((a, b) => a[1].date.localeCompare(b[1].date) || a[0].localeCompare(b[0]))
    .map(([, value]) => value);

  const stored = new Map();
  const hits = [];

  ordered.forEach((session) => {
    const inWeek = session.date >= startDate && session.date <= endDate;
    session.exercises.forEach(({ name, sets }) => {
      const key = exerciseHistoryKey(name);
      const record = stored.get(key) || { load: null, reps: null, e1rm: null, volume: null };
      if (inWeek) {
        detectExercisePBs(name, sets, record).forEach((hit) => {
          hits.push({ ...hit, date: session.date });
        });
      }
      pbFold(record, sets);
      stored.set(key, record);
    });
  });

  const rank = { load: 0, e1rm: 1, reps: 2, volume: 3 };
  hits.sort((a, b) => a.date.localeCompare(b.date)
    || a.exercise.localeCompare(b.exercise)
    || (rank[a.type] - rank[b.type]));
  return hits;
}

// ── READINESS ────────────────────────────────────────────────────────────────
//
// Parity port of calculateDailyReadiness (public/js/08-training.js). A missing
// component is omitted from that day's average, never treated as zero.

export function dailyReadiness(log) {
  if (!log) return null;
  const values = [];
  const sleep = setNumber(log.sleep);
  const energy = setNumber(log.energy);
  const soreness = setNumber(log.soreness);
  const stress = setNumber(log.stress);
  if (sleep != null) values.push(sleep * 10);
  if (energy != null) values.push(energy * 10);
  if (soreness != null) values.push((11 - soreness) * 10);
  if (stress != null) values.push((11 - stress) * 10);
  return values.length ? Math.round(mean(values)) : null;
}

export function aggregateReadiness({ weekLogs = [], previousWeekLogs = null }) {
  const scores = weekLogs.map(dailyReadiness).filter((score) => score != null);
  const component = (field) => {
    const values = weekLogs.map((log) => setNumber(log && log[field])).filter((value) => value != null);
    return values.length ? round(mean(values), 1) : null;
  };

  const average = scores.length ? Math.round(mean(scores)) : null;
  let previousAverage = null;
  if (Array.isArray(previousWeekLogs)) {
    const previousScores = previousWeekLogs.map(dailyReadiness).filter((score) => score != null);
    previousAverage = previousScores.length ? Math.round(mean(previousScores)) : null;
  }

  return {
    daysLogged: scores.length,
    average,
    previousWeekAverage: previousAverage,
    changeFromPreviousWeek: average != null && previousAverage != null ? average - previousAverage : null,
    sleepAverage: component('sleep'),
    energyAverage: component('energy'),
    sorenessAverage: component('soreness'),
    stressAverage: component('stress'),
  };
}

// ── BODYWEIGHT ───────────────────────────────────────────────────────────────

export function aggregateBodyweight(weekLogs = []) {
  const entries = weekLogs
    .map((log) => ({ date: toIsoDate(log && log.log_date), weight: setNumber(log && log.weight) }))
    .filter((entry) => entry.date && entry.weight != null && entry.weight > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!entries.length) {
    return { entries: 0, firstKg: null, lastKg: null, changeKg: null, firstDate: null, lastDate: null };
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    entries: entries.length,
    firstKg: round(first.weight, 1),
    lastKg: round(last.weight, 1),
    // One weigh-in is a reading, not a movement.
    changeKg: entries.length >= 2 ? round(last.weight - first.weight, 1) : null,
    firstDate: first.date,
    lastDate: last.date,
  };
}

// ── CHECK-IN ─────────────────────────────────────────────────────────────────
//
// Matched on the server-held week_ending date, never on a client-supplied week
// label. Free-text answers are read for nothing and returned for nothing.

export function aggregateCheckIn({ rows = [], startDate, endDate }) {
  const match = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ ending: toIsoDate(row.week_ending), submittedAt: row.submitted_at || null }))
    .filter((row) => row.ending && row.ending >= startDate && row.ending <= endDate)
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0];

  return {
    submitted: !!match,
    submittedAt: match ? (match.submittedAt || null) : null,
    weekEnding: endDate,
  };
}

// ── ATTENTION ────────────────────────────────────────────────────────────────
//
// Deterministic facts, reusing the portal's OWN thresholds — no new clinical
// numbers are invented here. Sources:
//   pain >= 5, soreness >= 8, energy <= 3, stress >= 8  (getHomeInsights,
//     public/js/08-training.js)
//   readiness < 40                                       (public/js/08-training-focus.js)
// The copy states what was recorded. It never diagnoses and never tells an
// athlete to train through anything.

export const THRESHOLDS = {
  pain: 5,
  soreness: 8,
  energy: 3,
  stress: 8,
  readiness: 40,
};

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

function painFromLog(log) {
  const direct = setNumber(log && log.pain);
  if (direct != null) return { value: direct, location: (log && log.painLocation) || null };
  const raw = log && log.raw_payload;
  if (raw && typeof raw === 'object') {
    const value = setNumber(raw.pain);
    if (value != null) return { value, location: raw.painLocation || null };
  }
  return null;
}

export function buildAttention({ training, readiness, checkIn, weekLogs = [], weekState: state }) {
  const items = [];

  const missed = training.missedSessions.length;
  if (missed > 0) {
    items.push({
      code: 'sessions_not_logged',
      severity: missed >= 3 ? 'high' : 'medium',
      message: `${missed} past planned session${missed === 1 ? ' has' : 's have'} not been logged.`,
      value: missed,
    });
  }

  const painDays = weekLogs.map(painFromLog).filter((entry) => entry && entry.value >= THRESHOLDS.pain);
  if (painDays.length) {
    const locations = [...new Set(painDays.map((entry) => String(entry.location || '').trim()).filter(Boolean))];
    const where = locations.length === 1 ? `${locations[0]} pain` : 'Pain';
    items.push({
      code: 'pain_reported',
      severity: 'high',
      message: `${where} was recorded on ${painDays.length} day${painDays.length === 1 ? '' : 's'}.`,
      value: painDays.length,
    });
  }

  if (readiness.average != null && readiness.average < THRESHOLDS.readiness) {
    items.push({
      code: 'low_readiness',
      severity: 'medium',
      message: `Average readiness was ${readiness.average} this week.`,
      value: readiness.average,
    });
  }
  if (readiness.stressAverage != null && readiness.stressAverage >= THRESHOLDS.stress) {
    items.push({
      code: 'high_stress',
      severity: 'medium',
      message: `Average stress was ${readiness.stressAverage} this week.`,
      value: readiness.stressAverage,
    });
  }
  if (readiness.sorenessAverage != null && readiness.sorenessAverage >= THRESHOLDS.soreness) {
    items.push({
      code: 'high_soreness',
      severity: 'medium',
      message: `Average soreness was ${readiness.sorenessAverage} this week.`,
      value: readiness.sorenessAverage,
    });
  }
  if (readiness.energyAverage != null && readiness.energyAverage <= THRESHOLDS.energy) {
    items.push({
      code: 'low_energy',
      severity: 'medium',
      message: `Average energy was ${readiness.energyAverage} this week.`,
      value: readiness.energyAverage,
    });
  }

  // A check-in is only missing once the week it covers has finished.
  if (state === 'past' && checkIn && !checkIn.submitted) {
    items.push({
      code: 'checkin_missing',
      severity: 'low',
      message: 'The weekly check-in for this week was not submitted.',
      value: null,
    });
  }

  const seen = new Set();
  return items
    .filter((item) => (seen.has(item.code) ? false : seen.add(item.code)))
    .sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || a.code.localeCompare(b.code));
}

// ── RESPONSE HYGIENE ─────────────────────────────────────────────────────────

/**
 * Last line of defence at the response boundary. NaN, Infinity and undefined
 * all serialise into JSON as something the client cannot reason about (`null`,
 * or a dropped key), so they are converted to an explicit null here and the
 * fact is loud in the logs rather than silent in the UI.
 */
export function sanitise(value, path = 'summary', warnings = []) {
  if (value === undefined) { warnings.push(path); return null; }
  if (value === null) return null;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    warnings.push(path);
    return null;
  }
  if (Array.isArray(value)) return value.map((item, index) => sanitise(item, `${path}[${index}]`, warnings));
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((key) => { out[key] = sanitise(value[key], `${path}.${key}`, warnings); });
    return out;
  }
  return value;
}

// ── PURE COMPOSER ────────────────────────────────────────────────────────────

/**
 * Build the whole summary from already-fetched rows. No I/O, no clock — the
 * caller supplies `todayISO` and `generatedAt`. This is the seam the monthly
 * report should reuse.
 */
export function buildSummary({
  programmeWeek,
  plannedRows = [],
  loggedKeys = new Set(),
  trainingLogs = [],
  strengthHistory = [],
  bodyLogs = [],
  previousWeekBodyLogs = null,
  checkInRows = [],
  stravaRows = null,
  library = null,
  gymKeys = BASE_GYM_KEYS,
  structured = new Map(),
  todayISO,
  generatedAt,
  missingSources = [],
  warnings = [],
  personalBestsStatus = 'calculated',
}) {
  const { startDate, endDate } = weekRangeFromStart(programmeWeek.startDate);
  const state = weekState(startDate, endDate, todayISO);
  const classify = (row) => classifySession(row, { gymKeys, structured });

  const training = aggregateTraining({ plannedRows, loggedKeys, todayISO, classify });
  const endurance = buildEndurance(
    aggregatePlannedEndurance({ plannedRows, classify, library }),
    aggregateActualEndurance({ stravaRows, trainingLogs, startDate, endDate }),
  );
  const strength = aggregateStrength({
    trainingLogs,
    startDate,
    endDate,
    plannedStrength: training.byType.strength.planned,
    completedPlannedStrength: training.byType.strength.completed,
  });
  const readiness = aggregateReadiness({ weekLogs: bodyLogs, previousWeekLogs: previousWeekBodyLogs });
  const bodyweight = aggregateBodyweight(bodyLogs);
  const checkIn = aggregateCheckIn({ rows: checkInRows, startDate, endDate });

  let personalBests = [];
  if (personalBestsStatus === 'calculated') {
    personalBests = detectPersonalBests({ historyRows: strengthHistory, startDate, endDate });
  }

  const attention = buildAttention({ training, readiness, checkIn, weekLogs: bodyLogs, weekState: state });

  const allWarnings = [...warnings];
  if (strength.volumeCoverage.unparsedRows) {
    allWarnings.push('some historic strength rows have no structured sets and are excluded from volume');
  }
  const coverage = {
    eligibleSets: strength.volumeCoverage.eligibleSets,
    measuredSets: strength.volumeCoverage.measuredSets,
    excludedSets: strength.volumeCoverage.excludedSets,
  };

  const summary = {
    version: SUMMARY_VERSION,
    generatedAt,
    period: {
      type: 'week',
      programmeWeekId: programmeWeek.id,
      weekNumber: Number.isFinite(Number(programmeWeek.weekNumber)) ? Number(programmeWeek.weekNumber) : null,
      label: programmeWeekLabel(programmeWeek.weekNumber, programmeWeek.weekLabel),
      startDate,
      endDate,
      state,
    },
    training,
    endurance,
    strength: {
      plannedSessions: strength.plannedSessions,
      completedSessions: strength.completedSessions,
      exercisesLogged: strength.exercisesLogged,
      workingSets: strength.workingSets,
      measurableVolumeKg: strength.measurableVolumeKg,
      volumeCoverage: coverage,
      personalBestsStatus,
      personalBests,
    },
    readiness,
    bodyweight,
    checkIn,
    attention,
    dataQuality: {
      partial: missingSources.length > 0,
      missingSources: [...missingSources].sort(),
      warnings: allWarnings,
    },
  };

  const nonFinite = [];
  const clean = sanitise(summary, 'summary', nonFinite);
  if (nonFinite.length) {
    console.warn('[performance-summary] non-finite values replaced with null:', nonFinite.join(', '));
    clean.dataQuality.warnings = [...clean.dataQuality.warnings, 'some values could not be calculated'];
  }
  return clean;
}
