import { createConnection } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createApiRuntime } from './runtime.js';

const config = (port = 31339) => ({ host: '127.0.0.1', port });
const waitForClose = (socket: ReturnType<typeof createConnection>): Promise<void> =>
  new Promise((resolve) => socket.once('close', () => resolve()));

describe('Api_Runtime integration and lifecycle smoke tests', () => {
  it('routes HTTP requests and WebSocket upgrades through the composed handlers', async () => {
    const handle = vi.fn(() => Promise.resolve(new Response('routed', { status: 201 })));
    const upgrade = vi.fn((_request, socket: NodeJS.ReadWriteStream): void => {
      socket.end();
    });
    const runtime = createApiRuntime(config(), {
      httpApi: { handle } as never,
      websocket: { handleUpgrade: upgrade },
    });
    await runtime.start();
    const port = runtime.address()!.port;
    const response = await fetch(`http://127.0.0.1:${port}/api/route`);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('routed');
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    await waitForClose(socket);
    expect(upgrade).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it('keeps health live while reporting dependency readiness failure', async () => {
    const runtime = createApiRuntime(config(31342), {
      httpApi: { handle: vi.fn() } as never,
      readiness: () => false,
    });
    await runtime.start();
    const port = runtime.address()!.port;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'not_ready' });
    await runtime.stop();
  });

  it('rejects a bind failure and does not report readiness', async () => {
    const first = createApiRuntime(config(31340), { httpApi: { handle: vi.fn() } as never });
    await first.start();
    const occupied = first.address()!.port;
    const second = createApiRuntime(
      { host: '127.0.0.1', port: occupied },
      { httpApi: { handle: vi.fn() } as never },
    );
    await expect(second.start()).rejects.toThrow();
    expect(second.isReady()).toBe(false);
    await first.stop();
  });

  it('preserves every set-cookie header when writing the response to the wire', async () => {
    const httpApi = {
      handle: vi.fn(() =>
        Promise.resolve(
          new Response('ok', {
            status: 201,
            headers: [
              ['set-cookie', 'session=value-1; Path=/; HttpOnly'],
              ['set-cookie', 'csrf=value-2; Path=/'],
            ],
          }),
        ),
      ),
    };
    const runtime = createApiRuntime(config(31345), { httpApi: httpApi as never });
    await runtime.start();
    const port = runtime.address()!.port;
    const response = await fetch(`http://127.0.0.1:${port}/api/session`, { method: 'POST' });
    expect(response.status).toBe(201);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('session=value-1');
    expect(cookies[1]).toContain('csrf=value-2');
    await runtime.stop();
  });

  it('drains, rejects new traffic, and makes repeated stop calls idempotent', async () => {
    const close = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
    const runtime = createApiRuntime(config(31343), {
      httpApi: { handle: vi.fn(() => Promise.resolve(new Response('ok'))) } as never,
      websocket: { handleUpgrade: vi.fn(), close },
      shutdownTimeoutMs: 100,
    });
    await runtime.start();
    const port = runtime.address()!.port;
    const stopping = runtime.stop('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect((await fetch(`http://127.0.0.1:${port}/api/new`)).status).toBe(503);
    await Promise.all([stopping, runtime.stop('SIGINT')]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.isReady()).toBe(false);
  });

  it('bounds forced cleanup when a gateway never closes', async () => {
    const runtime = createApiRuntime(config(31344), {
      httpApi: { handle: vi.fn() } as never,
      websocket: { handleUpgrade: vi.fn(), close: () => new Promise<void>(() => {}) },
      shutdownTimeoutMs: 20,
    });
    await runtime.start();
    const started = Date.now();
    await runtime.stop('timeout');
    expect(Date.now() - started).toBeLessThan(250);
    expect(runtime.isReady()).toBe(false);
  });
});
