From 7fb086ce0331127be65cb106424ed26c9787b9ee Mon Sep 17 00:00:00 2001
From: Karl <karlsexon00@gmail.com>
Date: Fri, 26 Jun 2026 13:55:43 +0000
Subject: [PATCH] feat(dashboard): read structured Supabase tables as source of
 truth (body/nutrition/training/weekly) via new /api/coach-data, merged over
 Notion

---
 README.md         | 26 +++++++++++++
 api/coach-data.js | 97 +++++++++++++++++++++++++++++++++++++++++++++++
 public/index.html | 63 +++++++++++++++++++++++++++++-
 3 files changed, 184 insertions(+), 2 deletions(-)
 create mode 100644 api/coach-data.js

diff --git a/README.md b/README.md
index ce0fc1c..7ea546d 100644
--- a/README.md
+++ b/README.md
@@ -103,3 +103,29 @@ const DB = {
   nutrition: '3405a96c-c70b-804b-aa9c-f165f2d2e0e9',
 };
 ```
+
+---
+
+## Supabase source-of-truth reads (added)
+
+The dashboard now reads athlete submissions from the **structured Supabase
+tables** (the documented source of truth) in addition to Notion:
+
+- `api/coach-data.js` reads `daily_body_logs`, `daily_nutrition_logs`,
+  `training_session_logs`, `weekly_checkins`, `athlete_goals` server-side using
+  the service key, and returns them shaped to the dashboard's field names.
+- `public/index.html` merges these over the legacy Notion reads, **Supabase wins
+  on collision**, so athlete data is visible even when a Notion mirror write
+  failed. If `/api/coach-data` is unavailable it soft-fails and the dashboard
+  falls back to Notion exactly as before.
+
+### Required env vars (Vercel → dashboard project)
+
+```text
+NOTION_TOKEN           # existing
+SUPABASE_URL           # https://rugdupplsswxmpoudhpv.supabase.co
+SUPABASE_SERVICE_KEY   # Supabase service_role / secret key — SERVER-SIDE ONLY
+```
+
+Do **not** put `SUPABASE_SERVICE_KEY` in the frontend. The structured tables
+revoke `anon` access by design; only this serverless function may read them.
diff --git a/api/coach-data.js b/api/coach-data.js
new file mode 100644
index 0000000..c16bb8c
--- /dev/null
+++ b/api/coach-data.js
@@ -0,0 +1,97 @@
+// /api/coach-data.js — Vercel serverless function (coaches dashboard)
+// Reads the STRUCTURED, source-of-truth Supabase tables server-side using the
+// service key, and returns rows already shaped to the field names the dashboard
+// card builder (buildAll) expects — so the client merge is trivial.
+//
+// Why server-side: the structured tables (daily_body_logs, daily_nutrition_logs,
+// training_session_logs, weekly_checkins, athlete_goals) REVOKE select from anon.
+// The dashboard frontend uses the publishable/anon key, so it cannot read them
+// directly. This proxy keeps the source-of-truth tables server-only while still
+// surfacing them to the dashboard.
+//
+// Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY  (set on the dashboard Vercel
+// project — service key server-side only, never in the frontend).
+
+const TABLES = {
+  body:      'daily_body_logs',
+  nutrition: 'daily_nutrition_logs',
+  sessions:  'training_session_logs',
+  weekly:    'weekly_checkins',
+  goals:     'athlete_goals',
+};
+
+async function sbSelect(table) {
+  const url = process.env.SUPABASE_URL;
+  const key = process.env.SUPABASE_SERVICE_KEY;
+  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not configured');
+  const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/${table}?select=*`, {
+    headers: { apikey: key, Authorization: `Bearer ${key}` },
+  });
+  const text = await res.text();
+  const data = text ? JSON.parse(text) : [];
+  if (!res.ok) throw new Error(data?.message || data?.error || `Supabase ${res.status} on ${table}`);
+  return Array.isArray(data) ? data : [];
+}
+
+// ── Map structured rows → exact keys buildAll reads from Notion rows ──────────
+function mapBody(r) {
+  return {
+    AthleteID: r.athlete_code,
+    'date:Date:start': r.log_date, Date: r.log_date,
+    Weight: r.weight, 'Sleep Score': r.sleep, Energy: r.energy,
+    Stress: r.stress, Soreness: r.soreness, Notes: r.notes,
+    _source: 'supabase',
+  };
+}
+function mapNutrition(r) {
+  return {
+    AthleteID: r.athlete_code,
+    'date:Date:start': r.log_date, Date: r.log_date,
+    Calories: r.calories, Protein: r.protein, Carbs: r.carbs,
+    Fats: r.fat, Fibre: r.fibre, Notes: r.notes,   // Notion property is "Fats"
+    _source: 'supabase',
+  };
+}
+function mapSession(r) {
+  const code = r.athlete_code || '';
+  return {
+    'Athlete Code': code, AthleteID: code,         // sid() reads 'Athlete Code' first
+    Name: `${code} — ${r.session_name || ''} — ${r.session_date || ''}`,
+    Session: r.session_name || '',
+    'Session Category': r.session_category || '',  // 'Run' | 'Strength'
+    'Exercise Log': r.exercise_log || '',
+    Date: r.session_date, 'date:Date:start': r.session_date,
+    _source: 'supabase',
+  };
+}
+function mapWeekly(r) {
+  return {
+    Name: r.athlete_name || r.athlete_code, 'Week Ending': r.week_ending || null,
+    'Run Completed': r.run_completed, 'Run Planned': r.run_planned, 'Weekly Run KM': r.run_km,
+    'Run Feel /10': r.run_feel, 'Runs Wins': r.run_wins, 'Run Niggles': r.run_niggles,
+    'Lift Completed': r.lift_completed, 'Lift Planned': r.lift_planned, 'Lift Feel /10': r.lift_feel,
+    'Lift Wins': r.lift_wins, 'Lifts Niggles': r.lift_niggles, 'Sleep hrs': r.sleep,
+    'Energy /10': r.energy, 'Soreness /10': r.soreness, 'Nutrition Adherence /10': r.nutrition,
+    'Fuelling': r.fuelling, 'Social Event Upcoming': r.social_eating, 'Stress': r.stress,
+    'Motivation': r.motivation, 'Upcoming Impact': r.upcoming_impact, 'Testimonial': r.testimonial,
+    _athleteCode: r.athlete_code, _source: 'supabase', _updatedAt: r.updated_at,
+  };
+}
+
+export default async function handler(req, res) {
+  res.setHeader('Cache-Control', 'no-store');
+  try {
+    const [body, nutrition, sessions, weekly, goals] = await Promise.all([
+      sbSelect(TABLES.body), sbSelect(TABLES.nutrition), sbSelect(TABLES.sessions),
+      sbSelect(TABLES.weekly), sbSelect(TABLES.goals),
+    ]);
+    return res.status(200).json({
+      ok: true,
+      body: body.map(mapBody), nutrition: nutrition.map(mapNutrition),
+      sessions: sessions.map(mapSession), weekly: weekly.map(mapWeekly), goals,
+    });
+  } catch (e) {
+    // Soft-fail: empty arrays so the dashboard cleanly falls back to Notion.
+    return res.status(200).json({ ok: false, error: e.message, body: [], nutrition: [], sessions: [], weekly: [], goals: [] });
+  }
+}
diff --git a/public/index.html b/public/index.html
index 069fb45..239c32c 100644
--- a/public/index.html
+++ b/public/index.html
@@ -3689,6 +3689,58 @@ async function fetchWeeklyFromSupabase() {
 // Merge Supabase + Notion weekly check-ins. Supabase wins on collision
 // (same athlete + same Week Ending). Athlete identity for Supabase rows comes
 // from _athleteCode; for Notion rows it's parsed from the title (as before).
+// ── Structured Supabase tables (source of truth) → /api/coach-data ───────────
+// Reads daily_body_logs / daily_nutrition_logs / training_session_logs (+ weekly
+// and goals) server-side via the service key. Soft-fails to empty arrays so the
+// dashboard still renders from Notion if the endpoint/env is not configured.
+async function fetchCoachDataSB() {
+  const empty = { body: [], nutrition: [], sessions: [], weekly: [], goals: [] };
+  try {
+    const res = await fetch('/api/coach-data');
+    if (!res.ok) return empty;
+    const d = await res.json();
+    return {
+      body:      Array.isArray(d.body) ? d.body : [],
+      nutrition: Array.isArray(d.nutrition) ? d.nutrition : [],
+      sessions:  Array.isArray(d.sessions) ? d.sessions : [],
+      weekly:    Array.isArray(d.weekly) ? d.weekly : [],
+      goals:     Array.isArray(d.goals) ? d.goals : [],
+    };
+  } catch (e) { console.warn('fetchCoachDataSB failed', e); return empty; }
+}
+
+// Merge body/nutrition: one row per athlete+day, Supabase wins on collision.
+function mergeByAthleteDate(supaRows, notionRows) {
+  const out = [], seen = new Set();
+  const dOf = r => String(r['date:Date:start'] || r.Date || '').slice(0, 10);
+  const keyOf = r => `${nid(r.AthleteID)}|${dOf(r)}`;
+  (supaRows || []).forEach(r => { const k = keyOf(r); if (!seen.has(k)) { seen.add(k); out.push(r); } });
+  (notionRows || []).forEach(r => { const k = keyOf(r); if (!seen.has(k)) { seen.add(k); out.push(r); } });
+  return out;
+}
+
+// Merge sessions: a Supabase row REPLACES its Notion twin (same athlete+session+
+// category+date) so they aren't concatenated into a duplicate. Notion rows whose
+// key has no Supabase match are kept untouched (buildAll still merges per-exercise
+// Notion rows as before). Supabase wins.
+function mergeSessionsSupaFirst(supaRows, notionRows) {
+  const dOf = r => {
+    const raw = r.Date || r['date:Date:start'] || '';
+    const ddmm = String(raw).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
+    if (ddmm) return `${ddmm[3]}-${ddmm[2]}-${ddmm[1]}`;
+    const iso = String(raw).split('T')[0];
+    if (iso) return iso;
+    const m = String(r.Name || '').match(/(\d{4}-\d{2}-\d{2})$/);
+    return m ? m[1] : '';
+  };
+  const catOf = r => (r['Session Category'] || r.Type || r.type || '').trim();
+  const keyOf = r => `${sid(r)}|${r.Session || ''}|${catOf(r)}|${dOf(r)}`;
+  const supa = supaRows || [];
+  const supaKeys = new Set(supa.map(keyOf));
+  const keptNotion = (notionRows || []).filter(r => !supaKeys.has(keyOf(r)));
+  return [...supa, ...keptNotion];
+}
+
 function mergeWeekly(supaRows, notionRows) {
   const keyOf = (id, we) => `${id}|${we || ''}`;
   const out = [];
@@ -7334,11 +7386,11 @@ async function load({ bust = false } = {}) {
   document.getElementById('refresh-btn').disabled = true;
 
   try {
-    const [weeklyNotion, sessions, body, nutrition, athleteDb, targets, planning, applications, weeklySupa, , libRows, decisionsRes] = await Promise.all([
+    const [weeklyNotion, sessionsNotion, bodyNotion, nutritionNotion, athleteDb, targets, planning, applications, weeklySupa, coachDataSB, , libRows, decisionsRes] = await Promise.all([
       fetchDB(DB.weekly, bust), fetchDB(DB.sessions, bust), fetchDB(DB.body, bust),
       fetchDB(DB.nutrition, bust), fetchDB(DB.athletes, bust), fetchTargetsSB(),
       fetchPlanningSB(), fetchDB(DB.applications, bust),
-      fetchWeeklyFromSupabase(),
+      fetchWeeklyFromSupabase(), fetchCoachDataSB(),
       loadSessionLogs(), loadSessionLibrary(),
       getSB().from('application_decisions').select('notion_id,decision,decided_by,decided_at'),
       loadCallNotes(), loadAcks(),
@@ -7347,6 +7399,13 @@ async function load({ bust = false } = {}) {
     // Weekly check-ins now come from Supabase (full payload, primary) merged
     // with legacy Notion check-ins (older submissions). Supabase wins on
     // collision so the current source of truth always takes precedence.
+    // Structured Supabase tables are the source of truth — merge over the legacy
+    // Notion reads (Supabase wins on collision) so every athlete submission shows
+    // even when a Notion mirror write failed.
+    const body      = mergeByAthleteDate(coachDataSB.body,      bodyNotion);
+    const nutrition = mergeByAthleteDate(coachDataSB.nutrition, nutritionNotion);
+    const sessions  = mergeSessionsSupaFirst(coachDataSB.sessions, sessionsNotion);
+
     const weekly = mergeWeekly(weeklySupa, weeklyNotion);
 
     _decisions = decisionsRes?.data || [];
-- 
2.34.1

