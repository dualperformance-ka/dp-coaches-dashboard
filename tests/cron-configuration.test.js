import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const MIGRATION = 'supabase/migrations/20261022000001_cron_reminders_and_run_history_retention.sql';
const ROLLBACK = 'supabase/rollback/20261022000001_cron_reminders_and_run_history_retention_down.sql';
const VERIFY = 'supabase/tests/cron-configuration.verify.sql';
const FIXTURE = 'supabase/tests/cron-configuration.fixture.sql';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Comments explain forbidden operations by name; the checks are about code.
const code = sql => sql.replace(/--[^\n]*/g, '');

test('cron configuration is the documented source of truth and never touches cron.job directly', () => {
  const sql = code(read(MIGRATION));
  assert.match(sql, /cron\.schedule\(\s*'send-athlete-reminders',\s*'\*\/5 \* \* \* \*'/);
  assert.match(sql, /https:\/\/portal\.dualperformance\.au\/api\/reminders/);
  assert.match(sql, /timeout_milliseconds := 60000/);
  assert.match(sql, /vault\.decrypted_secrets where name = 'reminders_cron_secret'/);
  // Writes to pg_cron's catalogue go through its functions only.
  assert.doesNotMatch(sql, /\b(update|insert\s+into|delete\s+from)\s+cron\.job\b(?!_run_details)/i);
  // Blocking maintenance never hides in a migration.
  assert.doesNotMatch(sql, /vacuum\s+full/i);
  assert.doesNotMatch(sql, /\bvacuum\b/i);
  // No schedule faster than five minutes for the reminders job.
  assert.doesNotMatch(sql, /'send-athlete-reminders',\s*'\* \* \* \* \*'/);
});

test('no secret value is committed with the cron configuration', () => {
  for (const path of [MIGRATION, ROLLBACK, VERIFY]) {
    const sql = read(path);
    assert.doesNotMatch(sql, /Bearer [A-Za-z0-9._-]{12,}/, `${path} contains a literal bearer token`);
    assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{10,}\./, `${path} contains a JWT`);
    // The decrypted value may only ever be read inline into the request header.
    const reads = sql.match(/decrypted_secret\b(?!s)/g) || [];
    const headerReads = sql.match(/'Bearer ' \|\| \(select decrypted_secret from vault\.decrypted_secrets where name = 'reminders_cron_secret' limit 1\)/g) || [];
    assert.equal(reads.length, headerReads.length, `${path} reads a decrypted secret outside the request header`);
  }
  // The verify script checks the secret's presence by name, never its value.
  assert.doesNotMatch(code(read(VERIFY)), /decrypted_secret\b(?!s)/);
});

test('run-history retention is bounded per run and keeps 30 days', () => {
  const sql = code(read(MIGRATION));
  const job = sql.slice(sql.indexOf("'purge-cron-run-history'"));
  assert.match(job, /delete from cron\.job_run_details/);
  assert.match(job, /interval '30 days'/);
  assert.match(job, /limit 10000/);
  assert.match(job, /'17 \* \* \* \*'/, 'hourly, off the */5 and */15 boundaries');
});

test('rollback removes only the retention job and never restores per-minute reminders', () => {
  const sql = code(read(ROLLBACK));
  assert.match(sql, /cron\.unschedule\('purge-cron-run-history'\)/);
  assert.doesNotMatch(sql, /'\* \* \* \* \*'/);
  assert.doesNotMatch(sql, /\bcron\.job\b\s+set/i);
});

// Runs the migration twice against a throwaway local Postgres seeded with
// supabase/tests/cron-configuration.fixture.sql (stand-ins for pg_cron, pg_net
// and Vault). Set CRON_TEST_DATABASE_URL to an EMPTY local database to enable;
// never point it at Supabase.
test('migration, verify and rollback are idempotent on a real Postgres', { skip: !process.env.CRON_TEST_DATABASE_URL && 'set CRON_TEST_DATABASE_URL to a throwaway local database' }, () => {
  const db = process.env.CRON_TEST_DATABASE_URL;
  assert.doesNotMatch(db, /supabase\.(co|com|in)/, 'refusing to run the fixture against Supabase');
  const psql = (args) => execFileSync('psql', [db, '-v', 'ON_ERROR_STOP=1', '-qtA', ...args], { encoding: 'utf8' });
  const file = path => new URL(`../${path}`, import.meta.url).pathname;

  psql(['-f', file(FIXTURE)]);
  const jobsBefore = psql(['-c', "select jobid from cron.job where jobname = 'send-athlete-reminders'"]).trim();

  psql(['-f', file(MIGRATION)]);
  psql(['-f', file(MIGRATION)]);
  psql(['-f', file(VERIFY)]);

  const jobs = psql(['-c', "select jobname || '|' || schedule from cron.job order by jobname"]).trim().split('\n');
  assert.deepEqual(jobs, ['purge-cron-run-history|17 * * * *', 'send-athlete-reminders|*/5 * * * *']);
  // Upsert, not replace: run history stays attached to the same jobid.
  assert.equal(psql(['-c', "select jobid from cron.job where jobname = 'send-athlete-reminders'"]).trim(), jobsBefore);

  // Execute the retention command itself: one run deletes one bounded batch.
  const command = psql(['-c', "select command from cron.job where jobname = 'purge-cron-run-history'"]);
  const before = Number(psql(['-c', 'select count(*) from cron.job_run_details']));
  psql(['-c', command]);
  const after = Number(psql(['-c', 'select count(*) from cron.job_run_details']));
  assert.equal(before - after, 10000);
  psql(['-c', command]);
  psql(['-c', command]);
  psql(['-c', command]);
  assert.equal(Number(psql(['-c', "select count(*) from cron.job_run_details where start_time < now() - interval '30 days'"])), 0);
  assert.equal(Number(psql(['-c', 'select count(*) from cron.job_run_details'])), 500, 'recent history is kept');

  psql(['-f', file(ROLLBACK)]);
  psql(['-f', file(ROLLBACK)]);
  assert.equal(psql(['-c', "select count(*) from cron.job where jobname = 'purge-cron-run-history'"]).trim(), '0');
  assert.equal(psql(['-c', "select schedule from cron.job where jobname = 'send-athlete-reminders'"]).trim(), '*/5 * * * *');
});
