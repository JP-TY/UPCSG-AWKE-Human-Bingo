export type NodeEnvironment = 'development' | 'test' | 'production';
export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

export interface Environment {
  readonly nodeEnv: NodeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly browserDevPort: number;
  readonly previewPort: number;
  readonly databaseUrl: string;
  readonly databaseSslMode: DatabaseSslMode;
  readonly databaseSslCaPath: string | undefined;
  readonly testDatabaseUrl: string | undefined;
  readonly sessionSecret: string;
  readonly publicAppOrigin: string;
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  readonly apiPath: string;
  readonly wsPath: string;
  readonly shutdownTimeoutMs: number;
  readonly composeDatabaseUser: string | undefined;
  readonly composeDatabasePassword: string | undefined;
  readonly composeDatabaseName: string | undefined;
}

export class EnvironmentValidationError extends Error {
  public readonly variable: string | undefined;

  public constructor(message: string, variable?: string) {
    super(message);
    this.name = 'EnvironmentValidationError';
    this.variable = variable;
  }
}

const values = (source: NodeJS.ProcessEnv): Record<string, string | undefined> => source;
const text = (
  source: Record<string, string | undefined>,
  key: string,
  fallback?: string,
): string => {
  const value = source[key]?.trim() || fallback;
  if (!value) throw new EnvironmentValidationError(`${key} is required`, key);
  return value;
};
const integer = (
  source: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min = 1,
  max = 65535,
): number => {
  const raw = source[key]?.trim() || String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvironmentValidationError(
      `${key} must be an integer between ${min} and ${max}`,
      key,
    );
  }
  return value;
};
const postgresUrl = (
  source: Record<string, string | undefined>,
  key: string,
  requiredValue: boolean,
): string | undefined => {
  const raw = source[key]?.trim();
  if (!raw && !requiredValue) return undefined;
  const value =
    raw ||
    (() => {
      throw new EnvironmentValidationError(`${key} is required`, key);
    })();
  try {
    const parsed = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname === '/'
    )
      throw new Error();
  } catch {
    throw new EnvironmentValidationError(`${key} must be a valid PostgreSQL URL`, key);
  }
  return value;
};

// node-postgres parses SSL-related connection-string parameters after the
// explicit `ssl` config object and replaces that object. Keep TLS policy in
// DATABASE_SSL_MODE / DATABASE_SSL_CA_PATH, not in the URL.
const normalizePostgresConnectionString = (
  value: string,
): { readonly url: string; readonly sslCaPath: string | undefined } => {
  const url = new URL(value);
  const sslCaPath = url.searchParams.get('sslrootcert')?.trim() || undefined;
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith('ssl') || normalizedKey === 'uselibpqcompat') {
      url.searchParams.delete(key);
    }
  }
  return { url: url.toString(), sslCaPath };
};

const databaseConnection = (
  source: Record<string, string | undefined>,
  nodeEnv: NodeEnvironment,
): {
  readonly url: string;
  readonly sslMode: DatabaseSslMode;
  readonly sslCaPath: string | undefined;
} => {
  const configuredMode = source.DATABASE_SSL_MODE?.trim();
  const sslMode = (configuredMode ||
    (nodeEnv === 'production' ? 'verify-full' : 'disable')) as DatabaseSslMode;
  if (!['disable', 'require', 'verify-full'].includes(sslMode)) {
    throw new EnvironmentValidationError(
      'DATABASE_SSL_MODE must be disable, require, or verify-full',
      'DATABASE_SSL_MODE',
    );
  }

  const directUrl = source.DATABASE_URL?.trim();
  if (directUrl) {
    const url = postgresUrl(source, 'DATABASE_URL', true)!;
    return { ...normalizePostgresConnectionString(url), sslMode };
  }

  const host = text(source, 'DATABASE_HOST');
  const port = integer(source, 'DATABASE_PORT', 5432);
  const database = text(source, 'DATABASE_NAME');
  const user = text(source, 'DATABASE_USER');
  const password = text(source, 'DATABASE_PASSWORD');
  const url = new URL(
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`,
  );
  const validatedUrl = postgresUrl({ DATABASE_URL: url.toString() }, 'DATABASE_URL', true)!;
  return { ...normalizePostgresConnectionString(validatedUrl), sslMode };
};
const origin = (
  source: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string => {
  const value = text(source, key, fallback);
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
    return parsed.origin;
  } catch {
    throw new EnvironmentValidationError(`${key} must be an HTTP(S) origin`, key);
  }
};
const path = (
  source: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string => {
  const value = text(source, key, fallback);
  if (
    !value.startsWith('/') ||
    value.includes('://') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new EnvironmentValidationError(`${key} must be an endpoint path beginning with /`, key);
  }
  return `/${value.replace(/^\/+|\/+$/g, '')}` === '//'
    ? '/'
    : `/${value.replace(/^\/+|\/+$/g, '')}`;
};

export const redactEnvironment = (
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> => {
  const secret = /(SECRET|PASSWORD|PRIVATE|TOKEN|KEY|DATABASE_URL)/i;
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      secret.test(key) ? '[REDACTED]' : value,
    ]),
  );
};

export const readEnvironment = (source: NodeJS.ProcessEnv = process.env): Environment => {
  const environment = values(source);
  const nodeEnv = text(environment, 'NODE_ENV', 'development') as NodeEnvironment;
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new EnvironmentValidationError(
      'NODE_ENV must be development, test, or production',
      'NODE_ENV',
    );
  }
  const database = databaseConnection(environment, nodeEnv);
  const databaseUrl = database.url;
  const testDatabaseUrl = postgresUrl(environment, 'TEST_DATABASE_URL', nodeEnv === 'test');
  if (nodeEnv === 'test' && testDatabaseUrl === databaseUrl) {
    throw new EnvironmentValidationError(
      'TEST_DATABASE_URL must be different from DATABASE_URL',
      'TEST_DATABASE_URL',
    );
  }
  const sessionSecret = text(environment, 'SESSION_SECRET');
  if (sessionSecret.length < 32)
    throw new EnvironmentValidationError(
      'SESSION_SECRET must contain at least 32 characters',
      'SESSION_SECRET',
    );
  const apiPath = path(environment, 'API_PATH', '/api');
  const wsPath = path(environment, 'WS_PATH', '/ws');
  return {
    nodeEnv,
    host: text(environment, 'HOST', '127.0.0.1'),
    port: integer(environment, 'PORT', integer(environment, 'API_PORT', 3000)),
    browserDevPort: integer(environment, 'BROWSER_DEV_PORT', 5173),
    previewPort: integer(environment, 'PREVIEW_PORT', 4173),
    databaseUrl,
    databaseSslMode: database.sslMode,
    databaseSslCaPath:
      environment.DATABASE_SSL_CA_PATH?.trim() || database.sslCaPath,
    testDatabaseUrl,
    sessionSecret,
    publicAppOrigin: origin(environment, 'PUBLIC_APP_ORIGIN', 'http://localhost:4173'),
    apiBaseUrl: text(environment, 'API_BASE_URL', apiPath),
    wsUrl: text(environment, 'WS_URL', wsPath),
    apiPath,
    wsPath,
    shutdownTimeoutMs: integer(environment, 'SHUTDOWN_TIMEOUT_MS', 10000, 1, 300000),
    composeDatabaseUser: environment.COMPOSE_DATABASE_USER?.trim() || undefined,
    composeDatabasePassword: environment.COMPOSE_DATABASE_PASSWORD?.trim() || undefined,
    composeDatabaseName: environment.COMPOSE_DATABASE_NAME?.trim() || undefined,
  };
};
