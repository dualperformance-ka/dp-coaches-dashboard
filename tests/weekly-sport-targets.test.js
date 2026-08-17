import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import athletesHandler from '../api/athletes.js';
import myLogsHandler, {
  loadPublishedCoachTargets,
  publishedCoachTargetContract,
} from '../api/my-logs.js';
import {
  listWeeklySportTargets,
  removeWeeklySportTarget,
  saveWeeklySportTarget,
} from '../server/weekly-sport-targets.js';

const ATHLETE = 'JORDAN';
const OTHER_ATHLETE = 'NATE';
const WEEK_ID = '11111111-1111-4111-8111-111111111111';
const PROGRAMME_ID = '22222222-2222-4222-8222-222222222222';
const COACH_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN = { id: COACH_ID, handle: 'KARL', name: 'Karl', role: 'admin' };

function targetDb() {
  const rows = [];
  const writes = [];
  const sb = async (path, options = {}) => {
    if (path.startsWith('athlete_programme_weeks?id=')) {
      return [{ id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 4, week_label: 'Week 4' }];
    }
    if (path.startsWith('athlete_programmes?id=')) {
      return [{ id: PROGRAMME_ID, athlete_code: ATHLETE, status: 'active' }];
    }
    if (path.startsWith('athlete_programmes?athlete_code=')) {
      return [{ id: PROGRAMME_ID, athlete_code: ATHLETE, status: 'active', name: 'Race build' }];
    }
    if (path.startsWith('athlete_programme_weeks?programme_id=')) {
      return [{ id: WEEK_ID, programme_id: PROGRAMME_ID, week_number: 4, week_label: 'Week 4' }];
    }
    if (path.startsWith('weekly_sport_targets?athlete_code=') && options.method === 'PATCH') {
      const sport = decodeURIComponent(path.match(/&sport=eq\.([^&]+)/)[1]);
      const row = rows.find((item) => item.sport === sport);
      if (!row) return [];
      Object.assign(row, options.body, { updated_at: '2026-08-17T03:00:00.000Z' });
      writes.push({ path, options });
      return [{ ...row }];
    }
    if (path.startsWith('weekly_sport_targets?athlete_code=') && path.includes('&sport=eq.')) {
      const sport = decodeURIComponent(path.match(/&sport=eq\.([^&]+)/)[1]);
      const row = rows.find((item) => item.sport === sport);
      return row ? [{ ...row }] : [];
    }
    if (path.startsWith('weekly_sport_targets?athlete_code=')) return rows.map((row) => ({ ...row }));
    if (path.startsWith('weekly_sport_targets?on_conflict=')) {
      const input = options.body[0];
      let row = rows.find((item) => item.sport === input.sport);
      if (!row) {
        row = {
          id: `44444444-4444-4444-8444-44444444444${rows.length}`,
          created_at: '2026-08-17T01:00:00.000Z',
        };
        rows.push(row);
      }
      Object.assign(row, input, { updated_at: '2026-08-17T02:00:00.000Z' });
      writes.push({ path, options });
      return [{ ...row }];
    }
    return [];
  };
  return { rows, writes, sb };
}

function targetInput(sport, overrides = {}) {
  return {
    athlete_code: ATHLETE,
    programme_week_id: WEEK_ID,
    sport,
    distance_target_metres: 10000,
    session_target: 3,
    duration_target_minutes: 120,
    coach_note: 'Stay controlled',
    publish_state: 'draft',
    ...overrides,
  };
}

test('a coach can create, update, publish, unpublish and soft-remove a target', async () => {
  const db = targetDb();
  let result = await saveWeeklySportTarget(targetInput('running'), db.sb, ADMIN);
  assert.equal(result.target.state, 'draft');
  assert.equal(result.target.publishedAt, null);

  result = await saveWeeklySportTarget(targetInput('running', {
    distance_target_metres: 12000,
    publish_state: 'published',
  }), db.sb, ADMIN, new Date('2026-08-17T04:00:00.000Z'));
  assert.equal(result.target.distanceTargetMetres, 12000);
  assert.equal(result.target.publishedAt, '2026-08-17T04:00:00.000Z');

  result = await saveWeeklySportTarget(targetInput('running', {
    distance_target_metres: 12000,
    publish_state: 'draft',
  }), db.sb, ADMIN);
  assert.equal(result.target.state, 'draft');
  assert.equal(result.target.publishedAt, null);

  const removed = await removeWeeklySportTarget(targetInput('running'), db.sb, ADMIN);
  assert.equal(removed.removed, true);
  assert.ok(removed.target.removedAt);
  assert.equal(db.rows.length, 1, 'removal must preserve the row');
});

test('one athlete and programme week can hold separate targets for all three sports', async () => {
  const db = targetDb();
  await saveWeeklySportTarget(targetInput('running', { distance_target_metres: 0, publish_state: 'published' }), db.sb, ADMIN);
  await saveWeeklySportTarget(targetInput('cycling', { distance_target_metres: 40000 }), db.sb, ADMIN);
  await saveWeeklySportTarget(targetInput('swimming', { distance_target_metres: 1800 }), db.sb, ADMIN);

  const result = await listWeeklySportTargets(ATHLETE, db.sb, ADMIN);
  assert.deepEqual(result.targets.map((row) => row.sport).sort(), ['cycling', 'running', 'swimming']);
  assert.equal(new Set(result.targets.map((row) => row.weekIdentifier)).size, 1);
});

test('published zero is retained as an authoritative target', async () => {
  const db = targetDb();
  const result = await saveWeeklySportTarget(targetInput('running', {
    distance_target_metres: 0,
    session_target: 0,
    duration_target_minutes: 0,
    publish_state: 'published',
  }), db.sb, ADMIN);
  assert.equal(result.target.distanceTargetMetres, 0);
  assert.equal(result.target.state, 'published');
  assert.ok(result.target.publishedAt);
});

test('coach attribution comes from resolved identity, never request fields', async () => {
  const db = targetDb();
  await saveWeeklySportTarget(targetInput('cycling', {
    updated_by: 'attacker-supplied-id',
  }), db.sb, ADMIN);
  const write = db.writes.find((item) => item.path.startsWith('weekly_sport_targets?on_conflict='));
  assert.equal(write.options.body[0].updated_by, COACH_ID);
  assert.equal('updated_by' in targetInput('cycling'), false);
});

test('athlete contract returns published values as coach-sourced and locked', async () => {
  const row = {
    sport: 'running',
    programme_week_id: WEEK_ID,
    distance_target_metres: 0,
    session_target: 0,
    duration_target_minutes: 0,
    coach_note: 'Recovery week',
    published_at: '2026-08-17T01:00:00Z',
    updated_at: '2026-08-17T02:00:00Z',
  };
  const contract = publishedCoachTargetContract(row);
  assert.equal(contract.distanceTargetMetres, 0);
  assert.equal(contract.source, 'coach');
  assert.equal(contract.locked, true);
});

test('athlete target loader requests published, non-removed rows only', async () => {
  let query;
  const targets = await loadPublishedCoachTargets(ATHLETE, async (table, params) => {
    query = { table, params };
    return [{
      sport: 'swimming', programme_week_id: WEEK_ID, distance_target_metres: 1500,
      session_target: null, duration_target_minutes: 45, coach_note: null,
      published_at: '2026-08-17T01:00:00Z', updated_at: '2026-08-17T01:00:00Z',
    }];
  });
  assert.equal(query.table, 'weekly_sport_targets');
  assert.equal(query.params.athlete_code, `eq.${ATHLETE}`);
  assert.equal(query.params.publish_state, 'eq.published');
  assert.equal(query.params.removed_at, 'is.null');
  assert.equal(targets.length, 1);
});

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return value; },
    end() { return undefined; },
  };
}

test('athlete endpoint derives identity from session and ignores a supplied athlete code', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  const requested = [];
  global.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: 'user-jordan', email: 'jordan@example.com' }), { status: 200 });
    }
    if (String(url).includes('/athletes?') && String(url).includes('auth_user_id')) {
      return new Response(JSON.stringify([{ code: ATHLETE, active: true, archived_at: null }]), { status: 200 });
    }
    if (String(url).includes('/weekly_sport_targets?')) {
      return new Response(JSON.stringify([{
        sport: 'running', programme_week_id: WEEK_ID, distance_target_metres: 0,
        session_target: null, duration_target_minutes: null, coach_note: null,
        published_at: '2026-08-17T01:00:00Z', updated_at: '2026-08-17T01:00:00Z',
      }]), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const req = {
      method: 'GET',
      query: { resource: 'weekly-sport-targets', code: OTHER_ATHLETE },
      headers: { authorization: 'Bearer valid-athlete-session' },
    };
    const res = responseRecorder();
    await myLogsHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.targets[0].locked, true);
    const targetUrl = requested.find((url) => url.includes('/weekly_sport_targets?'));
    assert.match(targetUrl, /athlete_code=eq\.JORDAN/);
    assert.doesNotMatch(targetUrl, /NATE/);
  } finally {
    global.fetch = originalFetch;
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('an athlete bearer token cannot call coach write actions', async () => {
  const previous = process.env.DASHBOARD_ACCESS_KEY;
  process.env.DASHBOARD_ACCESS_KEY = 'coach-only-key';
  const req = {
    method: 'POST',
    query: {},
    headers: { authorization: 'Bearer athlete-token' },
    body: { action: 'weekly_sport_target_save', athlete_code: ATHLETE },
  };
  const res = responseRecorder();
  try {
    await athletesHandler(req, res);
    assert.equal(res.statusCode, 401);
  } finally {
    if (previous === undefined) delete process.env.DASHBOARD_ACCESS_KEY;
    else process.env.DASHBOARD_ACCESS_KEY = previous;
  }
});

test('legacy running-target migration is idempotent and leaves nutrition values intact', () => {
  const sql = fs.readFileSync(
    new URL('../supabase/migrations/20260817052406_coach_owned_weekly_sport_targets.sql', import.meta.url),
    'utf8'
  );
  const backfill = sql.slice(sql.indexOf('insert into public.weekly_sport_targets'));
  assert.match(backfill, /on conflict \(athlete_code, programme_week_id, sport\) do nothing/i);
  assert.doesNotMatch(sql, /(?:update|delete\s+from)\s+public\.nutrition_plans/i);
  assert.match(sql, /revoke all on table public\.weekly_sport_targets from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update on table public\.weekly_sport_targets to service_role/i);
});

function weeklyTargetBrowser(payload) {
  const source = fs.readFileSync(
    new URL('../public/weekly-sport-targets.js', import.meta.url),
    'utf8'
  );
  const context = {
    document: { addEventListener() {}, getElementById() { return null; } },
    window: {},
    fetch: async () => ({ ok: true, json: async () => payload }),
    renderNutTable() {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.WeeklySportTargetsEditor;
}

test('running column keeps plan mileage visible before a coach target is published', () => {
  const editor = weeklyTargetBrowser({ ok: true, programmeWeeks: [], targets: [] });
  const html = editor.sportCellHtml({ weekLabel: 'Week 6', sport: 'running', planKm: 86, legacyKm: null });
  assert.match(html, /86 km/);
  assert.match(html, /From plan · publish/);
});

test('nutrition renders each sport in its own column and preserves authoritative zero', async () => {
  const editor = weeklyTargetBrowser({
    ok: true,
    programmeWeeks: [{ id: WEEK_ID, weekLabel: 'Week 4' }],
    targets: [
      { weekIdentifier: WEEK_ID, sport: 'running', state: 'published', distanceTargetMetres: 0, removedAt: null },
      { weekIdentifier: WEEK_ID, sport: 'cycling', state: 'published', distanceTargetMetres: 120000, removedAt: null },
      { weekIdentifier: WEEK_ID, sport: 'swimming', state: 'draft', distanceTargetMetres: 2500, removedAt: null },
    ],
  });
  editor.mount({ athleteCode: ATHLETE });
  await new Promise((resolve) => setImmediate(resolve));
  const running = editor.sportCellHtml({ weekLabel: 'Week 4', sport: 'running', planKm: 75 });
  const cycling = editor.sportCellHtml({ weekLabel: 'Week 4', sport: 'cycling', planKm: 75 });
  const swimming = editor.sportCellHtml({ weekLabel: 'Week 4', sport: 'swimming', planKm: 75 });
  assert.match(running, /Running/);
  assert.match(running, /0 km/);
  assert.match(running, /Locked/);
  assert.match(cycling, /Cycling/);
  assert.match(cycling, /120 km/);
  assert.match(swimming, /Swimming/);
  assert.match(swimming, /2500 m/);
  assert.match(swimming, /Draft/);
});

test('nutrition saves cannot erase the preserved legacy running target after sport controls move to Week view', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const capture = html.slice(html.indexOf('function _captureNutInputs'), html.indexOf('function _nutWeekOptions'));
  const save = html.slice(html.indexOf('async function saveNutRow'), html.indexOf('// Delete a single week row'));
  assert.doesNotMatch(capture, /weekly_km_target/);
  assert.doesNotMatch(save, /weekly_km_target/);
  assert.doesNotMatch(save, /weekly_sport_target/);
  assert.match(html, /className = 'dmo-week-sports'/);
  assert.match(html, /WeeklySportTargetsEditor\?\.sportCellHtml/);
});
