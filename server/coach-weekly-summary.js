// Coach-side weekly review: the same week-level summary the athlete sees on the
// portal Progress tab, built with the portal's own metric rules
// (server/performance-summary-core.js) from coach-safe sources only.
//
// PRIVACY BOUNDARY (deliberate, do not loosen)
// strava_activities is never read here. The Strava API Agreement allows an
// athlete's Strava data to be shown back to that athlete only. Endurance
// actuals come from the athlete's confirmed portal logs (training_session_logs)
// and from activity files the athlete uploaded with explicit coach access
// (athlete_activity_uploads.coach_access_granted_at). Because the athlete's card
// may use Strava and this one cannot, every sport carries an actualSource label
// and the UI shows it: the two numbers are not presented as the same thing.
//
// NULL vs ZERO follows the portal: null = unavailable, 0 = verified zero.

import {
  BASE_GYM_KEYS,
  ENDURANCE_SPORTS,
  SUMMARY_VERSION,
  addDaysISO,
  adelaideToday,
  aggregatePlannedEndurance,
  buildEndurance,
  buildSummary,
  classifySession,
  dedupeEnduranceLogs,
  isUuid,
  programmeWeekLabel,
  round,
  sessionKeyFor,
  sportForLogRow,
  sportForStravaActivity,
  toIsoDate,
  weekRangeFromStart,
} from './performance-summary-core.js';

export const COACH_SUMMARY_VERSION = SUMMARY_VERSION;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function lower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function validAthleteCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) throw requestError('A valid athlete code is required', 400);
  return code;
}


/**
 * Actual endurance per sport from the two coach-visible sources, never adding
 * the same session twice: on any day where the athlete uploaded a file for a
 * sport, the upload is the measurement for that sport that day and the portal
 * log for it is not counted again.
 *
 * @param trainingLogs rows, or null when training_session_logs could not be read
 * @param uploads rows, or null when athlete_activity_uploads could not be read
 */
export function aggregateCoachEndurance({ trainingLogs = [], uploads = [], startDate, endDate }) {
  const perSport = {};
  ENDURANCE_SPORTS.forEach(sport => { perSport[sport] = new Map(); });

  const day = (sport, date) => {
    const map = perSport[sport];
    if (!map.has(date)) map.set(date, { uploads: [], logs: [] });
    return map.get(date);
  };

  (Array.isArray(uploads) ? uploads : []).forEach(row => {
    if (!row || !row.coach_access_granted_at) return; // consent is the gate
    const date = toIsoDate(row.activity_date);
    if (!date || date < startDate || date > endDate) return;
    const sport = sportForStravaActivity({ sport_type: row.sport_type });
    if (!sport || !perSport[sport]) return;
    const summary = row.summary && typeof row.summary === 'object' ? row.summary : {};
    day(sport, date).uploads.push({
      km: finite(summary.distanceM) != null ? finite(summary.distanceM) / 1000 : null,
      minutes: finite(summary.movingTimeS ?? summary.elapsedTimeS) != null
        ? finite(summary.movingTimeS ?? summary.elapsedTimeS) / 60 : null,
    });
  });

  // Same rules as the athlete's card: classify by category, never by a
  // substring of the name, and a run logged twice is one run.
  dedupeEnduranceLogs(Array.isArray(trainingLogs) ? trainingLogs : []).forEach(row => {
    const date = toIsoDate(row.session_date);
    if (!date || date < startDate || date > endDate) return;
    const sport = sportForLogRow(row);
    if (!sport || !perSport[sport]) return;
    day(sport, date).logs.push({ km: finite(row.distance_km), minutes: finite(row.duration_min) });
  });

  const out = {};
  ENDURANCE_SPORTS.forEach(sport => {
    let sessions = 0;
    let km = 0;
    let minutes = 0;
    let usedUploads = false;
    let usedLogs = false;
    for (const entry of perSport[sport].values()) {
      const chosen = entry.uploads.length ? entry.uploads : entry.logs;
      if (entry.uploads.length) usedUploads = true; else if (entry.logs.length) usedLogs = true;
      chosen.forEach(item => {
        sessions += 1;
        if (item.km != null && item.km > 0) km += item.km;
        if (item.minutes != null && item.minutes > 0) minutes += item.minutes;
      });
    }
    let actualSource;
    if (usedUploads && usedLogs) actualSource = 'portal_logs+activity_uploads';
    else if (usedUploads) actualSource = 'activity_uploads';
    else if (usedLogs) actualSource = 'portal_logs';
    else actualSource = trainingLogs === null ? 'unavailable' : 'portal_logs';

    out[sport] = {
      // A read failure with nothing from the other source is unavailable, not 0.
      actualSessions: sessions === 0 && trainingLogs === null && uploads === null ? null : sessions,
      actualDistanceKm: km > 0 ? round(km, 1) : null,
      actualDurationMinutes: minutes > 0 ? Math.round(minutes) : null,
      actualSource,
    };
  });
  return out;
}

export const SOURCE_LABELS = {
  portal_logs: 'Confirmed portal logs',
  activity_uploads: 'Uploaded activity files',
  'portal_logs+activity_uploads': 'Portal logs and uploaded files',
  unavailable: 'Unavailable',
};

/**
 * Pure: turn rows into the coach summary. Everything the loader fetched is
 * passed in; nothing here reads the database.
 */
export function buildCoachSummary(input) {
  const {
    programmeWeek, plannedRows = [], trainingLogs = null, uploads = null,
    gymKeys = BASE_GYM_KEYS, structured = new Map(), missingSources = [], warnings = [],
  } = input;
  const summary = buildSummary({
    ...input,
    trainingLogs: Array.isArray(trainingLogs) ? trainingLogs : [],
    stravaRows: null,
  });
  const { startDate, endDate } = weekRangeFromStart(programmeWeek.startDate);
  const classify = row => classifySession(row, { gymKeys, structured });
  summary.endurance = buildEndurance(
    aggregatePlannedEndurance({ plannedRows, classify, library: null }),
    aggregateCoachEndurance({ trainingLogs, uploads, startDate, endDate }),
  );
  Object.values(summary.endurance.bySport || summary.endurance || {}).forEach(entry => {
    if (entry && typeof entry === 'object' && entry.actualSource) {
      entry.actualSourceLabel = SOURCE_LABELS[entry.actualSource] || entry.actualSource;
    }
  });
  summary.audience = 'coach';
  summary.dataQuality = {
    ...summary.dataQuality,
    partial: missingSources.length > 0,
    missingSources: [...missingSources].sort(),
    warnings: [
      ...(summary.dataQuality?.warnings || []),
      ...warnings.filter(w => !(summary.dataQuality?.warnings || []).includes(w)),
    ],
    // Always true on this side, stated so the UI never has to infer it.
    stravaExcluded: true,
  };
  return summary;
}

const TRAINING_LOG_COLUMNS = ['session_name', 'session_category', 'session_date', 'exercise_name', 'programmed_exercise', 'raw_sets', 'distance_km', 'duration_min', 'client_write_id'];
const TRAINING_LOG_OPTIONAL = ['exercise_name', 'programmed_exercise', 'distance_km', 'duration_min', 'client_write_id'];

async function selectTolerant(select, table, query, columns, optional) {
  let current = [...columns];
  for (let attempt = 0; attempt <= optional.length; attempt += 1) {
    try {
      return await select(table, { ...query, select: current.join(',') });
    } catch (error) {
      const message = String(error?.message || '');
      const missing = optional.find(column => current.includes(column) && message.includes(column));
      if (!missing) throw error;
      current = current.filter(column => column !== missing);
    }
  }
  return select(table, { ...query, select: current.join(',') });
}

export function chooseWeek(weeks, programmeWeekId, todayISO) {
  if (programmeWeekId) return weeks.find(week => week.id === programmeWeekId) || null;
  const started = weeks.filter(week => week.startDate && week.startDate <= todayISO);
  return started.length ? started[started.length - 1] : weeks[0] || null;
}

/**
 * Coach entry point. Coach authentication happens in the handler before this
 * runs; the athlete code and week id arrive as query parameters and are
 * validated here. The week must belong to that athlete's programmes.
 */
export async function loadCoachWeeklySummary({ code: rawCode, programmeWeekId: rawWeek = '', select, now = new Date() }) {
  const code = validAthleteCode(rawCode);
  const requestedWeek = String(rawWeek || '').trim();
  if (requestedWeek && !isUuid(requestedWeek)) throw requestError('A valid programme week is required', 400);
  const todayISO = adelaideToday(now);

  const programmes = await select('athlete_programmes', {
    athlete_code: `eq.${code}`, select: 'id', order: 'updated_at.desc', limit: '20',
  });
  const programmeIds = (Array.isArray(programmes) ? programmes : []).map(row => row.id).filter(isUuid);
  if (!programmeIds.length) throw requestError('No programme weeks for that athlete', 404);

  const weekRows = await select('athlete_programme_weeks', {
    programme_id: `in.(${programmeIds.join(',')})`,
    select: 'id,programme_id,week_number,week_label,start_date',
    order: 'start_date.asc',
    limit: '200',
  });
  const weeks = (Array.isArray(weekRows) ? weekRows : [])
    .map(row => ({
      id: row.id,
      weekNumber: finite(row.week_number),
      label: programmeWeekLabel(row.week_number, row.week_label),
      weekLabel: row.week_label,
      startDate: toIsoDate(row.start_date),
    }))
    .filter(week => isUuid(week.id) && week.startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const week = chooseWeek(weeks, requestedWeek, todayISO);
  if (!week) throw requestError('Programme week not found', 404);
  const index = weeks.findIndex(w => w.id === week.id);
  const { startDate, endDate } = weekRangeFromStart(week.startDate);
  const previousStart = addDaysISO(startDate, -7);
  const previousEnd = addDaysISO(startDate, -1);

  const plannedColumns = 'id,notion_page_id,title,planned_date,session_type,status,library_id,distance_km,week_label,prescription_mode';
  let planned = await select('planned_sessions', {
    athlete_code: `eq.${code}`, publish_state: 'eq.published', programme_week_id: `eq.${week.id}`,
    select: plannedColumns, order: 'planned_date.asc', limit: '200',
  });
  planned = Array.isArray(planned) ? planned : [];
  // A week can mix both kinds of row: sessions the programming system linked to
  // this programme week, and sessions scheduled from the Planning tab that
  // carry no programme_week_id. The dated rows were only read when the linked
  // set was empty, so one linked run hid every unlinked lift in the same week.
  // Always read both and merge them, de-duplicated by id.
  const byDate = await select('planned_sessions', {
    athlete_code: `eq.${code}`, publish_state: 'eq.published', programme_week_id: 'is.null',
    and: `(planned_date.gte.${startDate},planned_date.lte.${endDate})`,
    select: plannedColumns, order: 'planned_date.asc', limit: '200',
  }).catch(() => []);
  const seenPlanned = new Set(planned.map(row => String(row.id)));
  (Array.isArray(byDate) ? byDate : []).forEach(row => {
    if (seenPlanned.has(String(row.id))) return;
    seenPlanned.add(String(row.id));
    planned.push(row);
  });
  planned.sort((a, b) => String(a.planned_date || '').localeCompare(String(b.planned_date || '')));

  const missingSources = [];
  const optional = (name, promise) => promise.then(value => value, error => {
    console.warn(`[coach-weekly-summary] ${name} read failed:`, error && error.message);
    missingSources.push(name);
    return null;
  });

  const structuredIds = planned.filter(row => row.prescription_mode === 'structured').map(row => row.id).filter(Boolean);
  const plannedKeys = [...new Set(planned.map(sessionKeyFor).map(key => String(key == null ? '' : key))
    .filter(key => /^[A-Za-z0-9-]+$/.test(key)))];
  // The portal writes session_logs.session_key as `session_<CODE>_<planned id>`
  // (public/js/09-logging.js), never the bare id. Query both spellings and
  // normalise back to the bare id that aggregateTraining matches on.
  const loggedKeyPrefix = `session_${code}_`;
  const sessionLogKeys = plannedKeys.flatMap(key => [key, `${loggedKeyPrefix}${key}`]);
  const bareSessionKey = value => {
    const key = String(value || '');
    return key.startsWith(loggedKeyPrefix) ? key.slice(loggedKeyPrefix.length) : key;
  };

  const [loggedRows, trainingLogRows, strengthHistoryRows, bodyRows, previousBodyRows, checkInRows, uploadRows, splitRows, exerciseRows, runStepRows] = await Promise.all([
    plannedKeys.length
      ? optional('session_logs', select('session_logs', {
        athlete_code: `eq.${code}`, session_key: `in.(${sessionLogKeys.join(',')})`,
        select: 'session_key', limit: String(Math.max(sessionLogKeys.length, 50)),
      }))
      : Promise.resolve([]),
    optional('training_session_logs', selectTolerant(select, 'training_session_logs', {
      athlete_code: `eq.${code}`, and: `(session_date.gte.${startDate},session_date.lte.${endDate})`,
      order: 'session_date.asc', limit: '1000',
    }, TRAINING_LOG_COLUMNS, TRAINING_LOG_OPTIONAL)),
    optional('strength_history', selectTolerant(select, 'training_session_logs', {
      athlete_code: `eq.${code}`, session_date: `lte.${endDate}`, order: 'session_date.asc', limit: '5000',
    }, ['session_name', 'session_category', 'session_date', 'exercise_name', 'programmed_exercise', 'raw_sets'], ['exercise_name', 'programmed_exercise'])),
    optional('daily_body_logs', select('daily_body_logs', {
      athlete_code: `eq.${code}`, and: `(log_date.gte.${startDate},log_date.lte.${endDate})`,
      select: 'log_date,weight,sleep,energy,stress,soreness,raw_payload', order: 'log_date.asc', limit: '31',
    })),
    optional('daily_body_logs_previous', select('daily_body_logs', {
      athlete_code: `eq.${code}`, and: `(log_date.gte.${previousStart},log_date.lte.${previousEnd})`,
      select: 'log_date,sleep,energy,stress,soreness', order: 'log_date.asc', limit: '31',
    })),
    optional('weekly_checkins', select('weekly_checkins', {
      athlete_code: `eq.${code}`, and: `(week_ending.gte.${startDate},week_ending.lte.${endDate})`,
      select: 'week_ending,submitted_at', order: 'submitted_at.desc', limit: '10',
    })),
    // Consented uploads only. Aggregate fields only; streams/laps are not read.
    optional('athlete_activity_uploads', select('athlete_activity_uploads', {
      athlete_code: `eq.${code}`, coach_access_granted_at: 'not.is.null',
      and: `(activity_date.gte.${startDate},activity_date.lte.${endDate})`,
      select: 'sport_type,activity_date,summary,coach_access_granted_at', order: 'activity_date.asc', limit: '100',
    })),
    optional('workout_splits', select('workout_splits', {
      archived: 'eq.false', or: `(athlete_code.is.null,athlete_code.eq.${code})`, select: 'name', limit: '200',
    })),
    structuredIds.length
      ? optional('session_exercises', select('session_exercises', {
        planned_session_id: `in.(${structuredIds.join(',')})`, select: 'planned_session_id', limit: '2000',
      }))
      : Promise.resolve([]),
    structuredIds.length
      ? optional('run_steps', select('run_steps', {
        planned_session_id: `in.(${structuredIds.join(',')})`, select: 'planned_session_id', limit: '2000',
      }))
      : Promise.resolve([]),
  ]);

  const structured = new Map();
  structuredIds.forEach(id => structured.set(id, { exercises: 0, runSteps: 0 }));
  (exerciseRows || []).forEach(row => { const e = structured.get(row.planned_session_id); if (e) e.exercises += 1; });
  (runStepRows || []).forEach(row => { const e = structured.get(row.planned_session_id); if (e) e.runSteps += 1; });

  const gymKeys = BASE_GYM_KEYS.concat((splitRows || []).map(row => String(row.name || ''))
    .filter(name => name && !BASE_GYM_KEYS.includes(name))).sort((a, b) => b.length - a.length);

  const warnings = [];
  if (loggedRows === null) warnings.push('completion is based on planned-session status only');

  const summary = buildCoachSummary({
    programmeWeek: { id: week.id, weekNumber: week.weekNumber, weekLabel: week.weekLabel, startDate: week.startDate },
    plannedRows: planned,
    loggedKeys: new Set((loggedRows || []).map(row => bareSessionKey(row.session_key)).filter(Boolean)),
    trainingLogs: Array.isArray(trainingLogRows) ? trainingLogRows : null,
    uploads: Array.isArray(uploadRows) ? uploadRows : null,
    strengthHistory: Array.isArray(strengthHistoryRows) ? strengthHistoryRows : [],
    bodyLogs: Array.isArray(bodyRows) ? bodyRows : [],
    previousWeekBodyLogs: Array.isArray(previousBodyRows) ? previousBodyRows : null,
    checkInRows: Array.isArray(checkInRows) ? checkInRows : [],
    gymKeys,
    structured,
    todayISO,
    generatedAt: now.toISOString(),
    missingSources,
    warnings,
    personalBestsStatus: strengthHistoryRows === null ? 'not_calculated' : 'calculated',
  });

  return {
    athleteCode: code,
    summary,
    navigation: {
      weeks: weeks.map(w => ({ id: w.id, label: w.label, weekNumber: w.weekNumber, startDate: w.startDate })),
      currentId: week.id,
      previousId: index > 0 ? weeks[index - 1].id : null,
      nextId: index >= 0 && index < weeks.length - 1 && weeks[index + 1].startDate <= todayISO ? weeks[index + 1].id : null,
    },
  };
}
