// Browser check of Garmin steps inside the Plan Session window, in the REAL
// dashboard shell, with /api/athletes answered by the REAL server functions
// (saveRunSession, readPrescription, updatePlannedSession) over an in-memory
// database that emulates save_run_session(). The SQL function itself is
// proven by supabase/tests/save-run-session.verify.sql.
//
//   node scripts/serve-preview.mjs &
//   node scripts/verify-plan-session-run.mjs
//
// Screenshots and console errors at 1280×900 and 390×844. Nothing here talks
// to Supabase or Garmin.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.VERIFY_OUT || '.verify-out/plan-session-run';
const BASE = process.env.PREVIEW_URL || 'http://localhost:4173';
mkdirSync(OUT, { recursive: true });
const P = await import(REPO + '/server/programming.js');
const A = await import(REPO + '/api/athletes.js');
const COACH = { id: 'c1', handle: 'KARL', role: 'admin' };
const ATHLETE = 'KAI';

// ── In-memory database ──────────────────────────────────────────────────────
const db = { sessions: new Map(), steps: [], calls: [] };
const TEXT = ['warm_up', 'intervals', 'working_pace', 'rest', 'cool_down', 'target_pace'];
function addSession(row) {
  const s = { id: randomUUID(), athlete_code: ATHLETE, status: 'Planned', locked_at: null, programme_week_id: null, week_label: 'Week 6',
    publish_state: 'published', prescription_mode: 'legacy', notion_page_id: null, library_id: null, run_details: null, distance_km: null,
    target_pace: null, warm_up: null, intervals: null, working_pace: null, rest: null, cool_down: null, notes: null,
    updated_at: new Date().toISOString(), ...row };
  db.sessions.set(s.id, s);
  return s;
}
const idFrom = (path) => decodeURIComponent((/id\.eq\.([^,)&]+)|id=eq\.([^&]+)/.exec(path) || []).slice(1).find(Boolean) || '');
async function sb(path, opts = {}) {
  const method = opts.method || 'GET';
  db.calls.push(`${method} ${path.split('?')[0]}`);
  if (path === 'rpc/save_run_session') {
    const { p_session_id, p_athlete_code, p_fields, p_steps } = opts.body;
    let s = p_session_id ? db.sessions.get(p_session_id) : addSession({ athlete_code: p_athlete_code, status: 'Planned' });
    if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
    for (const [k, v] of Object.entries(p_fields)) if (k !== 'status') s[k] = v;
    db.steps = db.steps.filter((r) => r.planned_session_id !== s.id).concat(p_steps.map((r) => ({ ...r, planned_session_id: s.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })));
    if (p_steps.length) s.prescription_mode = 'structured';
    if ('status' in p_fields) s.status = p_fields.status;
    s.updated_at = new Date().toISOString();
    return { ...s };
  }
  if (path.startsWith('planned_sessions?')) {
    const s = db.sessions.get(idFrom(path));
    if (method === 'PATCH') { if (!s) return []; Object.assign(s, opts.body); return [{ ...s }]; }
    if (!s) return [];
    return [{ ...s }];
  }
  if (path.startsWith('run_steps?')) {
    const sid = decodeURIComponent((/planned_session_id=eq\.([^&]+)/.exec(path) || [])[1]);
    return db.steps.filter((r) => r.planned_session_id === sid).sort((a, b) => a.step_order - b.step_order);
  }
  if (path.startsWith('garmin_workout_deliveries?') || path.startsWith('athlete_data?') || path.startsWith('session_exercises?') ||
      path.startsWith('workout_splits?') || path.startsWith('coach_athletes')) return [];
  if (path === 'programme_change_log') return null;
  throw new Error('unexpected ' + method + ' ' + path);
}

const LEGACY = addSession({ title: 'Tempo 5km', session_type: 'Tempo', planned_date: '2026-11-13', warm_up: '2km easy', intervals: '5km', working_pace: '4:15 /km', cool_down: '2km easy' });

// ── Browser ─────────────────────────────────────────────────────────────────
const results = [];
const check = (ok, name, detail = '') => { results.push({ ok: !!ok, name, detail }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };
const browser = await chromium.launch();

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('dp_dashboard_key', 'preview'); sessionStorage.setItem('dp_dashboard_coach', 'KARL'); } catch {} });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
  await page.route('**/api/athletes**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    try {
      if (req.method() === 'GET' && url.searchParams.get('action') === 'prescription') {
        return route.fulfill({ json: { ok: true, ...(await P.readPrescription(url.searchParams.get('session_id'), sb)) } });
      }
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        if (body.action === 'plan_save_run') { posts.push(body.action); return route.fulfill({ json: await P.saveRunSession(body, sb, COACH) }); }
        if (body.action === 'plan_update') { posts.push(body.action); return route.fulfill({ json: await A.updatePlannedSession(body.id, body.fields, sb) }); }
        if (body.action === 'plan_insert') { posts.push(body.action); const row = addSession({ ...body.row }); return route.fulfill({ json: { ok: true, rows: [row] } }); }
      }
    } catch (error) {
      return route.fulfill({ status: error.status || 500, json: { ok: false, error: error.message } });
    }
    return route.fallback();
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.DPPlanSessionRun && typeof window.openPlanSession === 'function' && typeof maPost === 'function');
  await page.evaluate((code) => { _progAthlete = code; }, ATHLETE);
  return { page, errors, posts };
}
const text = (page, sel) => page.$eval(sel, (n) => n.textContent).catch(() => '');
const visible = (page, sel) => page.$eval(sel, (n) => !!(n.offsetParent || n.getClientRects().length)).catch(() => false);
async function openNew(page, date) {
  await page.evaluate((d) => openPlanSession(null, d), date);
  await page.click('#ps-mode-run');
  await page.waitForSelector('#ps-steps #rb');
}
async function openRow(page, row) {
  await page.evaluate((r) => { const i = _planRowsSB.findIndex((x) => x.id === r.id); if (i >= 0) _planRowsSB[i] = r; else _planRowsSB.push(r); openPlanSession(r.id); }, row);
  await page.waitForSelector('#ps-steps #rb');
}
const stored = (id) => db.steps.filter((r) => r.planned_session_id === id);

// ── Desktop ─────────────────────────────────────────────────────────────────
let created;
{
  const { page, errors, posts } = await newPage({ width: 1280, height: 900 });
  await openNew(page, '2026-11-12');
  check(await visible(page, '#ps-steps-field'), 'Running: the Garmin step builder is in the Plan Session window');
  check(await visible(page, '#ps-warmup'), 'no steps yet: text fields still there for a text-only run');
  check(/text-only run/.test(await text(page, '#ps-steps .rb-empty')), 'empty state explains both options');

  await page.fill('#ps-name', '6 x 1 km');
  await page.selectOption('#ps-type', 'Speed');
  await page.click('#ps-steps [data-quick="intervals"]');
  await page.fill('#ps-steps .rb-step.is-interval [data-k="pace_fast"]', '4:30');
  await page.fill('#ps-steps .rb-step.is-interval [data-k="pace_slow"]', '4:45');
  await page.fill('#ps-steps .rb-step.is-warmup [data-k="durationText"]', '10:00');
  await page.selectOption('#ps-steps .rb-step.is-warmup [data-k="target"]', 'none');
  await page.selectOption('#ps-steps .rb-step.is-cooldown [data-k="target"]', 'none');
  await page.selectOption('#ps-steps .rb-step.is-recovery [data-k="target"]', 'none');
  check(!(await visible(page, '#ps-warmup')) && !(await visible(page, '#ps-pace')), 'with steps: warm-up/intervals/pace text fields are replaced');
  const card = await text(page, '#ps-steps .rb-card');
  check(/6 × 1 km @ 4:30–4:45 \/km/.test(card) && /1 min 30 s/.test(card) && /10 min/.test(card), 'athlete card preview written from the steps', card);
  check(await page.$eval('#ps-intervals', (n) => n.value) === '6 × 1 km', 'hidden text field holds the step text');
  check(/Garmin-compatible · unsaved changes/.test(await text(page, '#ps-steps .rb-status-title')), 'status: compatible, unsaved');
  check(/14 \/ 100 Garmin steps/.test(await text(page, '#ps-steps #rb-preview')), 'preview: 14 Garmin steps');
  await page.screenshot({ path: OUT + '/1-plan-session-steps-desktop.png' });

  await page.click('#ps-save');
  await page.waitForFunction(() => document.getElementById('ps-overlay').classList.contains('hidden'));
  check(JSON.stringify(posts) === '["plan_save_run"]', 'one save: session and steps together', JSON.stringify(posts));
  created = [...db.sessions.values()].find((s) => s.title === '6 x 1 km');
  check(created && created.intervals === '6 × 1 km' && created.working_pace === '4:30–4:45 /km' && created.rest === '1 min 30 s' && created.warm_up === '10 min',
    'stored card text matches the steps', created && JSON.stringify(TEXT.map((k) => created[k])));
  check(created && stored(created.id).length === 5 && created.prescription_mode === 'structured', 'five steps stored, session structured');
  check(created && created.publish_state === 'published' && created.planned_date === '2026-11-12' && created.athlete_code === ATHLETE, 'date, athlete and default publish state kept');

  // Reopen: steps load, nothing dirty; change only the date → normal path, steps untouched.
  posts.length = 0;
  const before = stored(created.id).map((r) => r.id).join();
  await openRow(page, { ...created });
  await page.waitForFunction(() => document.querySelectorAll('#ps-steps .rb-step').length === 4);
  page.__dialogs = [];
  await page.fill('#ps-date', '2026-11-14');
  await page.click('#ps-save');
  await page.waitForFunction(() => document.getElementById('ps-overlay').classList.contains('hidden'));
  check(JSON.stringify(posts) === '["plan_update"]' && stored(created.id).map((r) => r.id).join() === before, 'date-only edit: steps not rewritten (no false “changed since sent”)', JSON.stringify(posts));
  check(db.sessions.get(created.id).planned_date === '2026-11-14', 'date moved');

  // Edit the steps → atomic save, text follows.
  posts.length = 0;
  await openRow(page, { ...db.sessions.get(created.id) });
  await page.waitForFunction(() => document.querySelectorAll('#ps-steps .rb-step').length === 4);
  await page.fill('#ps-steps .rb-count', '5');
  await page.click('#ps-save');
  await page.waitForFunction(() => document.getElementById('ps-overlay').classList.contains('hidden'));
  check(JSON.stringify(posts) === '["plan_save_run"]' && db.sessions.get(created.id).intervals === '5 × 1 km', 'step edit: one save, card text now 5 × 1 km', db.sessions.get(created.id).intervals);

  // Legacy text session: text stays until the coach adds steps, then asks before replacing it.
  posts.length = 0;
  await openRow(page, { ...LEGACY });
  check(await visible(page, '#ps-warmup') && (await page.$eval('#ps-warmup', (n) => n.value)) === '2km easy', 'legacy run: its text is shown and untouched');
  await page.click('#ps-steps [data-quick="run"]');
  await page.fill('#ps-steps .rb-step.is-run [data-k="distance_km"]', '9');
  check(!(await visible(page, '#ps-warmup')), 'adding steps hides the text fields');
  await page.click('#ps-steps .rb-step.is-run [data-act="remove"]');
  check(await visible(page, '#ps-warmup') && (await page.$eval('#ps-warmup', (n) => n.value)) === '2km easy', 'removing every step brings the coach’s text back unchanged');
  await page.click('#ps-steps [data-quick="run"]');
  page.__dialogs = [];
  await page.click('#ps-save');
  await page.waitForFunction(() => document.getElementById('ps-overlay').classList.contains('hidden'));
  check((page.__dialogs || []).some((m) => /Replace this run’s text prescription with the steps/.test(m)), 'replacing a text prescription asks first', (page.__dialogs || []).join(' | '));
  const legacyNow = db.sessions.get(LEGACY.id);
  check(legacyNow.warm_up === null && legacyNow.intervals === '5 km' && stored(LEGACY.id).length === 1, 'legacy run now structured; text written from the steps', JSON.stringify(TEXT.map((k) => legacyNow[k])));

  // Invalid steps never leave the browser.
  posts.length = 0;
  await openNew(page, '2026-11-15');
  await page.selectOption('#ps-type', 'Speed');
  await page.click('#ps-steps [data-quick="intervals"]');
  page.__dialogs = [];
  await page.click('#ps-save');
  check(posts.length === 0 && (page.__dialogs || []).some((m) => /needs a pace/.test(m)), 'invalid steps: refused before any request', (page.__dialogs || []).join(' | '));
  check(!(await page.$eval('#ps-overlay', (n) => n.classList.contains('hidden'))), 'window stays open with the work intact');
  await page.screenshot({ path: OUT + '/2-plan-session-error-desktop.png' });
  await page.evaluate(() => { _snapshotModal('ps-overlay'); closePlanSession(); });

  // Strength mode: no step builder.
  await page.evaluate(() => openPlanSession(null, '2026-11-16'));
  await page.click('#ps-mode-str');
  check(!(await visible(page, '#ps-steps-field')), 'Strength: no Garmin step builder');
  await page.evaluate(() => closePlanSession());
  check(errors.length === 0, 'desktop: zero console errors', errors.join(' | '));
}

// ── Mobile ──────────────────────────────────────────────────────────────────
{
  const { page, errors, posts } = await newPage({ width: 390, height: 844 });
  await openNew(page, '2026-11-18');
  await page.fill('#ps-name', 'Long run');
  await page.selectOption('#ps-type', 'Long Run');
  await page.click('#ps-steps [data-quick="run"]');
  await page.fill('#ps-steps .rb-step.is-run [data-k="distance_km"]', '18');
  await page.selectOption('#ps-steps .rb-step.is-run [data-k="target"]', 'hr');
  await page.selectOption('#ps-steps .rb-step.is-run [data-k="hr_zone"]', '2');
  const overflow = await page.evaluate(() => { const p = document.querySelector('#ps-overlay .po-modal-body') || document.querySelector('#ps-overlay .po-modal'); return p.scrollWidth - p.clientWidth; });
  check(overflow <= 1, 'mobile: no horizontal scroll in the Plan Session window', String(overflow));
  check((await page.$eval('#ps-dist', (n) => n.value)) === '18', 'all-distance run fills total km for weekly volume');
  await page.$eval('#ps-steps-field', (n) => n.scrollIntoView());
  await page.screenshot({ path: OUT + '/3-plan-session-steps-mobile.png' });
  check(/18 km · HR zone 2/.test(await text(page, '#ps-steps .rb-card')), 'card preview joins HR with · as the portal card does');
  await page.$eval('#ps-steps .rb-card', (n) => n.scrollIntoView());
  await page.screenshot({ path: OUT + '/4-plan-session-card-mobile.png' });
  const small = await page.$$eval('#ps-steps button, #ps-steps select, #ps-steps input', (n) => n.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 30).map((e) => e.outerHTML.slice(0, 60)));
  check(small.length === 0, 'mobile: step controls at least 30px tall', small.slice(0, 3).join(' | '));
  await page.click('#ps-save');
  await page.waitForFunction(() => document.getElementById('ps-overlay').classList.contains('hidden'));
  const longRun = [...db.sessions.values()].find((s) => s.title === 'Long run');
  check(JSON.stringify(posts) === '["plan_save_run"]' && longRun && longRun.intervals === '18 km' && longRun.working_pace === 'HR zone 2' && longRun.distance_km === 18, 'mobile save: continuous HR run stored with its card text', longRun && JSON.stringify([longRun.intervals, longRun.working_pace, longRun.distance_km]));
  check(errors.length === 0, 'mobile: zero console errors', errors.join(' | '));
}

await browser.close();
writeFileSync(OUT + '/results.json', JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
