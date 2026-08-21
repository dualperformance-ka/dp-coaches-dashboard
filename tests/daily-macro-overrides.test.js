import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import myLogsHandler, {
  loadPublishedMacroOverrides,
  publishedMacroOverrideContract,
} from '../api/my-logs.js';
import {
  removeDailyMacroOverride,
  saveDailyMacroOverride,
  saveDailyMacroOverrideRange,
} from '../server/daily-macro-overrides.js';

const ATHLETE = 'JORDAN';
const OTHER = 'NATE';
const WEEK_ID = '11111111-1111-4111-8111-111111111111';
const PROGRAMME_ID = '22222222-2222-4222-8222-222222222222';
const COACH_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN = { id: COACH_ID, handle: 'KARL', role: 'admin' };

function overrideDb(options = {}) {
  const rows = [];
  const writes = [];
  const sb = async (path, request = {}) => {
    if (path.startsWith('athlete_programme_weeks?id=')) {
      return options.missingWeek ? [] : [{
        id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 4,
        week_label: 'Week 4', start_date: options.startDate === undefined ? '2026-08-17' : options.startDate,
      }];
    }
    if (path.startsWith('athlete_programmes?id=')) {
      return [{ id: PROGRAMME_ID, athlete_code: options.owner || ATHLETE, status: 'active' }];
    }
    if (path.startsWith('daily_macro_overrides?athlete_code=') && request.method === 'PATCH') {
      const date = decodeURIComponent(path.match(/override_date=eq\.([^&]+)/)[1]);
      const row = rows.find((item) => item.override_date === date);
      if (!row) return [];
      Object.assign(row, request.body, { updated_at: '2026-08-18T03:00:00.000Z' });
      writes.push({ path, request });
      return [{ ...row }];
    }
    if (path.startsWith('daily_macro_overrides?athlete_code=') && path.includes('override_date=in.')) {
      return rows.map((row) => ({ ...row }));
    }
    if (path.startsWith('daily_macro_overrides?on_conflict=')) {
      const saved = request.body.map((input, index) => {
        let row = rows.find((item) => item.override_date === input.override_date);
        if (!row) {
          row = { id: `44444444-4444-4444-8444-44444444444${index}`, created_at: '2026-08-18T01:00:00.000Z' };
          rows.push(row);
        }
        Object.assign(row, input, { updated_at: '2026-08-18T02:00:00.000Z' });
        return { ...row };
      });
      writes.push({ path, request });
      return saved;
    }
    return [];
  };
  return { rows, writes, sb };
}

function input(overrides = {}) {
  return {
    athlete_code: ATHLETE,
    programme_week_id: WEEK_ID,
    override_date: '2026-08-22',
    calories: 3200,
    protein_g: 180,
    carbs_g: 430,
    fats_g: 80,
    fibre_g: 35,
    day_label: 'Long run',
    coach_note: 'Fuel early',
    publish_state: 'draft',
    ...overrides,
  };
}

test('draft save remains unpublished', async () => {
  const db = overrideDb();
  const result = await saveDailyMacroOverride(input(), db.sb, ADMIN);
  assert.equal(result.override.state, 'draft');
  assert.equal(result.override.publishedAt, null);
});

test('published overrides require calories and protein', async () => {
  const db = overrideDb();
  await assert.rejects(saveDailyMacroOverride(input({ publish_state: 'published', calories: null }), db.sb, ADMIN), (error) => error.status === 400 && /calories/i.test(error.message));
  await assert.rejects(saveDailyMacroOverride(input({ publish_state: 'published', protein_g: null }), db.sb, ADMIN), (error) => error.status === 400 && /protein/i.test(error.message));
});

test('republishing preserves the original timestamp until a row was removed', async () => {
  const db = overrideDb();
  const first = await saveDailyMacroOverride(input({ publish_state: 'published' }), db.sb, ADMIN, new Date('2026-08-18T04:00:00Z'));
  const second = await saveDailyMacroOverride(input({ publish_state: 'published', calories: 3300 }), db.sb, ADMIN, new Date('2026-08-18T05:00:00Z'));
  assert.equal(second.override.publishedAt, first.override.publishedAt);
  await removeDailyMacroOverride(input(), db.sb, ADMIN, new Date('2026-08-18T06:00:00Z'));
  const republished = await saveDailyMacroOverride(input({ publish_state: 'published' }), db.sb, ADMIN, new Date('2026-08-18T07:00:00Z'));
  assert.equal(republished.override.publishedAt, '2026-08-18T07:00:00.000Z');
  assert.equal(republished.override.removedAt, null);
});

test('macro validation rejects negatives, decimals, and ceilings before Postgres', async () => {
  for (const [field, value] of [['calories', -1], ['protein_g', 1.5], ['calories', 12001], ['carbs_g', 2001]]) {
    const db = overrideDb();
    await assert.rejects(saveDailyMacroOverride(input({ [field]: value }), db.sb, ADMIN), (error) => error.status === 400);
    assert.equal(db.writes.length, 0);
  }
});

test('dates must be real ISO days inside the canonical programme week', async () => {
  const db = overrideDb();
  for (const date of ['22/08/2026', '2026-02-30', '2026-08-24']) {
    await assert.rejects(saveDailyMacroOverride(input({ override_date: date }), db.sb, ADMIN), (error) => error.status === 400);
  }
});

test('another athlete week and a missing week are indistinguishable', async () => {
  const ownedByOther = overrideDb({ owner: OTHER });
  const missing = overrideDb({ missingWeek: true });
  const errors = [];
  for (const db of [ownedByOther, missing]) {
    try { await saveDailyMacroOverride(input(), db.sb, ADMIN); } catch (error) { errors.push(error); }
  }
  assert.equal(errors.length, 2);
  assert.equal(errors[0].status, 404);
  assert.equal(errors[0].message, errors[1].message);
});

test('remove returns the row to draft and stamps removed_at', async () => {
  const db = overrideDb();
  await saveDailyMacroOverride(input({ publish_state: 'published' }), db.sb, ADMIN);
  const result = await removeDailyMacroOverride(input(), db.sb, ADMIN, new Date('2026-08-18T08:00:00Z'));
  assert.equal(result.override.state, 'draft');
  assert.equal(result.override.publishedAt, null);
  assert.equal(result.override.removedAt, '2026-08-18T08:00:00.000Z');
});

test('range saves are one atomic upsert after every date validates', async () => {
  const db = overrideDb();
  const valid = await saveDailyMacroOverrideRange(input({ dates: ['2026-08-17', '2026-08-19', '2026-08-23'] }), db.sb, ADMIN);
  assert.equal(valid.overrides.length, 3);
  assert.equal(db.writes.filter((write) => write.path.includes('on_conflict')).length, 1);
  const invalidDb = overrideDb();
  await assert.rejects(saveDailyMacroOverrideRange(input({ dates: ['2026-08-17', '2026-08-24', '2026-08-23'] }), invalidDb.sb, ADMIN), (error) => error.status === 400);
  assert.equal(invalidDb.rows.length, 0);
  assert.equal(invalidDb.writes.length, 0);
});

test('range request limit applies before duplicate dates are collapsed', async () => {
  const db = overrideDb();
  await assert.rejects(
    saveDailyMacroOverrideRange(input({ dates: Array(15).fill('2026-08-22') }), db.sb, ADMIN),
    (error) => error.status === 400 && /1 and 14/.test(error.message),
  );
  assert.equal(db.writes.length, 0);
});

test('athlete contract is locked, coach-sourced, and loader excludes drafts and removals', async () => {
  const row = {
    override_date: '2026-08-22', programme_week_id: WEEK_ID, calories: 3200,
    protein_g: 180, carbs_g: 430, fats_g: 80, fibre_g: 35,
    day_label: 'Long run', coach_note: 'Fuel early', published_at: '2026-08-18T01:00:00Z', updated_at: '2026-08-18T02:00:00Z',
  };
  assert.deepEqual(publishedMacroOverrideContract(row), {
    date: '2026-08-22', weekIdentifier: WEEK_ID, calories: 3200, proteinG: 180,
    carbsG: 430, fatsG: 80, fibreG: 35, dayLabel: 'Long run', coachNote: 'Fuel early',
    source: 'coach', locked: true, publishedAt: '2026-08-18T01:00:00Z', updatedAt: '2026-08-18T02:00:00Z',
  });
  let query;
  const result = await loadPublishedMacroOverrides(ATHLETE, async (table, params) => { query = { table, params }; return [row]; }, new Date('2026-08-18T00:00:00Z'));
  assert.equal(result.length, 1);
  assert.equal(query.table, 'daily_macro_overrides');
  assert.equal(query.params.publish_state, 'eq.published');
  assert.equal(query.params.removed_at, 'is.null');
  assert.equal(query.params.override_date, 'gte.2026-06-19');
});

function responseRecorder() {
  return { statusCode: 200, headers: {}, body: null, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return value; }, end() {} };
}

test('athlete endpoint derives code from the session and ignores a supplied query code', async () => {
  const originalFetch = global.fetch;
  const originalEnv = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: 'user-jordan' }), { status: 200 });
    if (String(url).includes('/athletes?') && String(url).includes('auth_user_id')) return new Response(JSON.stringify([{ code: ATHLETE, active: true, archived_at: null }]), { status: 200 });
    if (String(url).includes('/daily_macro_overrides?')) return new Response(JSON.stringify([{
      override_date: '2026-08-22', programme_week_id: WEEK_ID, calories: 3200, protein_g: 180,
      carbs_g: 430, fats_g: 80, fibre_g: 35, day_label: 'Long run', coach_note: null,
      published_at: '2026-08-18T01:00:00Z', updated_at: '2026-08-18T01:00:00Z',
    }]), { status: 200 });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const req = { method: 'GET', query: { resource: 'daily-macro-overrides', code: OTHER }, headers: { authorization: 'Bearer valid-athlete-session' } };
    const res = responseRecorder();
    await myLogsHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.overrides[0].locked, true);
    const url = requested.find((item) => item.includes('/daily_macro_overrides?'));
    assert.match(url, /athlete_code=eq\.JORDAN/);
    assert.doesNotMatch(url, /NATE/);
  } finally {
    global.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
});

function portalResolver() {
  const source = fs.readFileSync(new URL('../public/js/06-nutrition.js', import.meta.url), 'utf8');
  const context = { window: {}, console, document: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.effectiveTargetsFor;
}

test('one resolver gives day overrides precedence and weekly fallback everywhere else', () => {
  const resolve = portalResolver();
  const weekly = { calories: '2750', protein: '175', carbs: '340', fats: '78', fibre: '32', notes: 'Weekly note' };
  const override = { date: '2026-08-22', calories: 3500, proteinG: 180, carbsG: 500, fatsG: 80, fibreG: 35, dayLabel: 'Long run', coachNote: 'Fuel early' };
  assert.equal(resolve('2026-08-22', weekly, [override]).source, 'coach_day');
  assert.equal(resolve('2026-08-22', weekly, [override]).cal, '3500');
  const fallback = resolve('2026-08-21', weekly, [override]);
  assert.equal(fallback.source, 'coach_week');
  assert.deepEqual(JSON.parse(JSON.stringify(fallback)), {
    source: 'coach_week', locked: true, dayLabel: '', coachNote: 'Weekly note', weekly: null,
    cal: '2750', pro: '175', carb: '340', fat: '78', fibre: '32',
  });
  assert.equal(resolve('2026-08-22', weekly, [{ ...override, removedAt: '2026-08-18T00:00:00Z' }]).source, 'coach_week');
  assert.equal(resolve('2026-08-22', null, []), null);
});

test('schema contains every guard, all four triggers, RLS, and no service-role DELETE', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/202608180001_coach_owned_daily_macro_overrides.sql', import.meta.url), 'utf8');
  assert.match(sql, /constraint daily_macro_overrides_identity_key\s+unique \(athlete_code, override_date\)/i);
  assert.match(sql, /calories <= 12000/i);
  assert.match(sql, /protein_g <= 2000/i);
  assert.match(sql, /publish_state = 'draft' or \(calories is not null and protein_g is not null\)/i);
  assert.match(sql, /validate_daily_macro_override_owner/i);
  assert.match(sql, /audit_daily_macro_override_change/i);
  assert.match(sql, /reject_daily_macro_override_delete/i);
  assert.match(sql, /trg_touch_daily_macro_overrides/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /grant select, insert, update on table public\.daily_macro_overrides to service_role/i);
  assert.doesNotMatch(sql, /grant[^;]*delete[^;]*service_role/i);
});

test('coach Week cells expose inherited, draft, and published fuel states plus the seven-day editor', () => {
  const dashboard = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const editor = fs.readFileSync(new URL('../public/daily-macro-overrides.js', import.meta.url), 'utf8');
  assert.match(dashboard, /DailyMacroOverridesEditor\?\.footerHtml/);
  assert.match(editor, /dmo-fuel-footer inherits/);
  assert.match(editor, /Uses weekly targets/);
  assert.match(editor, /Override macros for this day/);
  assert.match(editor, /Daily override ·/);
  assert.doesNotMatch(editor, />Inherits</);
  assert.doesNotMatch(editor, /Edit daily fuelling/);
  assert.match(editor, /row\.state === 'published' \? 'published' : 'draft'/);
  assert.match(editor, /for \(var index = 0; index < 7; index \+= 1\)/);
  assert.match(editor, /dmo-prefill/);
  assert.match(editor, /daily_macro_override_range_save/);
  assert.match(editor, /dmo-delta/);
  assert.match(editor, /> 0\.6/);
});

test('a failed editor load stops retrying, surfaces the error, and offers a manual retry', async () => {
  const source = fs.readFileSync(new URL('../public/daily-macro-overrides.js', import.meta.url), 'utf8');
  const editorRoot = {
    innerHTML: '',
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  let fetchCalls = 0;
  const context = {
    window: {},
    document: {
      getElementById(id) { return id === 'daily-macro-overrides-editor' ? editorRoot : null; },
      addEventListener() {},
    },
    fetch: async () => {
      fetchCalls += 1;
      return { ok: false, status: 500, json: async () => ({ error: 'Override table unavailable' }) };
    },
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  context.renderProgramming = () => context.window.DailyMacroOverridesEditor.mount({ athleteCode: ATHLETE });
  vm.createContext(context);
  vm.runInContext(source, context);
  context.window.DailyMacroOverridesEditor.mount({ athleteCode: ATHLETE });
  await new Promise((resolve) => setTimeout(resolve, 20));
  context.window.DailyMacroOverridesEditor.open('2026-08-22', 'Week 4', null);
  assert.equal(fetchCalls, 1);
  assert.match(editorRoot.innerHTML, /Override table unavailable/);
  assert.match(editorRoot.innerHTML, /class="dmo-retry"/);
});

test('dashboard ships daily fuelling and theme parity under the current PWA asset version', () => {
  const dashboard = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const worker = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(dashboard, /daily-macro-overrides\.css\?v=3/);
  assert.match(dashboard, /daily-macro-overrides\.js\?v=3/);
  assert.match(worker, /daily-macro-overrides\.css\?v=3/);
  assert.match(worker, /daily-macro-overrides\.js\?v=3/);
  assert.match(worker, /dp-coaches-v30-theme-parity/);
});

test('coach links and notification forwarding default to the canonical athlete portal', () => {
  const dashboard = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const athletesApi = fs.readFileSync(new URL('../api/athletes.js', import.meta.url), 'utf8');
  const notifyApi = fs.readFileSync(new URL('../api/notify.js', import.meta.url), 'utf8');
  for (const source of [dashboard, athletesApi, notifyApi]) {
    assert.match(source, /https:\/\/portal\.dualperformance\.au/);
    assert.doesNotMatch(source, /dp-athlete-?portal\.vercel\.app/);
  }
});

test('athlete Nutrition uses the exported resolver, warm snapshot cache, strip, locked overrides, and no local shadow', () => {
  const source = fs.readFileSync(new URL('../public/js/06-nutrition.js', import.meta.url), 'utf8');
  assert.match(source, /window\.effectiveTargetsFor=effectiveTargetsFor/);
  assert.match(source, /snapshot\.macroOverrides/);
  assert.match(source, /resource=daily-macro-overrides/);
  assert.match(source, /nut-day-strip/);
  assert.match(source, /<s>/);
  assert.doesNotMatch(source, /localStorage[^\n]*macro/i);
});
