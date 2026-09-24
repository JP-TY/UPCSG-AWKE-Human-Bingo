#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ROLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/u;
const ROLE_EXISTS_SQL = "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name');";
const CREATE_ROLE_SQL = 'CREATE ROLE :"role_name" LOGIN PASSWORD :\'role_password\';';
const DB_OWNER_MISMATCH_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM pg_database
    WHERE datname = :'db_name' AND pg_get_userbyid(datdba) <> :'role_name'
  );
`;
const ALTER_DB_OWNER_SQL = 'ALTER DATABASE :"db_name" OWNER TO :"role_name";';

export function parseLocalDevelopmentTarget(args = []) {
  const targetIndex = args.indexOf('--target');
  if (targetIndex === -1) return 'development';
  const target = args[targetIndex + 1];
  if (target !== 'development' || args.length !== 2 || targetIndex !== 0) {
    throw new Error('local role bootstrap requires --target development');
  }
  return target;
}

export function parseRolePreflightConfig(environment = process.env, target = 'development') {
  if (environment.NODE_ENV !== 'development') {
    throw new Error('local role bootstrap requires NODE_ENV=development');
  }
  if (target !== 'development') {
    throw new Error('local role bootstrap requires the development target');
  }

  const application = parseLocalPostgresUrl(environment.DATABASE_URL, 'DATABASE_URL');
  const admin = parseLocalPostgresUrl(environment.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL');
  if (admin.password) {
    throw new Error('DATABASE_ADMIN_URL must not contain a password; use DATABASE_ADMIN_PASSWORD');
  }
  if (!admin.username) {
    throw new Error('DATABASE_ADMIN_URL must include an administrator login');
  }
  if (!environment.DATABASE_ADMIN_PASSWORD) {
    throw new Error('DATABASE_ADMIN_PASSWORD is required for local role bootstrap');
  }
  if (environment.DATABASE_SSL_MODE && environment.DATABASE_SSL_MODE !== 'disable') {
    throw new Error('local role bootstrap requires DATABASE_SSL_MODE=disable');
  }

  let urlRole;
  try {
    urlRole = decodeURIComponent(application.username);
  } catch {
    throw new Error('DATABASE_URL contains an invalid database role');
  }
  const configuredRole = environment.DATABASE_ROLE?.trim();
  if (configuredRole && urlRole && configuredRole !== urlRole) {
    throw new Error('DATABASE_ROLE must match the DATABASE_URL login role');
  }
  const roleName = configuredRole || urlRole || 'jpty';
  if (!ROLE_NAME_PATTERN.test(roleName)) {
    throw new Error('DATABASE_ROLE must be a simple PostgreSQL role name');
  }

  let applicationDatabase;
  try {
    applicationDatabase = decodeURIComponent(application.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL contains an invalid database name');
  }
  if (!ROLE_NAME_PATTERN.test(applicationDatabase)) {
    throw new Error('DATABASE_URL must name a simple PostgreSQL database');
  }

  return Object.freeze({
    applicationUrl: application.url,
    applicationDatabase,
    adminUrl: admin.url,
    adminPassword: environment.DATABASE_ADMIN_PASSWORD,
    roleName,
    rolePassword: environment.DATABASE_ROLE_PASSWORD ?? '',
  });
}

export async function ensureLocalRole(config, runPsql = runPsqlCommand) {
  const existsArgs = psqlVariableArgs(config.roleName, config.rolePassword, ROLE_EXISTS_SQL);
  const existing = await runPsql(config.adminUrl, existsArgs, config.adminPassword);
  if (isTrue(existing.stdout)) {
    return { created: false, roleName: config.roleName };
  }
  if (!config.rolePassword) {
    throw new Error('DATABASE_ROLE_PASSWORD is required before creating the missing local role');
  }

  try {
    await runPsql(
      config.adminUrl,
      psqlVariableArgs(config.roleName, config.rolePassword, CREATE_ROLE_SQL),
      config.adminPassword,
    );
  } catch (error) {
    if (!isDuplicateRoleError(error)) throw error;
    // Another local bootstrap won the race; never alter its role.
  }
  const confirmed = await runPsql(config.adminUrl, existsArgs, config.adminPassword);
  if (!isTrue(confirmed.stdout)) {
    throw new Error(`local role ${config.roleName} was not present after the bootstrap attempt`);
  }
  return { created: true, roleName: config.roleName };
}

/**
 * Ensures the application login owns the application database so migrations
 * and schema changes work under PostgreSQL 15+ `public` schema ownership
 * rules. The admin connection owns `ALTER DATABASE ... OWNER TO ...`; the
 * check is idempotent and never touches an already-correct database, and it
 * skips silently when the database does not exist yet (creation follows).
 */
export async function ensureApplicationDatabaseOwner(config, runPsql = runPsqlCommand) {
  const checkArgs = psqlVariableArgs(
    config.roleName,
    '',
    DB_OWNER_MISMATCH_SQL,
    config.applicationDatabase,
  );
  const check = await runPsql(config.adminUrl, checkArgs, config.adminPassword);
  if (!isTrue(check.stdout)) {
    return { changed: false, database: config.applicationDatabase };
  }
  await runPsql(
    config.adminUrl,
    psqlVariableArgs(config.roleName, '', ALTER_DB_OWNER_SQL, config.applicationDatabase),
    config.adminPassword,
  );
  return { changed: true, database: config.applicationDatabase };
}

function isDuplicateRoleError(error) {
  return /duplicate|already exists/iu.test(error instanceof Error ? error.message : String(error));
}

function parseLocalPostgresUrl(value, field) {
  if (!value?.trim()) throw new Error(`${field} is required for local role bootstrap`);
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${field} must be a valid PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${field} must use the PostgreSQL protocol`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`${field} must use a loopback host`);
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error(`${field} must include a database name`);
  }
  const sslMode = parsed.searchParams.get('sslmode');
  if (sslMode && sslMode !== 'disable') {
    throw new Error(`${field} must not enable PostgreSQL SSL for local bootstrap`);
  }
  return { url: parsed.toString(), username: parsed.username, password: parsed.password, pathname: parsed.pathname };
}

function psqlVariableArgs(roleName, rolePassword, sql, dbName = '') {
  const sets = [
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--set=ON_ERROR_STOP=1',
    `--set=role_name=${roleName}`,
    `--set=role_password=${rolePassword}`,
  ];
  if (dbName) sets.push(`--set=db_name=${dbName}`);
  return [...sets, '--file=-', sql];
}

function isTrue(output) {
  return /^(?:t|true)$/iu.test(output.trim());
}

function runPsqlCommand(databaseUrl, args, password) {
  return new Promise((resolve, reject) => {
    const sql = args.at(-1);
    const psqlArgs = args.at(-2) === '--file=-' ? args.slice(0, -1) : args;
    const child = spawn('psql', ['--dbname', databaseUrl, ...psqlArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, PGPASSWORD: password },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => reject(new Error(redact(error.message))));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            redact(stderr.trim() || `psql exited with ${code ?? signal ?? 'unknown status'}`),
          ),
        );
    });
    if (args.at(-2) === '--file=-') child.stdin.end(`${sql}\n`);
    else child.stdin.end();
  });
}

export function redact(value) {
  return value
    .replace(/(postgres(?:ql)?:\/\/)[^\s'"`]+/giu, '$1[REDACTED]')
    .replace(
      /(PGPASSWORD|password|DATABASE_ADMIN_PASSWORD|DATABASE_ROLE_PASSWORD)[^\s]*/giu,
      '$1=[REDACTED]',
    );
}

export const rolePreflightSql = Object.freeze({
  ROLE_EXISTS_SQL,
  CREATE_ROLE_SQL,
  DB_OWNER_MISMATCH_SQL,
  ALTER_DB_OWNER_SQL,
});
