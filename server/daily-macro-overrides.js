// Coach-owned day-level macro prescriptions.
//
// Each row belongs to one canonical programme week and replaces that week's
// nutrition targets for one calendar day only. Drafts remain coach-only;
// athletes receive published, unremoved rows through /api/my-logs.

import { assertAthleteAllowed, normaliseCode } from './coach-scope.js';

const MACRO_FIELDS = {
  calories: { label: 'Calories', ceiling: 12000 },
  protein_g: { label: 'Protein', ceiling: 2000 },
  carbs_g: { label: 'Carbs', ceiling: 2000 },
  fats_g: { label: 'Fats', ceiling: 2000 },
  fibre_g: { label: 'Fibre', ceiling: 2000 },
};

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

function optionalWholeNumber(value, label, ceiling) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw httpError(`${label} must be a whole number of zero or more`, 400);
  }
  if (number > ceiling) {
    throw httpError(`${label} must be ${ceiling.toLocaleString('en-AU')} or less`, 400);
  }
  return number;
}

function cleanDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw httpError('A date such as 2026-08-22 is required', 400);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw httpError('A date such as 2026-08-22 is required', 400);
  }
  return date;
}

function cleanPublishState(value) {
  const state = String(value || '').trim().toLowerCase();
  if (!['draft', 'published'].includes(state)) {
    throw httpError('Override state must be draft or published', 400);
  }
  return state;
}

function cleanDayLabel(value) {
  const label = String(value === null || value === undefined ? '' : value).trim();
  return label ? label.slice(0, 60) : null;
}

function cleanNote(value) {
  const note = String(value === null || value === undefined ? '' : value).trim();
  return note ? note.slice(0, 2000) : null;
}

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
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
    throw httpError('Programme week not found', 404);
  }
  return { ...week, programme };
}

function assertDateInWeek(date, week) {
  if (!week.start_date) return;
  const start = cleanDate(week.start_date);
  if (date < start || date > addDays(start, 6)) {
    throw httpError('Override date must fall within the selected programme week', 400);
  }
}

function macroPayload(body) {
  const out = {};
  Object.entries(MACRO_FIELDS).forEach(([field, spec]) => {
    out[field] = optionalWholeNumber(body[field], spec.label, spec.ceiling);
  });
  const publishState = cleanPublishState(body.publish_state);
  if (publishState === 'published' && out.calories === null) {
    throw httpError('A published override needs calories', 400);
  }
  if (publishState === 'published' && out.protein_g === null) {
    throw httpError('A published override needs protein', 400);
  }
  return {
    ...out,
    day_label: cleanDayLabel(body.day_label),
    coach_note: cleanNote(body.coach_note),
    publish_state: publishState,
  };
}

function publishedAtFor(existing, publishState, now) {
  if (publishState !== 'published') return null;
  return existing?.publish_state === 'published' && !existing?.removed_at
    ? existing.published_at
    : now.toISOString();
}

export function coachOverrideResponse(row) {
  return {
    id: row.id,
    athleteCode: row.athlete_code,
    weekIdentifier: row.programme_week_id,
    date: row.override_date,
    calories: row.calories,
    proteinG: row.protein_g,
    carbsG: row.carbs_g,
    fatsG: row.fats_g,
    fibreG: row.fibre_g,
    dayLabel: row.day_label,
    coachNote: row.coach_note,
    state: row.publish_state,
    publishedAt: row.published_at,
    removedAt: row.removed_at,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listDailyMacroOverrides(athleteCodeInput, sb, coach) {
  const athleteCode = await assertAthleteAllowed(coach, athleteCodeInput, sb);
  const programmes = await sb(
    `athlete_programmes?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    '&status=eq.active&select=id,name,status&order=updated_at.desc&limit=1'
  );
  const programme = Array.isArray(programmes) ? programmes[0] : null;
  const weeks = programme ? await sb(
    `athlete_programme_weeks?programme_id=eq.${encodeURIComponent(programme.id)}` +
    '&select=id,programme_id,week_number,week_label,start_date&order=week_number.asc'
  ) : [];
  const overrides = await sb(
    `daily_macro_overrides?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    '&select=*&order=override_date.asc'
  );
  return {
    ok: true,
    athleteCode,
    programme,
    programmeWeeks: (Array.isArray(weeks) ? weeks : []).map((week) => ({
      id: week.id,
      programmeId: week.programme_id,
      weekNumber: week.week_number,
      weekLabel: week.week_label || `Week ${week.week_number}`,
      startDate: week.start_date,
    })),
    overrides: (Array.isArray(overrides) ? overrides : []).map(coachOverrideResponse),
  };
}

async function saveRows(body, rawDates, sb, coach, now) {
  const athleteCode = await assertAthleteAllowed(coach, body.athlete_code, sb);
  const programmeWeekId = uuid(body.programme_week_id, 'Programme week');
  if (!rawDates.length || rawDates.length > 14) {
    throw httpError('Choose between 1 and 14 override dates', 400);
  }
  const dates = [...new Set(rawDates.map(cleanDate))];
  const week = await programmeWeekForAthlete(athleteCode, programmeWeekId, sb);
  dates.forEach((date) => assertDateInWeek(date, week));
  const payload = macroPayload(body);
  const encodedDates = dates.map((date) => `"${date}"`).join(',');
  const existingRows = await sb(
    `daily_macro_overrides?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    `&override_date=in.(${encodeURIComponent(encodedDates)})&select=*`
  );
  const existingByDate = new Map((Array.isArray(existingRows) ? existingRows : []).map((row) => [row.override_date, row]));
  const rows = dates.map((date) => ({
    athlete_code: athleteCode,
    programme_week_id: programmeWeekId,
    override_date: date,
    ...payload,
    published_at: publishedAtFor(existingByDate.get(date), payload.publish_state, now),
    removed_at: null,
    updated_by: coach.id,
  }));
  const saved = await sb('daily_macro_overrides?on_conflict=athlete_code,override_date', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: rows,
  });
  if (!Array.isArray(saved) || saved.length !== rows.length) {
    throw httpError('Daily macro overrides could not be saved', 502);
  }
  return saved.map(coachOverrideResponse);
}

export async function saveDailyMacroOverride(body, sb, coach, now = new Date()) {
  const overrides = await saveRows(body, [body.override_date], sb, coach, now);
  return { ok: true, override: overrides[0] };
}

export async function saveDailyMacroOverrideRange(body, sb, coach, now = new Date()) {
  if (!Array.isArray(body.dates)) throw httpError('Override dates are required', 400);
  const overrides = await saveRows(body, body.dates, sb, coach, now);
  return { ok: true, overrides };
}

export async function removeDailyMacroOverride(body, sb, coach, now = new Date()) {
  const athleteCode = await assertAthleteAllowed(coach, body.athlete_code, sb);
  const date = cleanDate(body.override_date);
  const rows = await sb(
    `daily_macro_overrides?athlete_code=eq.${encodeURIComponent(athleteCode)}` +
    `&override_date=eq.${encodeURIComponent(date)}`,
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
  return { ok: true, removed: !!removed, override: removed ? coachOverrideResponse(removed) : null };
}
