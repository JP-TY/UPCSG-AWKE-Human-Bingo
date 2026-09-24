#!/usr/bin/env node
import './load-env.mjs';
import { URL } from 'node:url';

const environment = process.env;
const nodeEnv = environment.NODE_ENV ?? 'development';
const production = nodeEnv === 'production';
const errors = [];

const required = (name) => {
  const value = environment[name]?.trim();
  if (!value) errors.push(`${name} is required`);
  return value;
};

const databaseUrl = environment.DATABASE_URL?.trim();
const sessionSecret = required('SESSION_SECRET');
const appOrigin = required('PUBLIC_APP_ORIGIN');
const databaseParts = [
  environment.DATABASE_HOST?.trim(),
  environment.DATABASE_NAME?.trim(),
  environment.DATABASE_USER?.trim(),
  environment.DATABASE_PASSWORD?.trim(),
];
const hasDatabaseParts = databaseParts.every(Boolean);
const isUsingDatabaseParts = databaseParts.some(Boolean);

if (!databaseUrl && !hasDatabaseParts) {
  errors.push(
    'DATABASE_URL or DATABASE_HOST, DATABASE_NAME, DATABASE_USER, and DATABASE_PASSWORD are required',
  );
}
if (!databaseUrl && isUsingDatabaseParts && !hasDatabaseParts) {
  errors.push('All split PostgreSQL connection fields must be provided together');
}

if (!['development', 'test', 'production'].includes(nodeEnv)) {
  errors.push('NODE_ENV must be development, test, or production');
}
if (databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      errors.push('DATABASE_URL must use postgres:// or postgresql://');
    }
    if (production && url.hostname === 'localhost') {
      errors.push('DATABASE_URL must not point to localhost in production');
    }
  } catch {
    errors.push('DATABASE_URL must be a valid PostgreSQL URL');
  }
} else if (hasDatabaseParts) {
  const port = Number(environment.DATABASE_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    errors.push('DATABASE_PORT must be an integer between 1 and 65535');
  if (production && environment.DATABASE_HOST?.trim() === 'localhost')
    errors.push('DATABASE_HOST must not point to localhost in production');
}
if (sessionSecret && sessionSecret.length < 32)
  errors.push('SESSION_SECRET must contain at least 32 characters');
if (appOrigin) {
  try {
    const url = new URL(appOrigin);
    if (url.protocol !== 'https:' && production)
      errors.push('PUBLIC_APP_ORIGIN must use HTTPS in production');
    if (url.pathname !== '/' || url.search || url.hash)
      errors.push('PUBLIC_APP_ORIGIN must be an origin without a path, query, or hash');
  } catch {
    errors.push('PUBLIC_APP_ORIGIN must be a valid URL');
  }
}
const port = Number(environment.API_PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  errors.push('API_PORT must be an integer between 1 and 65535');
if (production && environment.DATABASE_SSL_MODE !== 'verify-full') {
  errors.push('DATABASE_SSL_MODE=verify-full is required in production');
}
if (production && !environment.BACKUP_DIR?.trim())
  errors.push('BACKUP_DIR is required in production');
if (production && !environment.WAL_ARCHIVE_DIR?.trim())
  errors.push('WAL_ARCHIVE_DIR is required in production');
if (environment.TEST_DATABASE_URL && production)
  errors.push('TEST_DATABASE_URL must not be set in production');

if (errors.length > 0) {
  console.error(`Environment validation failed:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`Environment validation passed for ${nodeEnv}`);
}
