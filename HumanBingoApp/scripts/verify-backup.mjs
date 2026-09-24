#!/usr/bin/env node
import './load-env.mjs';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const backupDir = process.env.BACKUP_DIR?.trim();
if (!backupDir) throw new Error('BACKUP_DIR is required');
const requested = process.argv[2];
const file =
  requested ??
  (await readdir(backupDir))
    .filter((name) => name.endsWith('.dump'))
    .sort()
    .at(-1);
if (!file) throw new Error('No custom-format backup was found');
const path = file.includes('/') ? file : join(backupDir, file);
await run(['--list', path]);
console.log(`Backup archive is readable: ${path}`);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_restore', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_restore exited with status ${code}`)),
    );
  });
}
