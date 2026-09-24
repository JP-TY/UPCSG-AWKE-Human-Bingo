#!/usr/bin/env node
import './load-env.mjs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const migration = resolve(root, 'packages/persistence/src/migrations/001_initial_schema.sql');
const rollback = resolve(root, 'packages/persistence/src/migrations/001_initial_schema.down.sql');
const args = new Set(process.argv.slice(2));
const direction = args.has('--down') ? 'down' : 'up';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (
  direction === 'down' &&
  process.env.NODE_ENV === 'production' &&
  !args.has('--allow-destructive')
) {
  throw new Error('Refusing destructive migration in production without --allow-destructive');
}
if (args.has('--check-rollback')) {
  const checkUrl = process.env.MIGRATION_ROLLBACK_DATABASE_URL?.trim();
  if (!checkUrl)
    throw new Error('MIGRATION_ROLLBACK_DATABASE_URL is required for --check-rollback');
  if (process.env.NODE_ENV === 'production')
    throw new Error('Rollback checks cannot run in production');
  await run(checkUrl, await readFile(migration, 'utf8'));
  await run(checkUrl, await readFile(rollback, 'utf8'));
  console.log('Migration rollback check passed');
} else {
  const file = direction === 'up' ? migration : rollback;
  await run(databaseUrl, await readFile(file, 'utf8'));
  console.log(`Migration ${direction} completed`);
}

function run(url, sql) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('psql', ['--set', 'ON_ERROR_STOP=1', '--dbname', url], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`psql exited with status ${code}`)),
    );
    child.stdin.end(`BEGIN;\n${sql}\nCOMMIT;\n`);
  });
}
