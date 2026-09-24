import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const root = process.cwd();
const viteBin = join(root, 'node_modules/vite/bin/vite.js');
const dist = join(root, 'packages/browser-client/dist-web');
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const waitForHttp = async (url: string, child: ChildProcess): Promise<Response> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      if (child.exitCode !== null) throw new Error(`process exited with ${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const startVite = (args: string[], env: NodeJS.ProcessEnv): ChildProcess => {
  const child = spawn(process.execPath, [viteBin, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', () => undefined);
  return child;
};

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
};

let api: Server;
let apiPort: number;
let dev: ChildProcess;
let preview: ChildProcess;
let httpProxySeen = false;
let websocketProxySeen = false;

beforeAll(async () => {
  api = createServer((request, response) => {
    if (request.url === '/api/smoke') {
      httpProxySeen = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ proxied: true }));
      return;
    }
    response.writeHead(404).end();
  });
  api.on('upgrade', (request, socket) => {
    if (request.url === '/ws/smoke') {
      websocketProxySeen = true;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.end();
    } else socket.destroy();
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiPort = (api.address() as { port: number }).port;
});

afterAll(async () => {
  await stop(dev);
  await stop(preview);
  await new Promise<void>((resolve) => api.close(() => resolve()));
  rmSync(dist, { recursive: true, force: true });
});

describe('Vite/build/preview single-run smoke coverage', () => {
  test('proxies HTTP and WebSocket paths through one development server', async () => {
    const devPort = await freePort();
    dev = startVite(['--config', 'vite.config.ts'], {
      BROWSER_DEV_PORT: String(devPort),
      API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      API_PATH: '/api',
      WS_PATH: '/ws',
    });
    const response = await waitForHttp(`http://127.0.0.1:${devPort}/api/smoke`, dev);
    expect(await response.json()).toEqual({ proxied: true });
    expect(httpProxySeen).toBe(true);

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: devPort }, () => {
        socket.write(
          'GET /ws/smoke HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c21vZQ==\r\n\r\n',
        );
      });
      socket.once('data', (data) => {
        expect(data.toString()).toContain('101 Switching Protocols');
        resolve();
        socket.destroy();
      });
      socket.once('error', reject);
    });
    expect(websocketProxySeen).toBe(true);
  }, 20_000);

  test('builds deterministic production output and preview serves it without DB mutation', async () => {
    const marker = join(root, 'test-results/vite-preview-db-marker.sqlite');
    rmSync(marker, { force: true });
    const build = spawn(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts'], {
      cwd: root,
      env: { ...process.env, BUILD_ID: 'smoke-test', DATABASE_URL: 'postgres://unused' },
      stdio: 'pipe',
    });
    const exitCode = await new Promise<number>((resolve) =>
      build.once('exit', (code) => resolve(code ?? 1)),
    );
    expect(exitCode).toBe(0);
    expect(existsSync(join(dist, 'index.html'))).toBe(true);
    expect(existsSync(join(dist, '.vite/manifest.json'))).toBe(true);
    const firstManifest = readFileSync(join(dist, '.vite/manifest.json'), 'utf8');

    rmSync(dist, { recursive: true, force: true });
    const secondBuild = spawn(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts'], {
      cwd: root,
      env: { ...process.env, BUILD_ID: 'smoke-test', DATABASE_URL: 'postgres://unused' },
      stdio: 'ignore',
    });
    expect(
      await new Promise<number>((resolve) =>
        secondBuild.once('exit', (code) => resolve(code ?? 1)),
      ),
    ).toBe(0);
    expect(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')).toBe(firstManifest);

    const previewPort = await freePort();
    preview = startVite(['preview', '--config', 'vite.config.ts'], {
      PREVIEW_PORT: String(previewPort),
      DATABASE_URL: `file://${marker}`,
    });
    const response = await waitForHttp(`http://127.0.0.1:${previewPort}/`, preview);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Human Bingo');
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  }, 40_000);
});
