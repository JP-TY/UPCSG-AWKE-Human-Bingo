import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { requireDatabaseTestConfig } from '@human-bingo/test-utils';

const execFileAsync = promisify(execFile);

/**
 * Provisions and resets only the explicitly configured test database before the
 * integration suite. This runs before any test module is imported.
 */
export default async function setupDatabase(): Promise<() => Promise<void>> {
  loadLocalEnvironment();
  process.env.NODE_ENV = 'test';
  const config = requireDatabaseTestConfig(process.env);
  const developmentUrl = process.env.DATABASE_URL?.trim();
  if (developmentUrl && developmentUrl === config.url) {
    throw new Error('Refusing integration tests: TEST_DATABASE_URL must differ from DATABASE_URL');
  }

  await runDatabaseCommand('create', config.url);
  await runDatabaseCommand('migrate', config.url);
  await resetTestSchema(config.url);

  return async () => {
    // Connections are owned by individual tests; no development database
    // cleanup is performed here. The test schema remains isolated by URL.
  };
}

async function runDatabaseCommand(command: 'create' | 'migrate', url: string): Promise<void> {
  const { stderr } = await execFileAsync('node', ['scripts/db.mjs', command, '--target', 'test'], {
    env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: url },
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
}

async function resetTestSchema(url: string): Promise<void> {
  await execFileAsync(
    'psql',
    [
      '--no-psqlrc',
      '--quiet',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      url,
      '--command',
      'DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
    ],
    {
      env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: url },
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    },
  );
  await runDatabaseCommand('migrate', url);
}

function loadLocalEnvironment(): void {
  // Keep test commands convenient locally without overriding CI/CLI values.
  try {
    const contents = readFileSync('.env', 'utf8');
    for (const line of contents.split(/\r?\n/u)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/gu, '');
      }
    }
  } catch {
    // Missing .env is fine when CI supplies explicit environment variables.
  }
}
