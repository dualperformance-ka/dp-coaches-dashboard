// Coach-owned weekly running, cycling and swimming targets.
//
// Target rows always point at athlete_programme_weeks.id. The athlete code is
// stored as a query/scope key too, and the database rejects any row where that
// code does not own the referenced programme week.

import {
  assertAthleteAllowed,
  logProgrammeChange,
  normaliseCode,
} from './coach-scope.js';

export const WEEKLY_TARGET_SPORTS = ['running', 'cycling', 'swimming'];

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function uuid(value, label) {
  const out = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(out)) {
    throw httpError(`${label} is required`, 400);
  }
  return out;
}

function optionalWholeNumber(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw httpError(`${label} must be a whole number of zero or more`, 400);
  }
  return number;
}

function cleanSport(value) {
  const sport = String(value || '').trim().toLowerCase();
  if (!WEEKLY_TARGET_SPORTS.includes(sport)) {
    throw httpError('Sport must be running, cycling, or swimming', 400);
  }
  return sport;
}

function cleanPublishState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (!['draft', 'published'].includes(state)) {
    throw httpError('Target state must be draft or published', 400);
  }
  return state;
}

function cleanNote(value) {
  const note = String(value === null || value === undefined ? '' : value).trim();
  return note ? note.slice(0, 2000) : null;
}

function weekNumberFromLabel(value) {
  const label = String(value || '').trim();
  if (/discovery/i.test(label)) return 0;
  const match = label.match(/(?:week\s*)?(\d+)/i);
  if (!match) throw httpError('A programme week label such as Week 4 is required', 400);
  return Number(match[1]);
}

async function programmeWeekForAthlete(athleteCode, programmeWeekId, sb) {
  const weeks = await sb(
    `athlete_programme_weeks?id=eq.${encodeURIComponent(programmeWeekId)}` +
    '&select=id,programme_id,week_number,week_label,start_date&limit=1'
  );
  const week = Array.isArray(weeks) ? weeks[0] : null;
  if (!week) throw httpError('Programme week not found', 404);

  const programmes = await sb(
    `athlete_programmes?id=eq.${encodeURIComponent(week.programme_id)}` +
    '&select=id,athlete_code,status&limit=1'
  );
  const programme = Array.isArray(programmes) ? programmes[0] : null;
  if (!programme || normaliseCode(programme.athlete_code) !== athleteCode) {
    // Deliberately identical for a missing week and a week owned by another
    // athlete. A crafted UUID must not become an athlete enumeration oracle.
    throw httpError('Programme week not found', 404);
  }
  return { ...week, programme };
}

export function coachTargetResponse(row) {
  return {
    id: row.id,
    athleteCode: row.athlete_code,
    weekIdentifier: row.programme_week_id,
    sport: row.sport,
    distanceTargetMetres: row.distance_target_metres,
    sessionTarget: row.session_target,
    durationTargetMinutes: row.duration_target_minutes,
    coachNote: row.coach_note,
    state: row.publish_state,
    publishedAt: row.published_at,
    removedAt: row.removed_at,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWeeklySportTargets(athleteCodeInput, sb, coach) {
  const athleteCode = await assertAthleteAllowed(coach, athleteCodeInput, sb);
  const programmes = await sb(
    `athlete_programmes?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    '&status=eq.active&select=id,name,status&order=updated_at.desc&limit=1'
  );
  const programme = Array.isArray(programmes) ? programmes[0] : null;
  const weeks = programme
    ? await sb(
      `athlete_programme_weeks?programme_id=eq.${encodeURIComponent(programme.id)}` +
      '&select=id,programme_id,week_number,week_label,start_date&order=week_number.asc'
    )
    : [];
  const targets = await sb(
    `weekly_sport_targets?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    '&select=*&order=updated_at.desc'
  );

  return {
    ok: true,
    athleteCode,
    programme,
    programmeWeeks: Array.isArray(weeks) ? weeks.map((week) => ({
      id: week.id,
      programmeId: week.programme_id,
      weekNumber: week.week_number,
      weekLabel: week.week_label || `Week ${week.week_number}`,
      startDate: week.start_date,
    })) : [],
    targets: Array.isArray(targets) ? targets.map(coachTargetResponse) : [],
  };
}

// Explicit coach action used when an existing legacy Week N has not yet been
// adopted into the structured programme hierarchy. It creates the canonical
// programme/week identity only; it never creates a sport target.
export async function ensureWeeklyTargetProgrammeWeek(body, sb, coach) {
  const athleteCode = await assertAthleteAllowed(coach, body.athlete_code, sb);
  const weekNumber = weekNumberFromLabel(body.week_label);
  const label = weekNumber === 0 ? 'Week 0' : `Week ${weekNumber}`;

  let programmes = await sb(
    `athlete_programmes?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    '&status=eq.active&select=id,name,status&order=updated_at.desc&limit=1'
  );
  let programme = Array.isArray(programmes) ? programmes[0] : null;
  if (!programme) {
    programmes = await sb('athlete_programmes', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{
        athlete_code: athleteCode,
        coach_handle: coach.handle,
        name: 'Coach programme',
        type: 'combined',
        status: 'active',
        created_by: coach.handle,
      }],
    });
    programme = Array.isArray(programmes) ? programmes[0] : null;
    if (!programme) throw httpError('Could not create the athlete programme', 502);
  }

  let weeks = await sb(
    `athlete_programme_weeks?programme_id=eq.${encodeURIComponent(programme.id)}` +
    `&week_number=eq.${weekNumber}&select=id,programme_id,week_number,week_label,start_date&limit=1`
  );
  let week = Array.isArray(weeks) ? weeks[0] : null;
  if (!week) {
    weeks = await sb('athlete_programme_weeks', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{ programme_id: programme.id, week_number: weekNumber, week_label: label }],
    });
    week = Array.isArray(weeks) ? weeks[0] : null;
    if (!week) throw httpError('Could not create the programme week', 502);

    await logProgrammeChange(sb, {
      athleteCode,
      changedBy: coach.handle,
      programmeId: programme.id,
      entityType: 'programme_week',
      entityId: week.id,
      action: 'created',
      newValue: { week_number: weekNumber, week_label: label },
      summary: `Created the canonical ${label} programme week`,
    });
  }

  return {
    ok: true,
    athleteCode,
    programme,
    programmeWeek: {
      id: week.id,
      programmeId: week.programme_id,
      weekNumber: week.week_number,
      weekLabel: week.week_label || label,
      startDate: week.start_date,
    },
  };
}

export async function saveWeeklySportTarget(body, sb, coach, now = new Date()) {
  const athleteCode = await assertAthleteAllowed(coach, body.athlete_code, sb);
  const programmeWeekId = uuid(body.programme_week_id, 'Programme week');
  const sport = cleanSport(body.sport);
  const publishState = cleanPublishState(body.publish_state);
  const distanceTargetMetres = optionalWholeNumber(body.distance_target_metres, 'Distance target');
  const sessionTarget = optionalWholeNumber(body.session_target, 'Session target');
  const durationTargetMinutes = optionalWholeNumber(body.duration_target_minutes, 'Duration target');
  if (publishState === 'published' && distanceTargetMetres === null) {
    throw httpError('A published target needs a distance target (zero is allowed)', 400);
  }

  await programmeWeekForAthlete(athleteCode, programmeWeekId, sb);
  const existingRows = await sb(
    `weekly_sport_targets?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    `&programme_week_id=eq.${encodeURIComponent(programmeWeekId)}` +
    `&sport=eq.${encodeURIComponent(sport)}&select=*&limit=1`
  );
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  const publishedAt = publishState === 'published'
    ? (existing?.publish_state === 'published' && !existing?.removed_at
      ? existing.published_at
      : now.toISOString())
    : null;

  const rows = await sb('weekly_sport_targets?on_conflict=athlete_code,programme_week_id,sport', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{
      athlete_code: athleteCode,
      programme_week_id: programmeWeekId,
      sport,
      distance_target_metres: distanceTargetMetres,
      session_target: sessionTarget,
      duration_target_minutes: durationTargetMinutes,
      coach_note: cleanNote(body.coach_note),
      publish_state: publishState,
      published_at: publishedAt,
      removed_at: null,
      updated_by: coach.id,
    }],
  });
  const saved = Array.isArray(rows) ? rows[0] : null;
  if (!saved) throw httpError('Target could not be saved', 502);
  return { ok: true, target: coachTargetResponse(saved) };
}

export async function removeWeeklySportTarget(body, sb, coach, now = new Date()) {
  const athleteCode = await assertAthleteAllowed(coach, body.athlete_code, sb);
  const programmeWeekId = uuid(body.programme_week_id, 'Programme week');
  const sport = cleanSport(body.sport);
  await programmeWeekForAthlete(athleteCode, programmeWeekId, sb);

  const rows = await sb(
    `weekly_sport_targets?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    `&programme_week_id=eq.${encodeURIComponent(programmeWeekId)}` +
    `&sport=eq.${encodeURIComponent(sport)}`,
    {
      method: 'PATCH',
      prefer: 'return=representation',
      body: {
        publish_state: 'draft',
        published_at: null,
        removed_at: now.toISOString(),
        updated_by: coach.id,
      },
    }
  );
  const removed = Array.isArray(rows) ? rows[0] : null;
  return { ok: true, removed: !!removed, target: removed ? coachTargetResponse(removed) : null };
}
