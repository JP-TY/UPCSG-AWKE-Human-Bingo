import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const configured = process.env.RUN_LOCAL_ROLE_DB_TESTS === '1';
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const adminDatabaseUrl = process.env.DATABASE_ADMIN_URL?.trim();
const adminPassword = process.env.DATABASE_ADMIN_PASSWORD;
const databaseTests = configured && Boolean(testDatabaseUrl && adminDatabaseUrl && adminPassword);

type PsqlResult = { stdout: string; stderr: string };
type PreflightModule = {
  parseRolePreflightConfig: (
    environment: Record<string, string | undefined>,
    target?: string,
  ) => {
    applicationUrl: string;
    adminUrl: string;
    adminPassword: string;
    roleName: string;
    rolePassword: string;
  };
  ensureLocalRole: (
    config: {
      applicationUrl: string;
      adminUrl: string;
      adminPassword: string;
      roleName: string;
      rolePassword: string;
    },
    runPsql?: (url: string, args: string[], password: string) => Promise<PsqlResult>,
  ) => Promise<{ created: boolean; roleName: string }>;
};

const preflight = (await import(
  '../../scripts/local-role-preflight.mjs'
)) as unknown as PreflightModule;

const runPsql = async (url: string, args: string[], password: string): Promise<PsqlResult> => {
  const sql = args.at(-1) as string;
  const sqlFromStdin = args.at(-2) === '--file=-';
  const psqlArgs = sqlFromStdin ? args.slice(0, -1) : args;
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      'psql',
      ['--dbname', url, ...psqlArgs],
      {
        cwd: process.cwd(),
        env: { ...process.env, PGPASSWORD: password },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve({ stdout, stderr });
      },
    );
    if (sqlFromStdin) child.stdin?.end(`${sql}\n`);
    else child.stdin?.end();
  });
  return result;
};

const scalar = async (url: string, sql: string, password: string): Promise<string> => {
  const result = await runPsql(
    url,
    [
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    password,
  );
  return result.stdout.trim();
};

describe.skipIf(!databaseTests)('isolated local role bootstrap database checks', () => {
  it('creates a missing role, tolerates concurrent/repeated bootstrap, and preserves sentinel data', async () => {
    const isolatedUrl = new URL(testDatabaseUrl as string);
    const roleName = `task42_${process.pid}`;
    const rolePassword = `task42_password_${process.pid}`;
    isolatedUrl.username = roleName;
    isolatedUrl.password = 'application-placeholder';

    const sentinelTable = `task42_sentinel_${process.pid}`;
    const adminTestUrl = new URL(adminDatabaseUrl as string);
    adminTestUrl.pathname = new URL(testDatabaseUrl as string).pathname;
    await runPsql(
      adminTestUrl.toString(),
      [
        '--no-psqlrc',
        '--quiet',
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `CREATE TABLE IF NOT EXISTS ${sentinelTable} (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO ${sentinelTable} (id, value) VALUES (1, 'preserve-me') ON CONFLICT (id) DO NOTHING;`,
      ],
      adminPassword as string,
    );

    const config = preflight.parseRolePreflightConfig({
      NODE_ENV: 'development',
      DATABASE_URL: isolatedUrl.toString(),
      DATABASE_ADMIN_URL: adminDatabaseUrl as string,
      DATABASE_ADMIN_PASSWORD: adminPassword as string,
      DATABASE_ROLE: roleName,
      DATABASE_ROLE_PASSWORD: rolePassword,
      DATABASE_SSL_MODE: 'disable',
    });

    const [first, second] = await Promise.all([
      preflight.ensureLocalRole(config, runPsql),
      preflight.ensureLocalRole(config, runPsql),
    ]);
    expect(first).toEqual({ created: true, roleName });
    expect(second).toEqual({ created: true, roleName });
    await expect(preflight.ensureLocalRole(config, runPsql)).resolves.toEqual({
      created: false,
      roleName,
    });

    await expect(
      scalar(
        adminTestUrl.toString(),
        `SELECT value FROM ${sentinelTable} WHERE id = 1;`,
        adminPassword as string,
      ),
    ).resolves.toBe('preserve-me');
    await expect(
      scalar(
        adminDatabaseUrl as string,
        'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ' + `'${roleName}');`,
        adminPassword as string,
      ),
    ).resolves.toBe('t');
  });
});
