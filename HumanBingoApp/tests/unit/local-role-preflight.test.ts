import { describe, expect, it } from 'vitest';

type Environment = Record<string, string | undefined>;
type PsqlResult = { stdout: string; stderr: string };
type RoleConfig = {
  applicationUrl: string;
  applicationDatabase: string;
  adminUrl: string;
  adminPassword: string;
  roleName: string;
  rolePassword: string;
};
type PreflightModule = {
  parseLocalDevelopmentTarget: (args?: string[]) => string;
  parseRolePreflightConfig: (environment?: Environment, target?: string) => RoleConfig;
  ensureLocalRole: (
    config: RoleConfig,
    runPsql?: (url: string, args: string[], password: string) => Promise<PsqlResult>,
  ) => Promise<{ created: boolean; roleName: string }>;
  ensureApplicationDatabaseOwner: (
    config: RoleConfig,
    runPsql?: (url: string, args: string[], password: string) => Promise<PsqlResult>,
  ) => Promise<{ changed: boolean; database: string }>;
  redact: (value: string) => string;
};

const preflight = (await import(
  '../../scripts/local-role-preflight.mjs'
)) as unknown as PreflightModule;

const validEnvironment = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://jpty:application-secret@localhost:5432/human_bingo',
  DATABASE_ADMIN_URL: 'postgres://postgres@localhost:5432/postgres',
  DATABASE_ADMIN_PASSWORD: 'administrator-secret',
  DATABASE_ROLE_PASSWORD: 'local-role-secret',
};

describe('local PostgreSQL role preflight', () => {
  it('parses a loopback development URL and keeps the admin credential separate', () => {
    expect(preflight.parseRolePreflightConfig(validEnvironment)).toMatchObject({
      applicationUrl: validEnvironment.DATABASE_URL,
      adminUrl: validEnvironment.DATABASE_ADMIN_URL,
      adminPassword: validEnvironment.DATABASE_ADMIN_PASSWORD,
      roleName: 'jpty',
      rolePassword: validEnvironment.DATABASE_ROLE_PASSWORD,
    });
  });

  it.each([
    ['test environment', { ...validEnvironment, NODE_ENV: 'test' }, 'NODE_ENV=development'],
    [
      'production environment',
      { ...validEnvironment, NODE_ENV: 'production' },
      'NODE_ENV=development',
    ],
    [
      'cloud application URL',
      { ...validEnvironment, DATABASE_URL: 'postgres://jpty@db.example.com:5432/human_bingo' },
      'loopback host',
    ],
    [
      'SSL application URL',
      {
        ...validEnvironment,
        DATABASE_URL: 'postgres://jpty@localhost:5432/human_bingo?sslmode=require',
      },
      'must not enable PostgreSQL SSL',
    ],
    [
      'SSL environment setting',
      { ...validEnvironment, DATABASE_SSL_MODE: 'require' },
      'DATABASE_SSL_MODE=disable',
    ],
    [
      'missing admin URL',
      { ...validEnvironment, DATABASE_ADMIN_URL: '' },
      'DATABASE_ADMIN_URL is required',
    ],
    [
      'missing admin login',
      { ...validEnvironment, DATABASE_ADMIN_URL: 'postgres://localhost:5432/postgres' },
      'must include an administrator login',
    ],
    [
      'missing admin password',
      { ...validEnvironment, DATABASE_ADMIN_PASSWORD: '' },
      'DATABASE_ADMIN_PASSWORD is required',
    ],
  ])('rejects %s before a role-changing operation', (_caseName, environment, message) => {
    expect(() => preflight.parseRolePreflightConfig(environment)).toThrow(message);
  });

  it('rejects a test target even when the process environment is development', () => {
    expect(() => preflight.parseLocalDevelopmentTarget(['--target', 'test'])).toThrow(
      'requires --target development',
    );
  });

  it('does not issue CREATE ROLE when the configured role already exists', async () => {
    const calls: Array<{ args: string[]; password: string }> = [];
    const runner = (_url: string, args: string[], password: string): Promise<PsqlResult> => {
      calls.push({ args, password });
      return Promise.resolve({ stdout: 't\n', stderr: '' });
    };

    const result = await preflight.ensureLocalRole(
      preflight.parseRolePreflightConfig(validEnvironment),
      runner,
    );

    expect(result).toEqual({ created: false, roleName: 'jpty' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.at(-1)).toContain("rolname = :'role_name'");
    expect(calls[0]?.args.at(-1)).not.toContain('CREATE ROLE jpty');
    expect(calls[0]?.password).toBe('administrator-secret');
  });

  it('creates a missing role once, rechecks it, and keeps the SQL identifier parameterized', async () => {
    const calls: Array<{ args: string[]; password: string }> = [];
    const runner = (_url: string, args: string[], password: string): Promise<PsqlResult> => {
      calls.push({ args, password });
      return Promise.resolve({ stdout: calls.length === 1 ? 'f\n' : 't\n', stderr: '' });
    };

    const result = await preflight.ensureLocalRole(
      preflight.parseRolePreflightConfig(validEnvironment),
      runner,
    );

    expect(result).toEqual({ created: true, roleName: 'jpty' });
    expect(calls).toHaveLength(3);
    expect(calls[1]?.args.at(-1)).toContain('CREATE ROLE :"role_name" LOGIN PASSWORD');
    expect(calls[1]?.args.at(-1)).toContain(":'role_password'");
    expect(calls[1]?.args.at(-1)).not.toContain('CREATE ROLE jpty');
    expect(calls.every((call) => call.password === 'administrator-secret')).toBe(true);
  });

  it('is idempotent across repeated bootstrap runs and creates the role only once', async () => {
    const calls: Array<{ args: string[]; password: string }> = [];
    let roleExists = false;
    const runner = (_url: string, args: string[], password: string): Promise<PsqlResult> => {
      calls.push({ args, password });
      const sql = args.at(-1) ?? '';
      if (sql.includes('CREATE ROLE')) {
        roleExists = true;
        return Promise.resolve({ stdout: 't\n', stderr: '' });
      }
      return Promise.resolve({ stdout: roleExists ? 't\n' : 'f\n', stderr: '' });
    };
    const config = preflight.parseRolePreflightConfig(validEnvironment);

    await expect(preflight.ensureLocalRole(config, runner)).resolves.toEqual({
      created: true,
      roleName: 'jpty',
    });
    await expect(preflight.ensureLocalRole(config, runner)).resolves.toEqual({
      created: false,
      roleName: 'jpty',
    });

    expect(calls.filter(({ args }) => (args.at(-1) ?? '').includes('CREATE ROLE'))).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('tolerates concurrent create races and confirms the role without changing it', async () => {
    let roleExists = false;
    let createAttempts = 0;
    const runner = (_url: string, args: string[]): Promise<PsqlResult> => {
      const sql = args.at(-1) ?? '';
      if (!sql.includes('CREATE ROLE')) {
        return Promise.resolve({ stdout: roleExists ? 't\n' : 'f\n', stderr: '' });
      }
      createAttempts += 1;
      if (createAttempts === 1) roleExists = true;
      return Promise.resolve({ stdout: 't\n', stderr: '' });
    };
    const config = preflight.parseRolePreflightConfig(validEnvironment);

    await expect(
      Promise.all([
        preflight.ensureLocalRole(config, runner),
        preflight.ensureLocalRole(config, runner),
      ]),
    ).resolves.toEqual([
      { created: true, roleName: 'jpty' },
      { created: true, roleName: 'jpty' },
    ]);
    expect(createAttempts).toBe(2);

    await expect(preflight.ensureLocalRole(config, runner)).resolves.toEqual({
      created: false,
      roleName: 'jpty',
    });
  });

  it.each([
    [
      'non-loopback administrator URL',
      { ...validEnvironment, DATABASE_ADMIN_URL: 'postgres://postgres@10.0.0.2:5432/postgres' },
      'loopback host',
    ],
    [
      'cloud administrator URL',
      {
        ...validEnvironment,
        DATABASE_ADMIN_URL: 'postgres://postgres@db.example.com:5432/postgres',
      },
      'loopback host',
    ],
    [
      'SSL administrator URL',
      {
        ...validEnvironment,
        DATABASE_ADMIN_URL: 'postgres://postgres@localhost:5432/postgres?sslmode=require',
      },
      'must not enable PostgreSQL SSL',
    ],
    [
      'embedded administrator password',
      {
        ...validEnvironment,
        DATABASE_ADMIN_URL: 'postgres://postgres:secret@localhost:5432/postgres',
      },
      'must not contain a password',
    ],
  ])('rejects %s before role-changing SQL', (_caseName, environment, message) => {
    expect(() => preflight.parseRolePreflightConfig(environment)).toThrow(message);
  });

  it('requires a role password only when a missing role needs creation', async () => {
    const environment = { ...validEnvironment, DATABASE_ROLE_PASSWORD: '' };
    const config = preflight.parseRolePreflightConfig(environment);
    const runner = (): Promise<PsqlResult> => Promise.resolve({ stdout: 'f\n', stderr: '' });

    await expect(preflight.ensureLocalRole(config, runner)).rejects.toThrow(
      'DATABASE_ROLE_PASSWORD is required',
    );
  });

  describe('application database owner alignment', () => {
    it('exposes the parsed application database name on the config', () => {
      expect(preflight.parseRolePreflightConfig(validEnvironment).applicationDatabase).toBe(
        'human_bingo',
      );
    });

    it('rejects an application URL whose database is not a simple identifier', () => {
      expect(() =>
        preflight.parseRolePreflightConfig({
          ...validEnvironment,
          DATABASE_URL: 'postgres://jpty:secret@localhost:5432/bad-db-name',
        }),
      ).toThrow('simple PostgreSQL database');
    });

    it('does not alter ownership when the role already owns the database', async () => {
      const calls: Array<{ args: string[]; password: string }> = [];
      const runner = (_url: string, args: string[], password: string): Promise<PsqlResult> => {
        calls.push({ args, password });
        return Promise.resolve({ stdout: 'f\n', stderr: '' });
      };

      const result = await preflight.ensureApplicationDatabaseOwner(
        preflight.parseRolePreflightConfig(validEnvironment),
        runner,
      );

      expect(result).toEqual({ changed: false, database: 'human_bingo' });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args.at(-1)).toContain("datname = :'db_name'");
      expect(calls[0]?.args.at(-1)).not.toContain('ALTER DATABASE');
      expect(calls[0]?.args).toContain('--set=db_name=human_bingo');
    });

    it('transfers ownership to the application role when another role owns the database', async () => {
      const calls: Array<{ args: string[] }> = [];
      let alreadyAligned = false;
      const runner = (_url: string, args: string[]): Promise<PsqlResult> => {
        calls.push({ args });
        const sql = args.at(-1) ?? '';
        if (sql.includes('ALTER DATABASE')) {
          alreadyAligned = true;
          return Promise.resolve({ stdout: 't\n', stderr: '' });
        }
        return Promise.resolve({ stdout: alreadyAligned ? 'f\n' : 't\n', stderr: '' });
      };

      const result = await preflight.ensureApplicationDatabaseOwner(
        preflight.parseRolePreflightConfig(validEnvironment),
        runner,
      );

      expect(result).toEqual({ changed: true, database: 'human_bingo' });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.args.at(-1)).toContain(
        'ALTER DATABASE :"db_name" OWNER TO :"role_name"',
      );
    });

    it('skips silently when the application database does not exist yet', async () => {
      const runner = (): Promise<PsqlResult> => Promise.resolve({ stdout: '', stderr: '' });

      await expect(
        preflight.ensureApplicationDatabaseOwner(
          preflight.parseRolePreflightConfig(validEnvironment),
          runner,
        ),
      ).resolves.toEqual({ changed: false, database: 'human_bingo' });
    });

    it('surfaces the failure when ownership cannot be transferred', async () => {
      const runner = (): Promise<PsqlResult> =>
        Promise.reject(new Error('permission denied for database human_bingo'));

      await expect(
        preflight.ensureApplicationDatabaseOwner(
          preflight.parseRolePreflightConfig(validEnvironment),
          runner,
        ),
      ).rejects.toThrow('permission denied');
    });
  });

  it('redacts PostgreSQL URLs and credential labels in diagnostics', () => {
    const message = preflight.redact(
      'postgres://jpty:application-secret@localhost:5432/human_bingo DATABASE_ADMIN_PASSWORD=administrator-secret',
    );
    expect(message).not.toContain('application-secret');
    expect(message).not.toContain('administrator-secret');
    expect(message).toContain('postgres://[REDACTED]');
  });
});
