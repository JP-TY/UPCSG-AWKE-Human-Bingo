import { describe, expect, it, vi } from 'vitest';
import { createApiRuntime } from './runtime.js';

const config = (port: number) => ({ host: '127.0.0.1', port }) as const;

describe('Api_Runtime', () => {
  it('rejects invalid host and port before constructing a server', () => {
    const httpApi = { handle: vi.fn() } as never;
    expect(() => createApiRuntime({ host: '', port: 3000 }, { httpApi })).toThrow(/HOST/);
    expect(() => createApiRuntime({ host: '127.0.0.1', port: 70000 }, { httpApi })).toThrow(/PORT/);
  });

  it('starts once, serves health/readiness, and stops idempotently', async () => {
    const httpApi = { handle: vi.fn(() => Promise.resolve(new Response('api'))) } as never;
    const closeGateway = vi.fn();
    const runtime = createApiRuntime(config(31337), {
      httpApi,
      websocket: { handleUpgrade: vi.fn(), close: closeGateway },
    });
    await runtime.start();
    const address = runtime.address();
    expect(address?.port).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${address!.port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${address!.port}/ready`)).status).toBe(200);
    await runtime.start();
    await Promise.all([runtime.stop('test'), runtime.stop('duplicate')]);
    expect(closeGateway).toHaveBeenCalledTimes(1);
    expect(runtime.isReady()).toBe(false);
  });

  it('delegates non-health HTTP requests to the existing HttpApi', async () => {
    const handle = vi.fn(() => Promise.resolve(new Response('delegated', { status: 201 })));
    const runtime = createApiRuntime(config(31338), { httpApi: { handle } });
    await runtime.start();
    const port = runtime.address()!.port;
    const response = await fetch(`http://127.0.0.1:${port}/api/games`);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('delegated');
    expect(handle).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });
});
