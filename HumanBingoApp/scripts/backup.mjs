#!/usr/bin/env node
import './load-env.mjs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const databaseUrl = process.env.DATABASE_URL?.trim();
const backupDir = process.env.BACKUP_DIR?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!backupDir) throw new Error('BACKUP_DIR is required');
if (process.env.NODE_ENV === 'production' && process.env.DATABASE_SSL_MODE !== 'verify-full') {
  throw new Error('DATABASE_SSL_MODE=verify-full is required for production backups');
}
await mkdir(backupDir, { recursive: true });
const file = join(backupDir, `human-bingo-${new Date().toISOString().replaceAll(':', '-')}.dump`);
await run(['--format=custom', '--no-owner', '--no-acl', '--file', file, databaseUrl]);
console.log(`Database backup written to ${file}`);

const retention = Number(process.env.BACKUP_RETENTION_COUNT ?? '7');
if (Number.isInteger(retention) && retention > 0) {
  const candidates = (
    await Promise.all(
      (await readdir(backupDir))
        .filter((name) => name.endsWith('.dump'))
        .map(async (name) => ({ name, time: (await stat(join(backupDir, name))).mtimeMs })),
    )
  ).sort((a, b) => b.time - a.time);
  await Promise.all(
    candidates.slice(retention).map(async ({ name }) => {
      const { unlink } = await import('node:fs/promises');
      await unlink(join(backupDir, name));
    }),
  );
}

function run(commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', commandArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_dump exited with status ${code}`)),
    );
  });
}
