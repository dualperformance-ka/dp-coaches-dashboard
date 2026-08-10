// api/_lib/booking.js — shared helpers for storing booked call times in
// athlete_data. Used by /api/call-booked (GHL webhook) and /api/sync-bookings
// (pull of existing/upcoming GHL appointments).

import { upsert } from './supabase-rest.js';

export const TZ = 'Australia/Adelaide';

// Date shifted into Adelaide wall-clock so week math matches the athlete.
export function adelaideDate(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

// Same ISO-week math as the portal client's callNudgeWeekKey().
//
// Weeks reset at Monday midnight in Adelaide. A Sunday booking belongs to the
// week that just ended; any booking from Monday onward belongs to the new week.
export function isoWeekKey(localDate) {
  const d = new Date(localDate); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return `call_booked_${d.getFullYear()}_${week < 10 ? '0' : ''}${week}`;
}

// Matches the client's dpFormatBookedTime output: "Tue 15 Jul · 6:30 pm".
// Built from parts so Node's locale data can't drift from browser output.
export function displayTime(date) {
  const p = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
    .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const t = {};
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(date).forEach((x) => { t[x.type] = x.value; });
  const month = String(p.month || '').slice(0, 3);
  const ampm = String(t.dayPeriod || '').toLowerCase();
  return `${p.weekday} ${p.day} ${month} · ${t.hour}:${t.minute} ${ampm}`;
}

// Writes the weekly call_booked key for an athlete. Returns { key, value }.
// The value carries the raw timestamp alongside the display string so the week
// rules can be re-derived later without going back to GHL. Older rows are a
// bare string (or the legacy '1' flag); the portal reads all three shapes.
export async function storeCallBooked(code, startDate) {
  const key = isoWeekKey(adelaideDate(startDate));
  const value = { time: displayTime(startDate), startsAt: new Date(startDate).toISOString() };
  await upsert('athlete_data', [{
    athlete_code: code,
    key,
    value,
    updated_at: new Date().toISOString(),
  }], 'athlete_code,key');
  return { key, value };
}
