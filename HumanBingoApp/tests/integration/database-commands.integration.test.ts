import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../..');
const developmentUrl = process.env.DATABASE_URL?.trim() ?? 'postgres://localhost:5432/human_bingo';
const testUrl =
  process.env.TEST_DATABASE_URL?.trim() ?? 'postgres://localhost:5432/human_bingo_test';
const databaseToolsAvailable =
  spawnSync('pg_isready', ['--dbname', developmentUrl], { stdio: 'ignore' }).status === 0 &&
  spawnSync('psql', ['--version'], { stdio: 'ignore' }).status === 0;

interface CommandResult {
  readonly status: number;
  readonly output: string;
}

async function runDbCommand(
  command: string,
  target: 'development' | 'test' = 'development',
  environment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  try {
    const result = await execFileAsync('node', ['scripts/db.mjs', command, '--target', target], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      maxBuffer: 1024 * 1024,
    });
    return { status: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      status: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
    };
  }
}

const databaseTest = databaseToolsAvailable ? it : it.skip;

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const psql = async (url: string, command: string): Promise<void> => {
  await execFileAsync(
    'psql',
    ['--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1', '--dbname', url, '-c', command],
    { cwd: repositoryRoot, maxBuffer: 1024 * 1024 },
  );
};

describe('database command workflow against Local_PostgreSQL', () => {
  databaseTest('wait reports a bounded timeout with actionable diagnostics', async () => {
    const result = await runDbCommand('wait', 'development', {
      DATABASE_URL: 'postgres://127.0.0.1:1/human_bingo',
      DB_WAIT_TIMEOUT_MS: '1000',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('timed out after 1000ms');
    expect(result.output).toContain('docker compose ps');
    expect(result.output).not.toContain('human_bingo_local_password');
  });

  databaseTest(
    'create is idempotent and names the selected database without credentials',
    async () => {
      const first = await runDbCommand('create', 'test', { TEST_DATABASE_URL: testUrl });
      const second = await runDbCommand('create', 'test', { TEST_DATABASE_URL: testUrl });

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(`${first.output}${second.output}`).toContain('Database target ready:');
      expect(`${first.output}${second.output}`).not.toContain('human_bingo_local_password');
      expect(`${first.output}${second.output}`).not.toContain(testUrl);
    },
  );

  databaseTest(
    'status reports pending migrations and becomes healthy after migration',
    async () => {
      const maintenanceUrl = new URL(testUrl);
      maintenanceUrl.pathname = '/postgres';
      const databaseName = `human_bingo_status_${process.pid}`;
      const isolated = new URL(maintenanceUrl);
      isolated.pathname = `/${databaseName}`;

      try {
        await psql(maintenanceUrl.toString(), `DROP DATABASE IF EXISTS ${quoted(databaseName)}`);
        await psql(maintenanceUrl.toString(), `CREATE DATABASE ${quoted(databaseName)}`);

        const before = await runDbCommand('status', 'test', {
          TEST_DATABASE_URL: isolated.toString(),
        });
        expect(before.status).toBe(2);
        expect(before.output).toContain('not up to date');
        expect(before.output).toContain('Pending: 001_initial_schema');

        const migrate = await runDbCommand('migrate', 'test', {
          TEST_DATABASE_URL: isolated.toString(),
        });
        expect(migrate.status).toBe(0);

        const after = await runDbCommand('status', 'test', {
          TEST_DATABASE_URL: isolated.toString(),
        });
        expect(after.status).toBe(0);
        expect(after.output).toContain('up to date');
        expect(after.output).toContain('Pending: none');
      } finally {
        await psql(maintenanceUrl.toString(), `DROP DATABASE IF EXISTS ${quoted(databaseName)}`);
      }
    },
  );

  databaseTest('reset requires the development guard and does not target test', async () => {
    const guarded = await runDbCommand('reset', 'test', {
      TEST_DATABASE_URL: testUrl,
      NODE_ENV: 'test',
    });
    expect(guarded.status).not.toBe(0);
    expect(guarded.output).toContain('allowed only with NODE_ENV=development');

    const productionLike = await runDbCommand('reset', 'development', {
      DATABASE_URL: developmentUrl,
      NODE_ENV: 'production',
    });
    expect(productionLike.status).not.toBe(0);
    expect(productionLike.output).toContain('allowed only with NODE_ENV=development');
  });

  it('rejects test/development URL collisions before database access and redacts secrets', async () => {
    const result = await runDbCommand('status', 'test', {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:super-secret@localhost:5432/same',
      TEST_DATABASE_URL: 'postgres://user:super-secret@localhost:5432/same',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('TEST_DATABASE_URL must be different from DATABASE_URL');
    expect(result.output).not.toContain('super-secret');
    expect(result.output).not.toContain('postgres://user:super-secret');
  });

  it('fails safely for an invalid database URL and identifies the configuration field', async () => {
    const result = await runDbCommand('status', 'development', {
      DATABASE_URL: 'not-a-postgres-url',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('database URL must be a valid PostgreSQL URL');
    expect(result.output).not.toContain('not-a-postgres-url');
  });
});
