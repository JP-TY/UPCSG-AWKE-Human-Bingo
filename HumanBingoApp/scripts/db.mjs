#!/usr/bin/env node
import './load-env.mjs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { URL } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const migrationId = '001_initial_schema';
const migrationFile = resolve(root, 'packages/persistence/src/migrations/001_initial_schema.sql');
const rollbackFile = resolve(
  root,
  'packages/persistence/src/migrations/001_initial_schema.down.sql',
);
const command = process.argv[2];
const args = process.argv.slice(3);
const targetArg = args.indexOf('--target');
const target = targetArg >= 0 ? args[targetArg + 1] : 'development';
const timeoutMs = Number(process.env.DB_WAIT_TIMEOUT_MS ?? '60000');

if (!['development', 'test'].includes(target)) fail('target must be development or test');
if (!command || !['wait', 'create', 'migrate', 'reset', 'status'].includes(command)) {
  fail('usage: db.mjs <wait|create|migrate|reset|status> [--target development|test]');
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000)
  fail('DB_WAIT_TIMEOUT_MS must be at least 1000');

const nodeEnv = process.env.NODE_ENV ?? 'development';
if (command === 'reset' && (nodeEnv !== 'development' || target !== 'development')) {
  fail('db:reset is allowed only with NODE_ENV=development and --target development');
}
const databaseUrl = getDatabaseUrl(target);
if (target === 'test' && process.env.DATABASE_URL?.trim() === databaseUrl) {
  fail('TEST_DATABASE_URL must be different from DATABASE_URL');
}
const parsed = parseDatabaseUrl(databaseUrl);
if (command === 'reset' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
  fail('db:reset requires a local PostgreSQL host');
}

try {
  if (command === 'wait') await waitForDatabase(databaseUrl);
  else if (command === 'create') await createDatabase(databaseUrl, parsed);
  else if (command === 'migrate') await migrate(databaseUrl);
  else if (command === 'reset') await reset(databaseUrl);
  else await status(databaseUrl);
} catch (error) {
  fail(
    `${command} failed for ${target} database: ${redact(error instanceof Error ? error.message : String(error))}`,
  );
}

function getDatabaseUrl(selectedTarget) {
  const value =
    selectedTarget === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!value?.trim())
    fail(
      `${selectedTarget === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} is required for --target ${selectedTarget}`,
    );
  return value.trim();
}
function parseDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('database URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname || url.pathname === '/')
    fail('database URL must use postgres:// and include a database name');
  return url;
}
function redact(value) {
  return value
    .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, '$1[REDACTED]')
    .replace(/password[^\s]*/gi, 'password=[REDACTED]');
}
function fail(message) {
  console.error(`Database command error: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}
function run(program, arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, arguments_, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolvePromise({ stdout, stderr })
        : reject(new Error(`${program} exited with status ${code}: ${stderr.trim()}`)),
    );
  });
}
async function psql(url, sql, extra = []) {
  const result = await run('psql', [
    '--no-psqlrc',
    '--quiet',
    '--set',
    'ON_ERROR_STOP=1',
    '--dbname',
    url,
    '-c',
    sql,
    ...extra,
  ]);
  return result.stdout.trim();
}
async function waitForDatabase(url) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await run('pg_isready', ['--dbname', url]);
      console.log('Database is accepting connections');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  fail(`timed out after ${timeoutMs}ms; run docker compose ps and docker compose logs postgres`);
}
async function createDatabase(url, parsed) {
  try {
    await psql(url, 'SELECT 1;');
    console.log(`Database target ready: ${parsed.pathname.slice(1)}`);
  } catch (error) {
    const maintenance = new URL(url);
    maintenance.pathname = '/postgres';
    const name = parsed.pathname.slice(1);
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    const literal = name.replaceAll("'", "''");
    await psql(
      maintenance.toString(),
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = '${literal}') THEN 1 ELSE 0 END;`,
    );
    await psql(maintenance.toString(), `CREATE DATABASE ${quoted};`);
    console.log(`Created database target: ${name}`);
  }
}
async function ensureLedger(url) {
  await psql(
    url,
    'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());',
  );
}
async function migrate(url) {
  await ensureLedger(url);
  const applied = await psql(url, 'SELECT id FROM schema_migrations ORDER BY id;', [
    '--tuples-only',
    '--no-align',
  ]);
  if (
    applied
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .includes(migrationId)
  ) {
    console.log('Migrations up to date');
    return;
  }
  const sql = await readFile(migrationFile, 'utf8');
  await psql(
    url,
    `BEGIN;\n${sql}\nINSERT INTO schema_migrations (id) VALUES ('${migrationId}');\nCOMMIT;`,
  );
  console.log(`Applied migration ${migrationId}`);
}
async function reset(url) {
  await psql(url, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(url);
  console.log('Development database reset completed; existing data was deleted');
}
async function status(url) {
  await ensureLedger(url);
  const applied = (
    await psql(url, 'SELECT id FROM schema_migrations ORDER BY id;', [
      '--tuples-only',
      '--no-align',
    ])
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = [migrationId];
  const inconsistent = applied.some((id) => !expected.includes(id));
  const pending = expected.filter((id) => !applied.includes(id));
  console.log(
    `Database migration status: ${pending.length || inconsistent ? 'not up to date' : 'up to date'}`,
  );
  console.log(`Applied: ${applied.length ? applied.join(', ') : 'none'}`);
  console.log(`Pending: ${pending.length ? pending.join(', ') : 'none'}`);
  if (inconsistent) fail('migration ledger contains unknown migration IDs');
  if (pending.length) process.exitCode = 2;
}
