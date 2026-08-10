// api/lib/roster.js — shared helpers for the Supabase athletes roster.
// public.athletes is the single source of truth for the roster. RLS has no
// anon policies by design: every read/write goes through serverless functions
// using the service role key (via supabase-rest.js).

import { select } from './supabase-rest.js';

export function normCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

// Fetch one roster row by code. Returns null when the code isn't in the roster.
export async function getRosterAthlete(code) {
  const c = normCode(code);
  if (!c) return null;
  const rows = await select('athletes', { code: `eq.${c}`, select: '*', limit: 1 });
  return (Array.isArray(rows) && rows[0]) || null;
}

// An athlete is blocked when they are paused or archived.
export function isBlockedRow(row) {
  return !!row && (row.archived_at != null || row.active === false);
}

// Guard used by write endpoints. Identity checks fail closed: when the roster
// cannot be reached, the client keeps its submission in the retry queue rather
// than the server accepting an unverified write.
export async function checkRosterAccess(code) {
  try {
    const row = await getRosterAthlete(code);
    return { blocked: !row || isBlockedRow(row), row, unavailable: false };
  } catch (e) {
    console.warn('[roster] access check failed:', e && e.message);
    return { blocked: true, row: null, unavailable: true };
  }
}
