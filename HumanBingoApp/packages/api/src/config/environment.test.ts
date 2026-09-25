import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EnvironmentValidationError, readEnvironment, redactEnvironment } from './environment.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://localhost:5432/human_bingo',
  TEST_DATABASE_URL: 'postgres://localhost:5432/human_bingo_test',
  SESSION_SECRET: 'a'.repeat(32),
  PUBLIC_APP_ORIGIN: 'http://localhost:4173',
};

describe('readEnvironment', () => {
  it('loads typed defaults and normalizes endpoint paths', () => {
    const config = readEnvironment(base);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      browserDevPort: 5173,
      previewPort: 4173,
      apiPath: '/api',
      wsPath: '/ws',
    });
  });
  it('requires a test database and rejects a development collision', () => {
    expect(() =>
      readEnvironment({ ...base, NODE_ENV: 'test', TEST_DATABASE_URL: base.DATABASE_URL }),
    ).toThrow('TEST_DATABASE_URL must be different');
    expect(() =>
      readEnvironment({ ...base, NODE_ENV: 'test', TEST_DATABASE_URL: undefined }),
    ).toThrow('TEST_DATABASE_URL is required');
  });
  it('builds a TLS PostgreSQL URL from ECS secret fields when no URL is injected', () => {
    const config = readEnvironment({
      NODE_ENV: 'production',
      DATABASE_HOST: 'human-bingo.cluster-example.us-east-1.rds.amazonaws.com',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'human_bingo',
      DATABASE_USER: 'human_bingo',
      DATABASE_PASSWORD: 'p@ss:/?word',
      SESSION_SECRET: 'b'.repeat(48),
      PUBLIC_APP_ORIGIN: 'https://d1234567890.cloudfront.net',
    });

    const parsed = new URL(config.databaseUrl);
    expect(parsed.hostname).toBe('human-bingo.cluster-example.us-east-1.rds.amazonaws.com');
    expect(parsed.pathname).toBe('/human_bingo');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:/?word');
    expect(parsed.searchParams.has('sslmode')).toBe(false);
    expect(config.databaseSslMode).toBe('verify-full');
  });
  it('preserves the explicit PostgreSQL CA bundle when pg parses the connection string', () => {
    const config = readEnvironment({
      NODE_ENV: 'production',
      DATABASE_HOST: 'human-bingo.cluster-example.us-east-1.rds.amazonaws.com',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'human_bingo',
      DATABASE_USER: 'human_bingo',
      DATABASE_PASSWORD: 'secret',
      SESSION_SECRET: 'b'.repeat(48),
      PUBLIC_APP_ORIGIN: 'https://d1234567890.cloudfront.net',
    });
    const caBundle = 'test-rds-ca-bundle';
    const client = new Client({
      connectionString: config.databaseUrl,
      ssl: { ca: caBundle, rejectUnauthorized: true },
    });
    const connectionParameters = client as unknown as {
      connectionParameters: { ssl: { ca?: string; rejectUnauthorized?: boolean } };
    };

    expect(connectionParameters.connectionParameters.ssl).toEqual({
      ca: caBundle,
      rejectUnauthorized: true,
    });
  });
  it('removes SSL query options from direct URLs while preserving unrelated options', () => {
    const config = readEnvironment({
      ...base,
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_URL:
        'postgres://localhost:5432/human_bingo?sslmode=require&sslrootcert=%2Ftmp%2Frds-ca.pem&application_name=human-bingo',
    });
    const parsed = new URL(config.databaseUrl);

    expect(parsed.searchParams.get('application_name')).toBe('human-bingo');
    expect(parsed.searchParams.has('sslmode')).toBe(false);
    expect(parsed.searchParams.has('sslrootcert')).toBe(false);
    expect(config.databaseSslMode).toBe('verify-full');
  });
  it('rejects malformed URLs, ports, and short secrets without exposing values', () => {
    expect(() => readEnvironment({ ...base, DATABASE_URL: 'not-a-url' })).toThrow(
      EnvironmentValidationError,
    );
    expect(() => readEnvironment({ ...base, PORT: '0' })).toThrow('PORT must be an integer');
    expect(() => readEnvironment({ ...base, SESSION_SECRET: 'secret' })).toThrow('at least 32');
  });
  it('redacts secrets and connection strings', () => {
    expect(
      redactEnvironment({
        DATABASE_URL: base.DATABASE_URL,
        SESSION_SECRET: base.SESSION_SECRET,
        NODE_ENV: 'test',
      }),
    ).toEqual({ DATABASE_URL: '[REDACTED]', SESSION_SECRET: '[REDACTED]', NODE_ENV: 'test' });
  });
});

describe('validate-environment smoke command', () => {
  it('reports invalid variables and never prints secret values', () => {
    const secret = 'super-secret-value-that-must-not-leak';
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/validate-environment.mjs',
    );
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: 'not-a-postgres-url',
        SESSION_SECRET: secret,
        PUBLIC_APP_ORIGIN: 'http://localhost:4173',
        API_PORT: '0',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL must be a valid PostgreSQL URL');
    expect(result.stderr).toContain('API_PORT must be an integer');
    expect(result.stderr).not.toContain(secret);
  });

  it('accepts valid test configuration only when its database is isolated', () => {
    expect(() =>
      readEnvironment({
        ...base,
        NODE_ENV: 'test',
        TEST_DATABASE_URL: 'postgres://localhost:5432/isolated_test',
      }),
    ).not.toThrow();
    expect(() =>
      readEnvironment({ ...base, NODE_ENV: 'test', TEST_DATABASE_URL: base.DATABASE_URL }),
    ).toThrow('TEST_DATABASE_URL must be different');
  });

  it('accepts split secret-backed PostgreSQL fields for the AWS task runtime', () => {
    const script = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../scripts/validate-environment.mjs',
    );
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: '',
        TEST_DATABASE_URL: '',
        DATABASE_HOST: 'human-bingo.cluster-example.us-east-1.rds.amazonaws.com',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'human_bingo',
        DATABASE_USER: 'human_bingo',
        DATABASE_PASSWORD: 'runtime-secret-value',
        DATABASE_SSL_MODE: 'verify-full',
        SESSION_SECRET: 'c'.repeat(48),
        PUBLIC_APP_ORIGIN: 'https://d1234567890.cloudfront.net',
        BACKUP_DIR: '/var/backups/human-bingo',
        WAL_ARCHIVE_DIR: '/var/backups/human-bingo/wal',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Environment validation passed for production');
    expect(result.stdout + result.stderr).not.toContain('runtime-secret-value');
  });
});
