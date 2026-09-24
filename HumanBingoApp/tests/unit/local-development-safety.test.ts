import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const dbScript = readFileSync(resolve(root, 'scripts/db.mjs'), 'utf8');
const bootstrapScript = readFileSync(resolve(root, 'scripts/dev-bootstrap.mjs'), 'utf8');
const composeFile = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
const testingDocs = readFileSync(resolve(root, 'docs/testing.md'), 'utf8');

const runDbReset = (environment: Record<string, string>) =>
  spawnSync(
    process.execPath,
    ['scripts/db.mjs', 'reset', '--target', environment.DB_TARGET ?? 'development'],
    {
      cwd: root,
      env: { ...process.env, ...environment },
      encoding: 'utf8',
    },
  );

describe('local database safety boundaries', () => {
  it('keeps db:reset explicit, development-only, and local-host guarded', () => {
    expect(dbScript).toContain("command === 'reset'");
    expect(dbScript).toContain("nodeEnv !== 'development' || target !== 'development'");
    expect(dbScript).toContain('db:reset requires a local PostgreSQL host');

    const testTarget = runDbReset({
      NODE_ENV: 'test',
      DB_TARGET: 'test',
      TEST_DATABASE_URL: 'postgres://localhost:5432/human_bingo_test',
    });
    expect(testTarget.status).not.toBe(0);
    expect(`${testTarget.stdout}${testTarget.stderr}`).toContain(
      'db:reset is allowed only with NODE_ENV=development and --target development',
    );

    const productionTarget = runDbReset({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://db.example.com:5432/human_bingo',
    });
    expect(productionTarget.status).not.toBe(0);
    expect(`${productionTarget.stdout}${productionTarget.stderr}`).toContain(
      'db:reset requires a local PostgreSQL host',
    );
  });

  it('does not call reset or destructive Compose teardown from bootstrap', () => {
    expect(bootstrapScript).not.toContain("'reset'");
    expect(bootstrapScript).not.toContain("['down'");
    expect(composeFile).toContain('human-bingo-postgres-data:');
    expect(composeFile).toContain('- human-bingo-postgres-data:/var/lib/postgresql/data');
    expect(testingDocs).toContain('docker compose down');
    expect(testingDocs).toContain('preserving the named `human-bingo-postgres-data` volume');
    expect(testingDocs).toContain('docker compose down -v');
  });

  it('keeps Compose volume inspection non-destructive when Compose is available', () => {
    const available =
      spawnSync('docker', ['compose', 'version'], {
        cwd: root,
        stdio: 'ignore',
      }).status === 0;
    if (!available) return;

    const model = JSON.parse(
      execFileSync('docker', ['compose', 'config', '--format', 'json'], {
        cwd: root,
        encoding: 'utf8',
      }),
    ) as { volumes?: Record<string, { name?: string }> };
    expect(model.volumes?.['human-bingo-postgres-data']?.name).toBe('human-bingo-postgres-data');
  });
});
