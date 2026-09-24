import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const composeFile = resolve(repositoryRoot, 'docker-compose.yml');
const composeText = readFileSync(composeFile, 'utf8');

function dockerComposeAvailable(): boolean {
  return (
    spawnSync('docker', ['compose', 'version'], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    }).status === 0
  );
}

const composeCanRun = dockerComposeAvailable();

const expectedPublishedPort = ((): string => {
  const defaultPort = composeText.match(/\$\{POSTGRES_PORT:-(\d+)\}/)?.[1] ?? '5432';
  const dotEnvFile = resolve(repositoryRoot, '.env');
  const dotEnvText = existsSync(dotEnvFile) ? readFileSync(dotEnvFile, 'utf8') : '';
  return dotEnvText.match(/^POSTGRES_PORT=(\d+)$/m)?.[1] ?? defaultPort;
})();

describe('local PostgreSQL Compose configuration', () => {
  it('declares a pinned image, local-only port, named volume, and healthcheck', () => {
    expect(composeText).toMatch(/image:\s*postgres:\d+\.\d+(?:\.\d+)?-alpine/);
    expect(composeText).toMatch(/127\.0\.0\.1:\$\{POSTGRES_PORT:-\d+\}:5432/);
    expect(composeText).toContain('human-bingo-postgres-data:/var/lib/postgresql/data');
    expect(composeText).toContain('name: human-bingo-postgres-data');
    expect(composeText).toContain('pg_isready');
    expect(composeText).toMatch(/interval:\s*\d+s/);
    expect(composeText).toMatch(/timeout:\s*\d+s/);
    expect(composeText).toMatch(/retries:\s*\d+/);
    expect(readFileSync(resolve(repositoryRoot, 'docs/testing.md'), 'utf8')).toContain(
      'Application migrations remain explicit',
    );
  });

  it.skipIf(!composeCanRun)('renders a valid Compose model without starting containers', () => {
    const result = execFileSync(
      'docker',
      ['compose', '-f', composeFile, 'config', '--format', 'json'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
      },
    );
    const model = JSON.parse(result) as {
      services: Record<
        string,
        {
          image: string;
          ports: string[];
          volumes: string[];
          healthcheck?: { test: string[] };
        }
      >;
      volumes: Record<string, unknown>;
    };
    const postgres = model.services.postgres;

    expect(postgres.image).toBe('postgres:16.6-alpine');
    expect(postgres.ports).toEqual([
      expect.objectContaining({
        host_ip: '127.0.0.1',
        published: expectedPublishedPort,
        target: 5432,
      }),
    ]);
    expect(postgres.volumes).toEqual([
      expect.objectContaining({
        source: 'human-bingo-postgres-data',
        target: '/var/lib/postgresql/data',
        type: 'volume',
      }),
    ]);
    expect(postgres.healthcheck?.test.join(' ')).toContain('pg_isready');
    expect(model.volumes['human-bingo-postgres-data']).toBeDefined();
  });

  it('documents safe teardown and explicit destructive volume removal', () => {
    const testingDocs = readFileSync(resolve(repositoryRoot, 'docs/testing.md'), 'utf8');

    expect(testingDocs).toContain('docker compose down');
    expect(testingDocs).toContain('while preserving the named');
    expect(testingDocs).toContain('DESTRUCTIVE');
    expect(testingDocs).toContain('docker compose down -v');
    expect(testingDocs).toContain('deletes local database data');
  });

  it('keeps the Compose definition at the repository root', () => {
    expect(existsSync(composeFile)).toBe(true);
  });
});
