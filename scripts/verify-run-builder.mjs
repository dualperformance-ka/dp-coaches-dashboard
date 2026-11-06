// End-to-end check of the structured run builder in the REAL dashboard shell,
// with the programming API answered by the REAL server/programming.js
// functions over an in-memory database that emulates save_run_session()
// (steps + athlete-card text in one call; before Nov 2026, replace_run_steps())
// (supabase/tests/replace-run-steps.verify.sql proves the real function).
// Screenshots and console errors at phone (390×844) and desktop (1280×900).
//
//   node scripts/serve-preview.mjs &
//   node scripts/verify-run-builder.mjs
//
// Nothing here talks to Supabase or Garmin.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.VERIFY_OUT || '.verify-out/run-builder';
const BASE = process.env.PREVIEW_URL || 'http://localhost:4173';
mkdirSync(OUT, { recursive: true });
const P = await import(REPO + '/server/programming.js');
const COACH = { id: 'c1', handle: 'KARL', role: 'admin' };

// ── In-memory database ──────────────────────────────────────────────────────
const db = {
  sessions: new Map(),
  steps: [],
  receipts: [],
  moves: null,     // athlete_data.reschedules: the athlete's own moves in the portal
  rpcCalls: 0,
  directStepWrites: 0,
};
function addSession(row) {
  const s = { status: 'Planned', locked_at: null, programme_week_id: null, week_label: 'Week 6', publish_state: 'draft', prescription_mode: 'legacy',
    run_details: null, distance_km: null, target_pace: null, warm_up: null, intervals: null, working_pace: null, rest: null, cool_down: null, notes: null,
    updated_at: new Date().toISOString(), ...row };
  db.sessions.set(s.id, s);
  return s;
}
const idFrom = (path) => decodeURIComponent((/id=eq\.([^&]+)/.exec(path) || [])[1] || '');
async function sb(path, opts = {}) {
  const method = opts.method || 'GET';
  if (path.startsWith('planned_sessions?')) {
    const s = db.sessions.get(idFrom(path));
    if (method === 'PATCH') { Object.assign(s, opts.body); return []; }
    if (!s) return [];
    if (path.includes('select=run_details')) return [s];
    const { run_details, distance_km, target_pace, warm_up, intervals, working_pace, rest, cool_down, notes, updated_at, ...core } = s;
    return [core];
  }
  if (path.startsWith('run_steps?')) {
    if (method !== 'GET') { db.directStepWrites++; throw new Error('direct run_steps write'); }
    const sid = decodeURIComponent((/planned_session_id=eq\.([^&]+)/.exec(path) || [])[1]);
    return db.steps.filter((r) => r.planned_session_id === sid).sort((a, b) => a.step_order - b.step_order);
  }
  if (path === 'rpc/save_run_session' || path === 'rpc/replace_run_steps') {
    db.rpcCalls++;
    const { p_session_id: sid, p_steps: rows, p_publish_state: pub, p_fields: fields } = opts.body;
    const s = db.sessions.get(sid);
    if (fields) for (const [k, v] of Object.entries(fields)) if (k !== 'status') s[k] = v;
    if (s.locked_at) throw Object.assign(new Error('locked'), { status: 409 });
    for (const r of rows) if (r.parent_step_id && !rows.some((p) => p.id === r.parent_step_id && p.step_type === 'repeat')) throw new Error('bad parent');
    const now = new Date().toISOString();
    db.steps = db.steps.filter((r) => r.planned_session_id !== sid).concat(rows.map((r) => ({ ...r, created_at: now, updated_at: now })));
    if (rows.length) s.prescription_mode = 'structured';
    if (pub) s.publish_state = pub;
    s.updated_at = now;
    return { steps: rows.length };
  }
  if (path.startsWith('garmin_workout_deliveries?')) return db.receipts.filter((r) => r.planned_session_id === idFrom(path.replace('planned_session_id', 'id')));
  if (path.startsWith('athlete_data?')) return db.moves ? [{ value: db.moves }] : [];
  if (path.startsWith('session_exercises?') || path.startsWith('workout_splits?') || path.startsWith('coach_athletes')) return [];
  if (path === 'programme_change_log') return null;
  throw new Error('unexpected ' + method + ' ' + path);
}

const LEGACY = addSession({ id: randomUUID(), athlete_code: 'THOMAS', title: 'Intervals 6×1km', planned_date: '2026-11-12', session_type: 'Speed',
  warm_up: '10 min easy', intervals: '6 × 1 km', working_pace: '4:30–4:45 /km', rest: '90s jog', cool_down: '10 min easy', publish_state: 'published' });
const DRAFT = addSession({ id: randomUUID(), athlete_code: 'THOMAS', title: 'Easy 12km', planned_date: '2026-11-13', session_type: 'Easy Effort' });
const DUP = addSession({ id: randomUUID(), athlete_code: 'THOMAS', title: '6 x 1 km', planned_date: '2026-11-15', session_type: 'Speed' });
const BRICK = addSession({ id: randomUUID(), athlete_code: 'THOMAS', title: 'Brick', planned_date: '2026-11-14', session_type: 'Brick' });

// ── Browser ─────────────────────────────────────────────────────────────────
const results = [];
const check = (ok, name, detail = '') => { results.push({ ok: !!ok, name, detail }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

const browser = await chromium.launch();
async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('dp_dashboard_key', 'preview'); sessionStorage.setItem('dp_dashboard_coach', 'KARL'); } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
  const posts = [];
  await page.route('**/api/athletes**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    try {
      if (req.method() === 'GET' && url.searchParams.get('action') === 'prescription') {
        const data = await P.readPrescription(url.searchParams.get('session_id'), sb);
        return route.fulfill({ json: { ok: true, ...data } });
      }
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        posts.push(body);
        if (body.action === 'runsteps_save') return route.fulfill({ json: await P.saveRunSteps(body, sb, COACH) });
        if (body.action === 'session_publish') return route.fulfill({ json: await P.setPublishState(body, sb, COACH) });
      }
    } catch (error) {
      return route.fulfill({ status: error.status || 500, json: { ok: false, error: error.message } });
    }
    return route.fallback();
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.DP_PROGRAMMING && window.DPRunBuilder && window.DPRunWorkout && typeof window.maPost === 'function');
  return { page, errors, posts, ctx };
}
async function openSession(page, id) {
  await page.evaluate((sid) => window.DP_PROGRAMMING.open(sid), id);
  await page.waitForSelector('#rx-overlay:not(.hidden) #rb', { timeout: 5000 });
}
const text = (page, sel) => page.$eval(sel, (n) => n.textContent).catch(() => '');

// ── Desktop flow ────────────────────────────────────────────────────────────
{
  const { page, errors, posts } = await newPage({ width: 1280, height: 900 });
  await openSession(page, LEGACY.id);
  check(/This run is a text prescription/.test(await text(page, '#rb')), 'legacy run opens on the explicit convert step');
  check(/6 × 1 km/.test(await text(page, '.rb-legacy')), 'legacy text shown for reference');
  check(await page.$eval('#rx-scopebar', (n) => n.style.display === 'none'), 'edit-scope bar hidden for runs');
  await page.screenshot({ path: OUT + '/1-legacy-convert-desktop.png' });

  await page.click('[data-act-global="convert"]');
  check((await page.$$('.rb-step')).length === 0 && /No steps yet/.test(await text(page, '#rb-steps')), 'conversion starts empty — nothing inferred from the text');
  await page.click('[data-quick="intervals"]');
  const counts = await page.$$eval('[data-step]', (n) => n.length);
  check(counts === 5, 'quick start builds warm-up, repeat(interval, recovery), cool-down', String(counts));
  check(/Not Garmin-compatible yet/.test(await text(page, '#rb-status')), 'empty pace target is flagged before saving');
  check(/needs a pace/.test(await text(page, '.rb-step.is-interval .rb-step-errors')), 'the error sits under its step');

  await page.fill('.rb-step.is-interval [data-k="pace_fast"]', '4:30');
  await page.fill('.rb-step.is-interval [data-k="pace_slow"]', '4:45');
  check(/Garmin-compatible · unsaved changes/.test(await text(page, '#rb-status')), 'status becomes compatible once fixed');
  check(/14 \/ 100 Garmin steps/.test(await text(page, '#rb-preview')), 'preview counts expanded steps', await text(page, '.rb-meter'));
  check(/6 km/.test(await text(page, '.rb-total')) && /29 min/.test(await text(page, '.rb-total')), 'preview totals 6 km + 29 min', await text(page, '.rb-total'));
  await page.fill('.rb-step.is-interval [data-k="instructions"]', 'Smooth, tall posture');
  await page.click('.rb-step.is-interval .rb-coach summary');
  await page.fill('.rb-step.is-interval [data-k="coach_notes"]', 'COACH-ONLY: watch her left knee');
  check(/Review & publish structured version/.test(await text(page, '[data-act-global="save"]')), 'published legacy session asks for review before publishing');
  await page.screenshot({ path: OUT + '/2-builder-desktop.png', fullPage: false });

  // Athlete preview never shows the coach note.
  await page.click('#rx-preview-btn');
  const athleteView = await text(page, '#rx-body');
  check(/Repeat 6 times/.test(athleteView) && /Smooth, tall posture/.test(athleteView) && !/COACH-ONLY/.test(athleteView), 'athlete preview: steps + instructions, no coach note');
  await page.screenshot({ path: OUT + '/3-athlete-preview-desktop.png' });
  await page.click('#rx-preview-btn');
  check(await page.inputValue('.rb-step.is-interval [data-k="pace_fast"]') === '4:30', 'typed values survive the preview toggle');

  page.__dialogs = [];
  await page.click('[data-act-global="save"]');
  await page.waitForFunction(() => /All changes saved/.test(document.querySelector('#rb-savebar')?.textContent || ''));
  check(page.__dialogs.some((m) => /Publish the structured version/.test(m) && /replaced with text written from the steps/.test(m)), 'conversion confirm says the card text is replaced', page.__dialogs.join(' | '));
  check(db.rpcCalls === 1 && db.directStepWrites === 0, 'one transactional call, no direct run_steps writes');
  check(db.steps.filter((r) => r.planned_session_id === LEGACY.id).length === 5, 'five rows stored');
  check(LEGACY.prescription_mode === 'structured' && LEGACY.publish_state === 'published', 'session now structured + published');
  check(LEGACY.intervals === '6 × 1 km' && LEGACY.working_pace === '4:30–4:45 /km' && LEGACY.rest !== '90s jog' && /10 min/.test(LEGACY.warm_up || ''),
    'drawer save writes the athlete-card text from the steps (portal card and Garmin match)', JSON.stringify([LEGACY.warm_up, LEGACY.intervals, LEGACY.working_pace, LEGACY.rest, LEGACY.cool_down]));

  // Reload from the server and edit.
  await page.click('#rx-close-btn');
  await openSession(page, LEGACY.id);
  check((await page.$$('[data-step]')).length === 5 && await page.inputValue('.rb-step.is-interval [data-k="pace_slow"]') === '4:45', 'reload shows the saved workout');
  check(/Garmin-compatible · published/.test(await text(page, '#rb-status')), 'published status after reload');
  check(/Save & update athlete/.test(await text(page, '[data-act-global="save"]')), 'published structured run: Save & update athlete');

  await page.fill('.rb-repeat [data-k="repeat_count"]', '8');
  check(/18 \/ 100/.test(await text(page, '.rb-meter')), 'repeat count edit updates the count');
  // Reorder: move cool-down above the repeat and back.
  const topOrder = () => page.$$eval('#rb-steps > [data-step]', (n) => n.map((e) => e.classList.contains('rb-repeat') ? 'repeat' : e.className.match(/is-(\w+)/g).pop()));
  await page.click('#rb-steps > .rb-step.is-cooldown [data-act="up"]');
  check(JSON.stringify(await topOrder()) === JSON.stringify(['is-warmup', 'is-cooldown', 'repeat']), 'move up reorders', JSON.stringify(await topOrder()));
  await page.click('#rb-steps > .rb-step.is-cooldown [data-act="down"]');
  check(JSON.stringify(await topOrder()) === JSON.stringify(['is-warmup', 'repeat', 'is-cooldown']), 'move down restores', JSON.stringify(await topOrder()));

  // Change a step's end to lap button, and type.
  await page.selectOption('.rb-step.is-cooldown [data-k="end"]', 'lap');
  check(/until lap button/.test(await text(page, '.rb-step.is-cooldown [data-summary]')), 'lap-button end is explicit');
  // Introduce errors: blank interval distance and HR zone missing.
  await page.fill('.rb-step.is-interval [data-k="distance_km"]', '');
  await page.selectOption('.rb-step.is-recovery [data-k="target"]', 'hr');
  const status = await text(page, '#rb-status');
  check(/2 things to fix/.test(status), 'two plain-language issues listed', status.split('\n').slice(0, 4).join(' / '));
  await page.screenshot({ path: OUT + '/4-errors-desktop.png' });
  const before = db.rpcCalls;
  await page.click('[data-act-global="save"]');
  await page.waitForTimeout(300);
  check(db.rpcCalls === before, 'invalid workout is not sent to the server');
  // Fix and save.
  await page.fill('.rb-step.is-interval [data-k="distance_km"]', '1');
  await page.selectOption('.rb-step.is-recovery [data-k="hr_zone"]', '1');
  // Remove the warm-up.
  await page.click('#rb-steps > .rb-step.is-warmup [data-act="remove"]');
  await page.click('[data-act-global="save"]');
  await page.waitForFunction(() => /All changes saved/.test(document.querySelector('#rb-savebar')?.textContent || ''));
  const saved = db.steps.filter((r) => r.planned_session_id === LEGACY.id);
  const rep = saved.find((r) => r.step_type === 'repeat');
  check(saved.length === 4 && rep.repeat_count === 8 && saved.find((r) => r.step_type === 'recovery').hr_zone === 'Z1' && saved.find((r) => r.step_type === 'cooldown').duration_sec === null, 'edit, remove and lap-button change persisted');
  check(saved.filter((r) => !r.parent_step_id).map((r) => `${r.step_order}:${r.step_type}`).join(',') === '0:repeat,1:cooldown', 'order persisted per sibling');

  // Close with unsaved edits asks first.
  await page.fill('.rb-step.is-interval [data-k="instructions"]', 'changed');
  page.__dialogs = [];
  await page.click('#rx-close-btn');
  check(page.__dialogs.some((m) => /unsaved changes/.test(m)), 'closing with unsaved edits asks first');
  check(errors.length === 0, 'desktop: zero console errors', errors.join(' | '));
}

// ── Draft continuous run: build, save draft, publish from footer ────────────
{
  const { page, errors, posts } = await newPage({ width: 1280, height: 900 });
  await openSession(page, DRAFT.id);
  check(/This run is a text prescription/.test(await text(page, '#rb')) || /No steps yet/.test(await text(page, '#rb')), 'draft opens');
  if (await page.$('[data-act-global="convert"]')) await page.click('[data-act-global="convert"]');
  await page.click('[data-quick="run"]');
  await page.fill('.rb-step [data-k="distance_km"]', '12');
  await page.selectOption('.rb-step [data-k="target"]', 'hr');
  await page.selectOption('.rb-step [data-k="hr_zone"]', '2');
  check(/Save draft steps/.test(await text(page, '[data-act-global="save"]')), 'draft: Save draft steps');
  await page.click('[data-act-global="save"]');
  await page.waitForFunction(() => /All changes saved/.test(document.querySelector('#rb-savebar')?.textContent || ''));
  check(DRAFT.publish_state === 'draft' && DRAFT.prescription_mode === 'structured', 'saved as draft, still hidden');
  check(/draft, hidden from the athlete/.test(await text(page, '#rb-status')), 'status says draft');
  page.__dialogs = [];
  await page.click('#rx-publish-btn');
  await page.waitForFunction(() => /Published/.test(document.querySelector('#rx-foot')?.textContent || ''));
  check(DRAFT.publish_state === 'published', 'footer publish → published');
  check(posts.some((b) => b.action === 'session_publish'), 'clean draft publishes through session_publish (server re-validates)');
  check(/Garmin-compatible · published/.test(await text(page, '.rb-status-title')) && !/sent/i.test(await text(page, '.rb-status-title')) && /not on their watch until they do/.test(await text(page, '#rb-status')), 'published ≠ sent: status says compatible, not sent', await text(page, '.rb-status-title'));
  check(errors.length === 0, 'draft flow: zero console errors', errors.join(' | '));

  // Receipt: athlete has sent it, coach edits → changed-since warning.
  db.receipts.push({ planned_session_id: DRAFT.id, state: 'sent', scheduled_date: DRAFT.planned_date, sent_at: new Date(Date.now() - 60000).toISOString(), updated_at: new Date(Date.now() - 60000).toISOString() });
  DRAFT.updated_at = new Date(Date.now() - 120000).toISOString();
  db.steps.forEach((r) => { if (r.planned_session_id === DRAFT.id) { r.created_at = r.updated_at = DRAFT.updated_at; } });
  await page.click('#rx-close-btn');
  await openSession(page, DRAFT.id);
  const st = await text(page, '#rb-status');
  check(/Athlete sent this to Garmin Connect/.test(st) && /not the watch/.test(st) && !/not on Garmin/.test(st), 'real receipt shown, scoped to Garmin Connect');
  await page.fill('.rb-step [data-k="distance_km"]', '14');
  check(/Changes since then are not on Garmin/.test(await text(page, '#rb-status')), 'unsaved edit after a send warns the athlete must resend');
  await page.screenshot({ path: OUT + '/5-sent-receipt-desktop.png' });
}

// ── Duplicate steps and repeat blocks; athlete's own move ───────────────────
{
  const { page, errors } = await newPage({ width: 1280, height: 900 });
  await openSession(page, DUP.id);
  if (await page.$('[data-act-global="convert"]')) await page.click('[data-act-global="convert"]');
  await page.click('[data-quick="intervals"]');
  await page.fill('.rb-step.is-interval [data-k="pace_fast"]', '4:30');
  await page.fill('.rb-step.is-interval [data-k="pace_slow"]', '4:45');
  check(/14 \/ 100/.test(await text(page, '.rb-meter')), 'fixture built: 14 Garmin steps');

  // Duplicate the recovery inside the repeat: a third step lands straight after it.
  await page.click('.rb-repeat .rb-step.is-recovery [data-act="duplicate"]');
  const inside = await page.$$eval('.rb-repeat > .rb-children > .rb-step', (n) => n.map((e) => [...e.classList].find((c) => c.startsWith('is-') && c !== 'is-child')));
  check(JSON.stringify(inside) === '["is-interval","is-recovery","is-recovery"]', 'duplicate step lands after the original, inside the repeat', JSON.stringify(inside));
  check(/20 \/ 100/.test(await text(page, '.rb-meter')), 'duplicated step counts 6 more Garmin steps', await text(page, '.rb-meter'));
  const copies = await page.$$('.rb-repeat > .rb-children > .rb-step.is-recovery [data-act="remove"]');
  await copies[copies.length - 1].click();
  check((await page.$$eval('.rb-repeat > .rb-children > .rb-step', (n) => n.length)) === 2, 'remove takes the copy away again');

  // Duplicate the whole repeat block: children copied with it, placed after it.
  await page.click('.rb-repeat > .rb-step-head [data-act="duplicate"]');
  const top = await page.$$eval('#rb-steps > [data-step]', (n) => n.map((e) => e.classList.contains('rb-repeat') ? 'repeat' : [...e.classList].find((c) => c.startsWith('is-'))));
  check(JSON.stringify(top) === '["is-warmup","repeat","repeat","is-cooldown"]', 'duplicate repeat block lands after the original', JSON.stringify(top));
  const kids = await page.$$eval('.rb-repeat', (n) => n.map((r) => r.querySelectorAll(':scope > .rb-children > .rb-step').length));
  check(JSON.stringify(kids) === '[2,2]', 'the copy carries its interval and recovery', JSON.stringify(kids));
  check(/26 \/ 100/.test(await text(page, '.rb-meter')), 'two blocks: 26 Garmin steps', await text(page, '.rb-meter'));
  await page.screenshot({ path: OUT + '/10-duplicate-desktop.png' });

  await page.click('[data-act-global="save"]');
  await page.waitForFunction(() => /All changes saved/.test(document.querySelector('#rb-savebar')?.textContent || ''), null, { timeout: 8000 })
    .catch(async () => { console.log('SAVEBAR: ' + await text(page, '#rb-savebar') + ' | STATUS: ' + await text(page, '#rb-status')); });
  const stored = db.steps.filter((r) => r.planned_session_id === DUP.id);
  const repeats = stored.filter((r) => r.step_type === 'repeat');
  check(stored.length === 8 && repeats.length === 2 && new Set(stored.map((r) => r.id)).size === 8, 'duplicate saved with its own ids', `${stored.length} rows`);
  check(repeats.every((rep) => stored.filter((r) => r.parent_step_id === rep.id).length === 2), 'each saved repeat owns its own two steps');

  // The athlete moved this run to Sunday in the portal and sent it from there.
  db.moves = { [DUP.id]: '2026-11-16' };
  db.receipts.push({ planned_session_id: DUP.id, state: 'sent', scheduled_date: '2026-11-16', sent_at: new Date(Date.now() + 60000).toISOString(), updated_at: new Date(Date.now() + 60000).toISOString() });
  await page.click('#rx-close-btn');
  await openSession(page, DUP.id);
  let st = await text(page, '#rb-status');
  check(/moved this run to/.test(st) && !/no longer matches/.test(st), 'athlete’s own move is context, not a date warning', st.slice(0, 200));
  // Coach changes the planned date after the send → Garmin date is stale.
  db.moves = null; DUP.planned_date = '2026-11-17';
  await page.click('#rx-close-btn');
  await openSession(page, DUP.id);
  st = await text(page, '#rb-status');
  check(/no longer matches/.test(st) && /send it again/.test(st), 'coach date change after a send asks for a re-send', st.slice(0, 220));
  await page.screenshot({ path: OUT + '/11-date-changed-desktop.png' });
  check(errors.length === 0, 'duplicate + date flow: zero console errors', errors.join(' | '));
}

// ── Mobile ──────────────────────────────────────────────────────────────────
{
  const { page, errors } = await newPage({ width: 390, height: 844 });
  await openSession(page, LEGACY.id);
  await page.screenshot({ path: OUT + '/6-builder-mobile-top.png' });
  const overflow = await page.evaluate(() => {
    const panel = document.querySelector('.rx-body');
    return { scrollW: panel.scrollWidth, clientW: panel.clientWidth, docW: document.documentElement.scrollWidth };
  });
  check(overflow.scrollW <= overflow.clientW + 1, 'mobile: no horizontal overflow in the drawer', JSON.stringify(overflow));
  await page.$eval('.rb-repeat', (n) => n.scrollIntoView());
  await page.screenshot({ path: OUT + '/7-builder-mobile-repeat.png' });
  await page.$eval('#rb-preview', (n) => n.scrollIntoView());
  await page.screenshot({ path: OUT + '/8-builder-mobile-preview.png' });
  await page.click('.rb-repeat .rb-step.is-interval [data-act="duplicate"]');
  check((await page.$$eval('.rb-repeat > .rb-children > .rb-step', (n) => n.length)) === 3, 'mobile: duplicate works by tap');
  const mobileOverflow = await page.evaluate(() => { const p = document.querySelector('.rx-body'); return p.scrollWidth - p.clientWidth; });
  check(mobileOverflow <= 1, 'mobile: four step tools still fit without horizontal scroll', String(mobileOverflow));
  await page.$eval('.rb-repeat', (n) => n.scrollIntoView());
  await page.screenshot({ path: OUT + '/7b-duplicate-mobile.png' });
  const small = await page.$$eval('.rb button, .rb select, .rb input', (n) => n.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 30).map((e) => e.outerHTML.slice(0, 60)));
  check(small.length === 0, 'mobile: controls at least 30px tall', small.slice(0, 3).join(' | '));

  await page.evaluate((sid) => window.DP_PROGRAMMING.open(sid), BRICK.id);
  await page.waitForFunction(() => !/Loading prescription/.test(document.querySelector('#rx-body')?.innerText || 'Loading prescription'));
  // Brick is not a running type: the builder still opens (as before), and the
  // status says plainly that the portal will not offer Send to Garmin.
  if (await page.$('[data-act-global="convert"]')) await page.click('[data-act-global="convert"]');
  await page.click('[data-quick="run"]');
  check(/Brick” is not a running type/.test(await text(page, '#rb-status')), 'Brick: steps allowed, Send to Garmin blocker explained');
  await page.screenshot({ path: OUT + '/9-brick-blocker-mobile.png' });
  check(errors.length === 0, 'mobile: zero console errors', errors.join(' | '));
}

await browser.close();
writeFileSync(OUT + '/results.json', JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
