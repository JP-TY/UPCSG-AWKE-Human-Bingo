import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Environment } from './config/environment.js';
import type { HttpApi } from './http.js';

export interface WebSocketUpgradeHandler {
  readonly handleUpgrade: (
    request: IncomingMessage,
    socket: NodeJS.ReadWriteStream,
    head: Buffer,
  ) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
}

export interface ApiRuntimeDependencies {
  readonly httpApi: Pick<HttpApi, 'handle'>;
  readonly websocket?: WebSocketUpgradeHandler;
  readonly readiness?: () => boolean | Promise<boolean>;
  readonly shutdownTimeoutMs?: number;
  readonly serverFactory?: (
    requestListener: (request: IncomingMessage, response: ServerResponse) => void,
  ) => Server;
}

export interface ApiRuntime {
  readonly start: () => Promise<void>;
  readonly stop: (reason?: string) => Promise<void>;
  readonly isReady: () => boolean;
  readonly address: () => AddressInfo | null;
}

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;

const assertConfiguration = (config: Pick<Environment, 'host' | 'port'>): void => {
  if (typeof config.host !== 'string' || config.host.trim() === '')
    throw new RangeError('HOST must be a non-empty host');
  if (!validPort(config.port)) throw new RangeError('PORT must be an integer between 1 and 65535');
};

const requestUrl = (request: IncomingMessage): string => {
  const host = request.headers.host ?? 'localhost';
  return new URL(request.url ?? '/', `http://${host}`).toString();
};

const toFetchRequest = async (request: IncomingMessage): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); // eslint-disable-line @typescript-eslint/no-unsafe-argument
  const method = request.method ?? 'GET';
  const body =
    chunks.length === 0 || method === 'GET' || method === 'HEAD'
      ? undefined
      : Buffer.concat(chunks);
  return new Request(requestUrl(request), {
    method,
    headers: request.headers as Record<string, string>,
    body: body as BodyInit | undefined,
    duplex: 'half',
  } as RequestInit);
};

const writeFetchResponse = async (response: Response, target: ServerResponse): Promise<void> => {
  target.statusCode = response.status;
  const cookies: string[] = [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') cookies.push(value);
    else target.setHeader(key, value);
  });
  if (cookies.length > 0) target.setHeader('set-cookie', cookies);
  target.end(new Uint8Array(await response.arrayBuffer()));
};

export const createApiRuntime = (
  config: Pick<Environment, 'host' | 'port'>,
  dependencies: ApiRuntimeDependencies,
): ApiRuntime => {
  assertConfiguration(config);
  let server: Server | undefined;
  let started = false;
  let stopping: Promise<void> | undefined;
  let ready = false;
  let draining = false;
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 10_000;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1)
    throw new RangeError('shutdownTimeoutMs must be a positive integer');
  const factory = dependencies.serverFactory ?? ((listener) => createServer(listener));
  const requestListener = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.url === '/health') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.url === '/ready') {
      const dependencyReady = dependencies.readiness ? await dependencies.readiness() : true;
      response.statusCode = ready && dependencyReady ? 200 : 503;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: ready && dependencyReady ? 'ready' : 'not_ready' }));
      return;
    }
    if (!ready || draining) {
      response.statusCode = 503;
      response.end('Service unavailable');
      return;
    }
    try {
      await writeFetchResponse(
        await dependencies.httpApi.handle(await toFetchRequest(request)),
        response,
      );
    } catch {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    }
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      if (stopping) await stopping;
      server = factory(requestListener); // eslint-disable-line @typescript-eslint/no-misused-promises
      if (dependencies.websocket) {
        server.on('upgrade', (request, socket, head) => {
          if (draining || !ready) {
            socket.destroy();
            return;
          }
          const upgrade = dependencies.websocket!.handleUpgrade(request, socket, head);
          if (upgrade instanceof Promise) void upgrade.catch(() => socket.destroy());
        });
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server?.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server?.off('error', onError);
          started = true;
          ready = true;
          resolve();
        };
        server!.once('error', onError);
        server!.once('listening', onListening);
        server!.listen(config.port, config.host);
      });
    },
    async stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        ready = false;
        draining = true;
        if (dependencies.websocket?.close)
          await Promise.race([
            dependencies.websocket.close(),
            new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
          ]);
        if (server && started)
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
              if (!settled) {
                settled = true;
                resolve();
              }
            };
            server!.close(finish);
            setTimeout(finish, shutdownTimeoutMs);
          });
        server = undefined;
        started = false;
        draining = false;
      })();
      await stopping;
    },
    isReady: () => ready,
    address: () => {
      const address = server?.address();
      return address && typeof address !== 'string' ? address : null;
    },
  };
};
