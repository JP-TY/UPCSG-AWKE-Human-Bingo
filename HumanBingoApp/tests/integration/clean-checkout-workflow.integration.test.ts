import { createConnection } from 'node:net';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiRuntime } from '@human-bingo/api';

const root = resolve(import.meta.dirname, '../..');
const viteBin = join(root, 'node_modules/vite/bin/vite.js');

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
};

const waitForHttp = async (url: string, child: ChildProcess): Promise<Response> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      if (child.exitCode !== null) throw new Error(`Vite exited with ${child.exitCode}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
};

describe('clean-checkout local workflow', () => {
  let api: ReturnType<typeof createApiRuntime>;
  let apiPort: number;
  let vite: ChildProcess;
  let browserPort: number;

  beforeAll(async () => {
    api = createApiRuntime(
      { host: '127.0.0.1', port: await freePort() },
      {
        httpApi: {
          handle: (request) =>
            Promise.resolve(
              request.url.endsWith('/api/smoke')
                ? new Response(JSON.stringify({ route: 'api' }), {
                    headers: { 'content-type': 'application/json' },
                  })
                : new Response('not found', { status: 404 }),
            ),
        },
        websocket: {
          handleUpgrade: (_request, socket) => {
            socket.write(
              'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
            );
            socket.end();
          },
        },
        readiness: () => true,
      },
    );
    await api.start();
    apiPort = api.address()?.port ?? 0;

    browserPort = await freePort();
    vite = spawn(process.execPath, [viteBin, '--config', 'vite.config.ts'], {
      cwd: root,
      env: {
        ...process.env,
        BROWSER_DEV_PORT: String(browserPort),
        API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
        API_PATH: '/api',
        WS_PATH: '/ws',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stderr?.on('data', () => undefined);
    const response = await waitForHttp(`http://127.0.0.1:${browserPort}/`, vite);
    expect(response.status).toBe(200);
  });

  afterAll(async () => {
    await stop(vite);
    await api.stop('test complete');
  });

  it('follows the documented clean-checkout ordering and exposes actionable runtime diagnostics', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const order = [
      'npm install',
      'cp .env.example .env',
      'npm run validate:environment',
      'docker compose up -d postgres',
      'npm run db:wait',
      'npm run db:create',
      'npm run db:migrate',
      'npm run db:status',
      'npm run build',
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(readme.indexOf(order[index - 1])).toBeLessThan(readme.indexOf(order[index]));
    }
    expect(readme).toMatch(/`?server\.js`? is missing/);
    expect(readme).toContain('API_RUNTIME_COMMAND');
    expect(readme).toContain('npm run db:wait');
  });

  it('verifies Compose health configuration when Docker Compose is available', () => {
    const available =
      spawnSync('docker', ['compose', 'version'], { cwd: root, stdio: 'ignore' }).status === 0;
    if (!available) return;
    const model = JSON.parse(
      execFileSync('docker', ['compose', 'config', '--format', 'json'], {
        cwd: root,
        encoding: 'utf8',
      }),
    ) as {
      services: { postgres: { image: string; healthcheck?: { test: string[] } } };
    };
    expect(model.services.postgres.image).toBe('postgres:16.6-alpine');
    expect(model.services.postgres.healthcheck?.test.join(' ')).toContain('pg_isready');
  });

  it('serves health/readiness and proxies the API and WebSocket paths through the browser URL', async () => {
    const health = await fetch(`http://127.0.0.1:${apiPort}/health`);
    const readiness = await fetch(`http://127.0.0.1:${apiPort}/ready`);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });
    await expect(readiness.json()).resolves.toEqual({ status: 'ready' });

    const apiResponse = await fetch(`http://127.0.0.1:${browserPort}/api/smoke`);
    expect(apiResponse.status).toBe(200);
    await expect(apiResponse.json()).resolves.toEqual({ route: 'api' });

    await new Promise<void>((resolvePromise, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: browserPort }, () => {
        socket.write(
          'GET /ws/smoke HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c21vZQ==\r\n\r\n',
        );
      });
      socket.once('data', (data) => {
        expect(data.toString()).toContain('101 Switching Protocols');
        socket.destroy();
        resolvePromise();
      });
      socket.once('error', reject);
    });
  }, 20_000);
});
