// Drives the Today command-centre workflow end to end against the preview
// fixture. Unit tests cover the queue model; this covers what only a browser
// can: that a coach can open the next item, act on it, mark it done and carry
// on without returning to the dashboard, at phone and desktop sizes, by
// keyboard, and that partial failures leave the rest of the screen working.
//
//   node scripts/serve-preview.mjs &
//   node scripts/verify-command-centre.mjs
//
// Prints one PASS/FAIL line per check and exits non-zero on any failure.
// Screenshots go to .verify-out/command-centre/.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PREVIEW_URL || 'http://localhost:4173';
const OUT = (process.env.VERIFY_OUT || '.verify-out') + '/command-centre';
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).slice(0, 160)}` : ''}`);
};

const scenario = name => fetch(`${BASE}/__preview/scenario?name=${name}`).then(r => r.json());

async function open(browser, { width, height, theme = 'dark' }) {
  const mobile = width < 500;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(t => {
    try {
      sessionStorage.setItem('dp_dashboard_key', 'preview');
      sessionStorage.setItem('dp_dashboard_coach', 'KARL');
      localStorage.setItem('dp_coach', 'KARL');
      localStorage.setItem('dp_theme', t);
    } catch {}
  }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/simulated failure|status of 500/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(t => window.setTheme?.(t), theme);
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

const browser = await chromium.launch();

// ── 1. Mobile first screen ───────────────────────────────────────────────────
await scenario('default');
{
  const { ctx, page, errors } = await open(browser, { width: 390, height: 844 });
  const first = await page.evaluate(() => {
    const row = document.querySelector('#triage-queue .cq-row');
    const nav = document.querySelector('.dp-mobilenav')?.getBoundingClientRect();
    const r = row?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('#triage-queue .cq-row')]
      .filter(el => el.getBoundingClientRect().top < (nav?.top || innerHeight)).length;
    const start = document.querySelector('[data-focus-start="queue"]').getBoundingClientRect();
    return { top: r?.top, bottom: r?.bottom, navTop: nav?.top, rows, startVisible: start.bottom < (nav?.top || innerHeight) };
  });
  check('390x844: first actionable athlete fully visible without scrolling', first.bottom && first.bottom < first.navTop, JSON.stringify(first));
  check('390x844: at least two priority rows start above the nav', first.rows >= 2, `${first.rows} rows`);
  check('390x844: Start review visible on first screen', first.startVisible);
  const pulse = await page.evaluate(() => document.getElementById('pulse-toggle').getAttribute('aria-expanded'));
  check('390x844: squad pulse collapsed by default', pulse === 'false');
  const targets = await page.evaluate(() => [...document.querySelectorAll('.dp-mnav-item, #triage-queue .triage-action, .cq-filter, .cq-start')]
    .filter(el => el.offsetParent)
    .map(el => { const r = el.getBoundingClientRect(); return { h: r.height, w: r.width, t: el.textContent.trim().slice(0, 20) }; })
    .filter(r => r.h < 44 || r.w < 44));
  check('390x844: nav, filters and queue actions are at least 44px', !targets.length, JSON.stringify(targets));
  const hscroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('390x844: no horizontal page scroll on Today', hscroll <= 0, `${hscroll}px`);
  await page.screenshot({ path: `${OUT}/today-mobile.png` });

  // Squad list rows on a phone.
  await page.evaluate(() => switchTab('athletes'));
  await page.waitForTimeout(900);
  const squad = await page.evaluate(() => {
    const nav = document.querySelector('.dp-mobilenav').getBoundingClientRect().top;
    return [...document.querySelectorAll('.sq-row')].filter(r => r.getBoundingClientRect().bottom <= nav).length;
  });
  check('390x844: Squad shows at least three compact rows', squad >= 3, `${squad} rows`);
  const tableHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.dash-table-wrap')).display === 'none');
  check('390x844: desktop table is not reproduced on the phone', tableHidden);
  const statuses = await page.evaluate(() => [...document.querySelectorAll('.sq-row')].map(r => r.querySelector('.sq-row-name').textContent + ':' + r.querySelector('.sq-status').textContent.trim()));
  check('Squad: athlete with an open urgent signal is never On track', statuses.some(s => /^Kai Tran:Urgent/.test(s)), statuses.join(', '));
  check('Squad: athlete with only a review pending reads Review due', statuses.some(s => /^James Okafor:Review due/.test(s)), statuses.join(', '));
  await page.screenshot({ path: `${OUT}/squad-mobile.png` });

  // Athlete workspace on a phone.
  await page.evaluate(() => showFP('KAI'));
  await page.waitForTimeout(900);
  const ws = await page.evaluate(() => {
    const actions = [...document.querySelectorAll('.fpa-head-actions .fpa-act')].map(b => ({ t: b.textContent.trim(), vis: b.getBoundingClientRect().bottom < innerHeight && b.getBoundingClientRect().height >= 44 }));
    const tabs = document.querySelector('.fpa-tabs').getBoundingClientRect();
    return { actions, tabsTop: tabs.top, cue: document.querySelector('.fpa-tabs-wrap').className };
  });
  check('390x844: Message, Review and Adjust plan visible and 44px', ws.actions.slice(0, 3).every(a => a.vis) && /Message/.test(ws.actions[0]?.t), JSON.stringify(ws.actions));
  check('390x844: athlete tabs start within the first screen', ws.tabsTop < 844 * 0.75, `${Math.round(ws.tabsTop)}px`);
  check('390x844: tab strip shows a scroll cue when tabs overflow', /can-scroll-right/.test(ws.cue), ws.cue);
  await page.screenshot({ path: `${OUT}/athlete-mobile.png` });
  check('mobile pass: no console errors', !errors.length, errors.join(' | '));
  await ctx.close();
}

// ── 2. Desktop: queue in first viewport, Focus Mode through several items ────
await scenario('default');
{
  const { ctx, page, errors } = await open(browser, { width: 1440, height: 900 });
  const q = await page.evaluate(() => document.querySelector('#triage-queue .cq-row').getBoundingClientRect().top);
  check('1440x900: decision queue in the initial viewport', q < 500, `${Math.round(q)}px`);

  // Review work appears once: no athlete in two places of the main column.
  const dup = await page.evaluate(() => {
    const names = [...document.querySelectorAll('#triage-queue .cq-row-name')].map(n => n.textContent.trim());
    return names.length - new Set(names).size;
  });
  check('one row per athlete in the queue', dup === 0);
  const railList = await page.evaluate(() => document.querySelectorAll('#review-queue li').length);
  check('the rail summarises review work rather than listing it again', railList === 0);

  // Filters: counts sum to All.
  const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.cq-filter')].map(b => [b.dataset.queueFilter, Number(b.querySelector('.cq-filter-count').textContent)])));
  check('filter counts add up to All', counts.urgent + counts.review + counts.followup + counts.plan === counts.all, JSON.stringify(counts));
  check('Today tab badge equals the queue count', await page.evaluate(() => document.getElementById('tab-triage-count').textContent.trim()) === String(counts.all));

  await page.click('[data-focus-start="queue"]');
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => ({ open: !document.getElementById('cq-focus').hidden, active: document.activeElement?.id, title: document.getElementById('cq-focus-title')?.textContent }));
  check('Start review opens Focus Mode with focus on the item heading', opened.open && opened.active === 'cq-focus-title', JSON.stringify(opened));
  await page.screenshot({ path: `${OUT}/focus-desktop.png` });

  // Opening the profile from Focus Mode and coming back resumes the same item.
  const here = await page.evaluate(() => document.getElementById('cq-focus-title')?.textContent);
  if (await page.$('[data-focus-action]')) {
    await page.click('[data-focus-action]');
    await page.waitForTimeout(700);
    const away = await page.evaluate(() => ({ fp: document.getElementById('fp-overlay').getAttribute('aria-hidden'), focus: document.getElementById('cq-focus').hidden }));
    await page.evaluate(() => hideFP());
    await page.waitForTimeout(500);
    const back = await page.evaluate(() => ({ open: !document.getElementById('cq-focus').hidden, title: document.getElementById('cq-focus-title')?.textContent }));
    check('leaving for the athlete profile and closing it resumes Focus Mode on the same item',
      away.fp === 'false' && away.focus && back.open && back.title === here, JSON.stringify({ here, away, back }));
  }

  const walked = [];
  const completed = [];
  for (let i = 0; i < 4; i += 1) {
    const before = await page.evaluate(() => document.getElementById('cq-focus-title')?.textContent);
    const item = await page.evaluate(name => { const it = DP_TRIAGE.model().items.find(x => x.name === name); return it && { code: it.code, signal: it.primary.id }; }, before);
    if (item) completed.push(item);
    const label = await page.evaluate(() => document.querySelector('[data-focus-complete]')?.textContent.trim());
    if (!label) break;
    await page.click('[data-focus-complete]');
    await page.waitForTimeout(700);
    const done = await page.evaluate(() => ({ title: document.getElementById('cq-focus-title')?.textContent, active: document.activeElement?.textContent?.trim().slice(0, 40) }));
    walked.push(`${before} → ${label} → ${done.title}`);
    if (i === 0) {
      check('completing an item shows a confirmation with focus on Next', /resolved|reviewed|read/.test(done.title) && /^Next|Finish/.test(done.active), JSON.stringify(done));
      await page.screenshot({ path: `${OUT}/focus-done.png` });
    }
    await page.click('[data-focus-next]');
    await page.waitForTimeout(400);
  }
  check('Focus Mode completes several consecutive items without leaving it', walked.length >= 3, walked.join(' | '));
  // A completed signal is gone; the athlete stays only if something else is
  // still open for them (Focus Mode says so on the confirmation screen).
  const lingering = await page.evaluate(done => done.filter(d => {
    const it = DP_TRIAGE.itemFor(d.code);
    return it && it.signals.some(s => s.id === d.signal);
  }), completed);
  check('every completed signal leaves the queue', !lingering.length, JSON.stringify(lingering));

  // Skip moves on without completing.
  const beforeSkip = await page.evaluate(() => document.getElementById('cq-focus-title')?.textContent);
  if (await page.$('[data-focus-skip]')) {
    await page.click('[data-focus-skip]');
    await page.waitForTimeout(300);
    const afterSkip = await page.evaluate(() => document.getElementById('cq-focus-title')?.textContent);
    check('Skip advances without resolving', afterSkip !== beforeSkip, `${beforeSkip} → ${afterSkip}`);
  }

  // Escape closes and returns focus to the entry point.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => ({ hidden: document.getElementById('cq-focus').hidden, focus: document.activeElement?.dataset?.focusStart || document.activeElement?.className }));
  check('Escape closes Focus Mode and returns focus to Start review', closed.hidden && closed.focus === 'queue', JSON.stringify(closed));

  // Resolved filter and reopen.
  await page.click('.cq-filter[data-queue-filter="resolved"]');
  await page.waitForTimeout(200);
  const resolvedRows = await page.evaluate(() => document.querySelectorAll('#triage-resolved .triage-resolved-row').length);
  check('Resolved filter lists resolved rows with Reopen', resolvedRows >= 1, `${resolvedRows} rows`);
  await page.click('.cq-filter[data-queue-filter="all"]');

  // Keyboard-only: tab from the skip link to the first queue action.
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => !!document.activeElement?.closest('#triage-queue') || document.activeElement?.dataset?.focusStart === 'queue');
  }
  check('keyboard reaches the queue from the top of the page', reached);
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check('focused control shows a visible focus outline', ring && ring !== 'none', ring);

  // Squad desktop: seven decision columns, secondary metrics in the expansion.
  await page.evaluate(() => switchTab('athletes'));
  await page.waitForTimeout(800);
  const cols = await page.evaluate(() => [...document.querySelectorAll('.sq-table thead th')].map(th => th.textContent.replace(/[↕▲▼]/g, '').trim()));
  check('Squad table shows the seven decision columns', cols.join('|') === 'Athlete|Status|Recovery|Adherence|Last activity|Last check-in|Next action', cols.join('|'));
  await page.click('.sq-name');
  await page.waitForTimeout(300);
  const expanded = await page.evaluate(() => [...document.querySelectorAll('.trow-expand[style*="table-row"] .texp-block-title')].map(h => h.textContent.trim()));
  check('expanded row is structured: alerts, sessions, wellness, coach actions', ['Current alerts', 'This week’s sessions', 'Recent wellness', 'Coach actions'].every(t => expanded.includes(t)), expanded.join(', '));
  await page.screenshot({ path: `${OUT}/squad-desktop.png` });
  check('desktop pass: no console errors', !errors.length, errors.join(' | '));
  await ctx.close();
}

// ── 3. Empty, partial failure, offline-ish states ────────────────────────────
await scenario('empty');
{
  const { ctx, page } = await open(browser, { width: 1440, height: 900 });
  // The empty fixture clears every server signal and message; the dashboard's
  // own client alerts are cleared here so the all-clear state itself renders.
  await page.click('.cq-filter[data-queue-filter="urgent"]');
  const filtered = await page.evaluate(() => document.getElementById('triage-clear')?.innerText || '');
  check('an empty filter says so and offers Show all', /No urgent items/.test(filtered) && /Show all/.test(filtered), filtered);
  await page.click('.cq-filter[data-queue-filter="all"]');
  await page.evaluate(() => { DP_TRIAGE.setClientSignals([]); DP_TRIAGE.setMessages([]); });
  const empty = await page.evaluate(() => document.getElementById('triage-clear')?.innerText || '');
  check('no priority items: an all-clear state, not a blank list', /Nobody needs you right now/.test(empty), empty);
  const startDisabled = await page.evaluate(() => document.querySelector('[data-focus-start="queue"]').disabled);
  check('Start review is disabled when there is nothing to review', startDisabled);
  const backlog = await page.evaluate(() => document.getElementById('review-queue').innerText);
  check('no sessions to review: the backlog says so', /No sessions need review/.test(backlog), backlog.slice(0, 80));
  await page.screenshot({ path: `${OUT}/today-empty.png` });
  await ctx.close();
}
await scenario('triage-fail');
{
  const { ctx, page } = await open(browser, { width: 1440, height: 900 });
  const state = await page.evaluate(() => ({
    error: !document.getElementById('triage-error').hidden,
    message: document.getElementById('triage-error-message').textContent,
    retry: !!document.querySelector('#triage-error [data-triage-retry]'),
    pulse: document.querySelectorAll('.squad-vital').length,
    rail: document.getElementById('athlete-messages').innerText.length > 20,
  }));
  check('triage failure names what failed and offers Retry', state.error && state.retry && /queue/.test(state.message), JSON.stringify(state));
  check('triage failure leaves squad pulse and the rail working', state.pulse === 6 && state.rail, JSON.stringify(state));
  await page.screenshot({ path: `${OUT}/today-triage-failed.png` });
  await ctx.close();
}
await scenario('coach-data-fail');
{
  const { ctx, page } = await open(browser, { width: 1440, height: 900 });
  const state = await page.evaluate(() => ({
    queue: document.querySelectorAll('#triage-queue .cq-row').length,
    pulseWarning: document.querySelector('.pulse-warning')?.textContent || '',
    banner: document.getElementById('stale-banner').hidden ? '' : document.getElementById('stale-banner').textContent,
  }));
  check('athlete-data failure keeps the decision queue usable', state.queue > 0, JSON.stringify(state));
  check('athlete-data failure is reported where the numbers are', /could not load/i.test(state.pulseWarning) && /could not be loaded/.test(state.banner), JSON.stringify(state));
  await ctx.close();
}
await scenario('long-notes');
{
  const { ctx, page } = await open(browser, { width: 390, height: 844 });
  await page.evaluate(() => { showFP('KAI'); switchAthleteTab('training'); });
  await page.waitForTimeout(900);
  const notes = await page.evaluate(() => [...document.querySelectorAll('#fp-body .dp-note-clamp')].map(n => ({ h: n.getBoundingClientRect().height, btn: n.nextElementSibling?.textContent })));
  check('long athlete notes are clamped with Read full note', notes.length > 0 && notes.every(n => n.h < 90 && n.btn === 'Read full note'), JSON.stringify(notes.slice(0, 3)));
  await page.screenshot({ path: `${OUT}/long-notes-mobile.png` });
  await ctx.close();
}
await scenario('default');

// ── 4. Light theme and the other widths render without page scroll ──────────
for (const [w, h] of [[768, 1024], [1654, 992]]) {
  for (const theme of ['dark', 'light']) {
    const { ctx, page, errors } = await open(browser, { width: w, height: h, theme });
    const hscroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`${w}x${h} ${theme}: no horizontal page scroll`, hscroll <= 0, `${hscroll}px`);
    await page.screenshot({ path: `${OUT}/today-${w}-${theme}.png` });
    check(`${w}x${h} ${theme}: no console errors`, !errors.length, errors.join(' | '));
    await ctx.close();
  }
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
