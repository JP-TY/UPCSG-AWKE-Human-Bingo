import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

const read = (file: string) => readFile(resolve(root, file), 'utf8');

const commandInCodeBlock = (readme: string, command: string): boolean =>
  readme.includes(`npm run ${command}`) || readme.includes(`npm test`);

describe('README first-run workflow', () => {
  it('documents executable root scripts and database commands', async () => {
    const [readme, packageJson, dbScript] = await Promise.all([
      read('README.md'),
      read('package.json').then(JSON.parse) as Promise<{ scripts: Record<string, string> }>,
      read('scripts/db.mjs'),
    ]);

    const documentedCommands = [
      'validate:environment',
      'dev',
      'start',
      'preview',
      'db:wait',
      'db:create',
      'db:migrate',
      'db:reset',
      'db:status',
      'test:integration',
    ];

    for (const command of documentedCommands) {
      expect(packageJson.scripts, `README documents npm run ${command}`).toHaveProperty(command);
      expect(commandInCodeBlock(readme, command), `README includes npm run ${command}`).toBe(true);
    }

    expect(readme.indexOf('npm install')).toBeLessThan(readme.indexOf('cp .env.example .env'));
    expect(readme.indexOf('cp .env.example .env')).toBeLessThan(
      readme.indexOf('npm run validate:environment'),
    );
    expect(readme.indexOf('npm run validate:environment')).toBeLessThan(
      readme.indexOf('docker compose up -d postgres'),
    );
    expect(readme.indexOf('docker compose up -d postgres')).toBeLessThan(
      readme.indexOf('npm run db:wait'),
    );
    expect(readme.indexOf('npm run db:wait')).toBeLessThan(readme.indexOf('npm run db:create'));
    expect(readme.indexOf('npm run db:create')).toBeLessThan(readme.indexOf('npm run db:migrate'));
    expect(readme.indexOf('npm run db:migrate')).toBeLessThan(readme.indexOf('npm run db:status'));
    expect(readme.indexOf('npm run db:status')).toBeLessThan(readme.indexOf('npm run build'));

    for (const operation of ['wait', 'create', 'migrate', 'reset', 'status']) {
      expect(dbScript).toContain(`'${operation}'`);
    }
    expect(dbScript).toContain("['development', 'test']");
  });

  it('documents URLs and endpoint paths that match environment and Vite configuration', async () => {
    const [readme, envExample, viteConfig] = await Promise.all([
      read('README.md'),
      read('.env.example'),
      read('vite.config.ts'),
    ]);

    for (const value of [
      'BROWSER_DEV_PORT=5173',
      'PREVIEW_PORT=4173',
      'API_PATH=/api',
      'WS_PATH=/ws',
    ]) {
      expect(envExample).toContain(value);
    }
    expect(viteConfig).toContain("endpointPath(env.API_PATH, '/api', 'API_PATH')");
    expect(viteConfig).toContain("endpointPath(env.WS_PATH, '/ws', 'WS_PATH')");
    expect(viteConfig).toContain('server: {');
    expect(viteConfig).toContain('preview: {');
    expect(viteConfig).toContain('[wsPath]: { target: apiTarget, changeOrigin: true, ws: true }');

    for (const url of [
      'http://127.0.0.1:5173',
      'http://127.0.0.1:4173',
      'http://127.0.0.1:3000/health',
      'http://127.0.0.1:3000/ready',
      'http://127.0.0.1:3000/api/...',
      'ws://127.0.0.1:3000/ws',
    ]) {
      expect(readme, `README documents ${url}`).toContain(url);
    }
    expect(readme).toContain('curl -i http://127.0.0.1:3000/health');
    expect(readme).toContain('curl -i http://127.0.0.1:3000/ready');
  });

  it('documents required troubleshooting cases and safe teardown semantics', async () => {
    const [readme, compose, packageJson] = await Promise.all([
      read('README.md'),
      read('docker-compose.yml'),
      read('package.json').then(JSON.parse) as Promise<{ scripts: Record<string, string> }>,
    ]);

    for (const heading of [
      'Startup fails immediately',
      'Environment validation fails',
      'PostgreSQL is unavailable',
      'Port 3000, 5173, or 4173 is occupied',
      'Migration fails or status is pending',
      'Tests try to touch development data',
      'Browser tests cannot launch',
      'Stale containers or unexpected database state',
    ]) {
      expect(readme).toContain(`### ${heading}`);
    }

    expect(readme).toContain('docker compose down');
    expect(readme).toContain('docker compose down -v');
    expect(readme).toContain('Non-destructive teardown');
    expect(readme).toContain('Destructive teardown');
    expect(readme).toContain('permanently deletes local database data');
    expect(readme.indexOf('docker compose down')).toBeLessThan(
      readme.indexOf('docker compose down -v'),
    );

    expect(compose).toContain('human-bingo-postgres-data:');
    expect(compose).toContain('name: human-bingo-postgres-data');
    expect(compose).toContain('postgres:16.6-alpine');
    expect(compose).toContain('healthcheck:');
    expect(packageJson.scripts).toHaveProperty('backup');
    expect(packageJson.scripts).toHaveProperty('backup:verify');
  });
});
