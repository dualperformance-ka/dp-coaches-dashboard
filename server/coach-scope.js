// Programming authorisation, edit-scope resolution and the coach audit trail.
//
// This module answers three questions for every programming request:
//   1. Is this a real, enabled coach?            (identity)
//   2. May they touch THIS athlete?              (scope)
//   3. Which sessions does this edit apply to?   (edit scope, spec §18)
//
// Identity today is still the shared DASHBOARD_ACCESS_KEY plus a self-declared
// X-Coach-Name — server/coach-auth.js owns that and is unchanged. What this adds
// is everything after it: a real coaches row, a role, and a per-athlete check.
// When real coach logins arrive, only resolveCoachIdentity() changes; every
// caller below keeps working.

import { requireCoach } from './coach-auth.js';

const DESTRUCTIVE_ROLE = 'admin';

// planned_sessions.status is constrained to exactly these four values
// (planned_sessions_status_check). An ALLOWLIST is used deliberately: a
// denylist would silently start treating any future status as editable, and
// the failure mode there is rewriting an athlete's training history.
const EDITABLE_STATUS = 'Planned';

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normaliseHandle(value) {
  return String(value || '').trim().toUpperCase();
}

export function normaliseCode(value) {
  return String(value || '').trim().toUpperCase();
}

// Resolve the request to a coaches row. A coach who authenticates with a valid
// key but has no enabled row is rejected: the shared key proves someone is
// staff, the coaches table decides what they are.
export async function resolveCoachIdentity(req, sb) {
  const { coach } = requireCoach(req);
  const handle = normaliseHandle(coach);

  const rows = await sb(`coaches?handle=eq.${encodeURIComponent(handle)}&select=id,handle,name,role,enabled&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;

  if (!row) throw httpError(`Coach "${handle}" is not registered`, 403);
  if (!row.enabled) throw httpError(`Coach "${handle}" is disabled`, 403);

  return { id: row.id, handle: row.handle, name: row.name, role: row.role };
}

// Which athletes may this coach programme?
//
// Deliberately opt-in per coach so nothing breaks today and no configuration is
// required to keep working:
//   - admin           → every athlete
//   - has coach_athletes rows → exactly those athletes
//   - has none        → every athlete (current behaviour)
//
// Narrowing a coach is therefore a matter of inserting coach_athletes rows for
// them, with no code change and no risk to anyone else.
export async function authorisedAthleteCodes(coach, sb) {
  if (coach.role === DESTRUCTIVE_ROLE) return null; // null = unrestricted

  const rows = await sb(`coach_athletes?coach_id=eq.${coach.id}&select=athlete_code`);
  const codes = (Array.isArray(rows) ? rows : []).map((row) => normaliseCode(row.athlete_code));
  return codes.length ? codes : null;
}

export async function assertAthleteAllowed(coach, athleteCode, sb) {
  const code = normaliseCode(athleteCode);
  if (!code) throw httpError('Athlete code is required', 400);

  const allowed = await authorisedAthleteCodes(coach, sb);
  if (allowed && !allowed.includes(code)) {
    // Same message whether the athlete exists or not: a coach must not be able
    // to enumerate the roster by probing for different error text.
    throw httpError('You are not authorised for that athlete', 403);
  }
  return code;
}

export function assertAdmin(coach) {
  if (coach.role !== DESTRUCTIVE_ROLE) {
    throw httpError('That action requires an admin coach', 403);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit scope (spec §18)
//
// Resolved SERVER-SIDE, always. The browser sends an intent ('session',
// 'future', 'block') and never a list of ids — otherwise a crafted request
// could rewrite an athlete's entire history.
// ─────────────────────────────────────────────────────────────────────────────

export const EDIT_SCOPES = ['session', 'future', 'block'];

function editableFilter() {
  // Two independent guards, because this is the rule that protects history:
  //   locked_at is null  — set on completion, and enforced by a database
  //                        trigger that refuses prescription writes outright
  //   status is Planned  — anything Completed, Missed or Sick is a record of
  //                        what happened, not a plan that can still change
  return `locked_at=is.null&status=eq.${EDITABLE_STATUS}`;
}

export async function loadSession(sessionId, sb) {
  const id = String(sessionId || '').trim();
  if (!id) throw httpError('Session id is required', 400);
  const rows = await sb(
    `planned_sessions?id=eq.${encodeURIComponent(id)}&select=id,athlete_code,title,planned_date,week_label,session_type,status,publish_state,prescription_mode,locked_at,programme_week_id&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw httpError('Session not found', 404);
  return row;
}

// Returns { sessions, appliedScope, note }.
//
// appliedScope can differ from what was requested: asking for 'block' on an
// athlete who has no programme block yet degrades to 'future' rather than
// silently doing nothing or guessing a window. The caller surfaces `note` so
// the coach is told what actually happened.
export async function resolveScope(session, requestedScope, sb) {
  const scope = EDIT_SCOPES.includes(requestedScope) ? requestedScope : 'session';

  if (scope === 'session') {
    // Both guards, not just locked_at: sessions completed before locking
    // existed still carry status 'Completed' with a null locked_at.
    if (session.locked_at || (session.status && session.status !== EDITABLE_STATUS)) {
      throw httpError(`That session is marked ${session.status || 'completed'} and cannot be edited`, 409);
    }
    return { sessions: [session], appliedScope: 'session', note: '' };
  }

  const code = encodeURIComponent(session.athlete_code);
  const title = encodeURIComponent(session.title || '');

  if (scope === 'block' && session.programme_week_id) {
    const weeks = await sb(
      `athlete_programme_weeks?id=eq.${encodeURIComponent(session.programme_week_id)}&select=block_id,programme_id&limit=1`
    );
    const blockId = Array.isArray(weeks) && weeks[0] ? weeks[0].block_id : null;
    if (blockId) {
      const blockWeeks = await sb(
        `athlete_programme_weeks?block_id=eq.${encodeURIComponent(blockId)}&select=id`
      );
      const ids = (Array.isArray(blockWeeks) ? blockWeeks : []).map((w) => w.id).filter(Boolean);
      if (ids.length) {
        const rows = await sb(
          `planned_sessions?athlete_code=eq.${code}&title=eq.${title}` +
          `&programme_week_id=in.(${ids.join(',')})&${editableFilter()}` +
          `&select=id,athlete_code,title,planned_date,prescription_mode,locked_at&order=planned_date.asc`
        );
        return {
          sessions: Array.isArray(rows) ? rows : [],
          appliedScope: 'block',
          note: '',
        };
      }
    }
  }

  // 'future', and 'block' where no programme block exists yet.
  const rows = await sb(
    `planned_sessions?athlete_code=eq.${code}&title=eq.${title}` +
    `&planned_date=gte.${encodeURIComponent(session.planned_date || '1900-01-01')}` +
    `&${editableFilter()}` +
    `&select=id,athlete_code,title,planned_date,prescription_mode,locked_at&order=planned_date.asc&limit=400`
  );

  return {
    sessions: Array.isArray(rows) ? rows : [],
    appliedScope: 'future',
    note: scope === 'block'
      ? 'No programme block covers this session yet, so the change was applied to this and all future sessions with the same name.'
      : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit (spec §20, §21)
//
// programme_change_log is coach-and-admin only and separate from
// coach_change_log, which stays exactly as it is and continues to drive the
// athlete's push notification.
// ─────────────────────────────────────────────────────────────────────────────

export async function logProgrammeChange(sb, entry) {
  try {
    await sb('programme_change_log', {
      method: 'POST',
      body: [{
        programme_id: entry.programmeId || null,
        athlete_code: entry.athleteCode || null,
        changed_by: entry.changedBy || null,
        entity_type: entry.entityType,
        entity_id: entry.entityId || null,
        action: entry.action,
        scope: entry.scope || null,
        old_value: entry.oldValue === undefined ? null : entry.oldValue,
        new_value: entry.newValue === undefined ? null : entry.newValue,
        summary: entry.summary || null,
      }],
      prefer: 'return=minimal',
    });
  } catch (error) {
    // Never let the audit trail take a coach's edit down with it. A missing log
    // line is a small loss; a failed save in the middle of programming is not.
    console.warn('[programming] audit write failed:', error && error.message);
  }
}
