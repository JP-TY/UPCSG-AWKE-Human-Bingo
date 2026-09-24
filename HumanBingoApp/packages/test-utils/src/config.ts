export interface PropertyTestOptions {
  readonly numRuns: number;
  readonly seed: number;
}

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

/** Shared fast-check defaults: enough coverage for CI and a reproducible failure seed. */
export const readPropertyTestOptions = (
  source: NodeJS.ProcessEnv = process.env,
): PropertyTestOptions => ({
  numRuns: Math.max(100, parseInteger(source.FAST_CHECK_NUM_RUNS, 100)),
  seed: parseInteger(source.FAST_CHECK_SEED, 20250308),
});

export interface DatabaseTestConfig {
  readonly enabled: boolean;
  readonly schema: string;
  readonly reset: boolean;
  readonly maxConnections: number;
  readonly url?: string;
}

export class DatabaseTestConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DatabaseTestConfigurationError';
  }
}

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = parseInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
};

/** Reads an explicitly test-scoped PostgreSQL configuration and refuses production URLs. */
export const readDatabaseTestConfig = (
  source: NodeJS.ProcessEnv = process.env,
): DatabaseTestConfig => {
  const enabled = source.RUN_DATABASE_TESTS !== '0';
  const schema = source.TEST_DATABASE_SCHEMA?.trim() || `test_${process.pid}`;
  const reset = source.TEST_DATABASE_RESET !== '0';
  const maxConnections = parsePositiveInteger(source.TEST_DATABASE_MAX_CONNECTIONS, 4);
  const url = source.TEST_DATABASE_URL?.trim();

  if (!enabled) {
    return { enabled, schema, reset, maxConnections };
  }
  if (!url) {
    return { enabled, schema, reset, maxConnections };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseTestConfigurationError('TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseTestConfigurationError(
      'TEST_DATABASE_URL must use postgres:// or postgresql://',
    );
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new DatabaseTestConfigurationError('TEST_DATABASE_URL must include a database name');
  }

  return { enabled, schema, reset, maxConnections, url };
};

export const requireDatabaseTestConfig = (
  source: NodeJS.ProcessEnv = process.env,
): DatabaseTestConfig & { readonly url: string } => {
  const config = readDatabaseTestConfig(source);
  if (!config.enabled) {
    throw new DatabaseTestConfigurationError('Database tests are disabled by RUN_DATABASE_TESTS=0');
  }
  const configuredUrl = config.url;
  if (!configuredUrl) {
    throw new DatabaseTestConfigurationError(
      'Set TEST_DATABASE_URL to an isolated PostgreSQL test database before running database tests',
    );
  }
  if (source.NODE_ENV !== 'test') {
    throw new DatabaseTestConfigurationError('Database tests require NODE_ENV=test');
  }
  return { ...config, url: configuredUrl };
};
