#!/usr/bin/env node
import './load-env.mjs';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const argv = process.argv.slice(2);
const valueAfter = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const eventId = valueAfter('--event-id');
const gameId = valueAfter('--game-id');
const fromVersion = valueAfter('--from-version');
const dryRun = argv.includes('--dry-run');
if (!eventId && !gameId && !fromVersion)
  throw new Error('Provide --event-id, --game-id, or --from-version');
if (fromVersion !== undefined && (!/^\d+$/.test(fromVersion) || Number(fromVersion) < 1))
  throw new Error('--from-version must be a positive integer');
const conditions = [];
if (eventId) {
  conditions.push(`id = '${sqlQuote(eventId)}'`);
}
if (gameId) {
  conditions.push(`game_id = '${sqlQuote(gameId)}'`);
}
if (fromVersion) {
  conditions.push(`state_version >= ${Number(fromVersion)}`);
}
const where = conditions.join(' AND ');
const sql = dryRun
  ? `SELECT id, game_id, state_version, event_type FROM outbox_events WHERE ${where} ORDER BY state_version;`
  : `UPDATE outbox_events SET published_at = NULL, next_attempt_at = now(), last_error = NULL WHERE ${where};`;
await run(sql);
console.log(dryRun ? 'Outbox replay preview completed' : 'Outbox events queued for replay');

function sqlQuote(value) {
  if (!/^[A-Za-z0-9._:-]+$/.test(value))
    throw new Error('Identifier contains unsupported characters');
  return value;
}
function run(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql',
      ['--set', 'ON_ERROR_STOP=1', '--dbname', databaseUrl, '--command', sql],
      { stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`psql exited with status ${code}`)),
    );
  });
}
