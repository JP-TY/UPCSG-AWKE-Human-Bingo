import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';
import { OutboxPublisher } from '@human-bingo/worker';
import type { GameId, StateVersion } from '@human-bingo/domain';
import {
  SqlGameConfigurationRepository,
  SqlGridRepository,
  SqlInvitationRepository,
  SqlMembershipRepository,
  SqlOutboxRepository,
  SqlPushSubscriptionRepository,
  SqlVerificationRepository,
} from '@human-bingo/persistence';

import { AuthorizationMiddleware, ScopedQueryPolicies } from './access/authorization.js';
import type { AuthorizationPrincipal } from './access/authorization.js';
import { SessionService, parseCookieHeader } from './access/session-service.js';
import type { AuthenticatedSession } from './access/session-service.js';
import { SqlAccessRepository } from './access/sql-access-repository.js';
import { SqlAuthorizationRepository } from './access/sql-authorization-repository.js';
import { readEnvironment } from './config/environment.js';
import type { Environment } from './config/environment.js';
import { GameConfigurationService } from './game-configuration.js';
import { GridService } from './grid.js';
import { HttpApi } from './http.js';
import type { HttpApiOptions } from './http.js';
import { InvitationService } from './invitation.js';
import { MembershipService } from './membership.js';
import { PushNotificationService } from './push.js';
import type { PushProvider } from './push.js';
import { RealtimeGateway } from './realtime.js';
import { createApiRuntime } from './runtime.js';
import type { ApiRuntime } from './runtime.js';
import { SqlSnapshotReader } from './snapshot-service.js';
import { SqlHostOverviewReader } from './host-overview.js';
import { VerificationCompletionService } from './verification.js';
import { createWebSocketUpgradeHandler } from './websocket-upgrade.js';

const SESSION_COOKIE_NAME = '__Host-hb_session';
const CSRF_COOKIE_NAME = '__Host-hb_csrf';
const RESUMABLE_COOKIE_NAME = '__Host-hb_resume';
const DEV_SESSION_COOKIE_NAME = 'hb_session';
const DEV_CSRF_COOKIE_NAME = 'hb_csrf';
const DEV_RESUMABLE_COOKIE_NAME = 'hb_resume';
const WS_GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fallback origin used for invitation links when no per-request origin is
 * available. Production deployments should set INVITATION_CANONICAL_BASE_URL
 * to the publicly reachable app origin; the HTTP layer normally derives the
 * link origin from each request instead.
 */
const invitationCanonicalBaseUrl = (
  process.env.INVITATION_CANONICAL_BASE_URL?.trim() || undefined
) ?? 'https://app.example';

const devPushProvider: PushProvider = {
  send: (subscription, payload) => {
    console.log('[push:dev] delivery would send', {
      endpointHash: Buffer.from(subscription.endpointHash).toString('hex'),
      payload,
    });
    return Promise.resolve();
  },
};

export interface ApiServerOptions {
  readonly outboxPollIntervalMs?: number;
  readonly pushProvider?: PushProvider;
}

export interface ApiServerHandle {
  readonly runtime: ApiRuntime;
  readonly stop: (reason?: string) => Promise<void>;
}

// Load the repository `.env` (without overriding real environment variables)
// when running directly instead of through the lifecycle supervisor.
try {
  process.loadEnvFile?.('.env');
} catch {
  // `.env` is optional; the supervisor passes a fully populated environment.
}

/**
 * Composition root for the API runtime. Constructs the PostgreSQL-backed
 * repositories and services, the realtime gateway, and the outbox pump that
 * publishes `game.patch` rows to connected browsers.
 */
export const startApiServer = async (
  config: Environment = readEnvironment(),
  options: ApiServerOptions = {},
): Promise<ApiServerHandle> => {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    ssl:
      config.databaseSslMode === 'disable'
        ? false
        : {
            rejectUnauthorized: config.databaseSslMode === 'verify-full',
            // RDS presents a chain rooted at an AWS CA that minimal images
            // (e.g. node:alpine) do not trust by default. When
            // DATABASE_SSL_CA_PATH points at a PEM bundle, verify against it
            // instead of the system store.
            ...(config.databaseSslCaPath
              ? { ca: readFileSync(config.databaseSslCaPath, 'utf8') }
              : {}),
          },
  });
  const outboxPollIntervalMs = options.outboxPollIntervalMs ?? 500;
  try {
    const access = new SqlAccessRepository(pool);
    const authorization = new SqlAuthorizationRepository(pool);

    const secureCookies = config.publicAppOrigin.startsWith('https://');
    const sessionCookieName = secureCookies ? SESSION_COOKIE_NAME : DEV_SESSION_COOKIE_NAME;
    const sessions = new SessionService(access, {
      secret: config.sessionSecret,
      sessionCookieName,
      csrfCookieName: secureCookies ? CSRF_COOKIE_NAME : DEV_CSRF_COOKIE_NAME,
      resumableCookieName: secureCookies ? RESUMABLE_COOKIE_NAME : DEV_RESUMABLE_COOKIE_NAME,
      secureCookies,
    });

    const principalForSession = async (
      authenticated: AuthenticatedSession,
    ): Promise<AuthorizationPrincipal> => {
      const record = authenticated.record;
      const membership = await access.findMembershipByBrowserSessionId(record.id);
      return {
        accountOrGuestIdentity: record.accountOrGuestIdentity,
        authorizationVersion: record.authorizationVersion,
        ...(membership === null
          ? {}
          : {
              membershipId: membership.id,
              participantId: membership.participantId,
            }),
      };
    };

    const middleware = new AuthorizationMiddleware(authorization);
    const authorizationPolicies = new ScopedQueryPolicies(middleware);

    const gameConfiguration = new GameConfigurationService(
      new SqlGameConfigurationRepository(pool),
    );
    const invitations = new InvitationService(new SqlInvitationRepository(pool), {
      canonicalBaseUrl: invitationCanonicalBaseUrl,
    });
    const gridService = new GridService(new SqlGridRepository(pool));
    const membership = new MembershipService(new SqlMembershipRepository(pool), gridService, {
      sessionIssuer: {
        createResumableCredential: () => sessions.createResumableCredential(),
        createMembershipSession: (membershipRecord, resumableCredential) =>
          sessions.createMembershipSession(membershipRecord, resumableCredential),
        bindMembershipSession: (membershipRecord, resumableCredential, transaction) =>
          sessions.bindMembershipSession(membershipRecord, resumableCredential, transaction),
      },
    });

    const pushSubscriptions = new SqlPushSubscriptionRepository();
    const push = new PushNotificationService(
      {
        register: (input) => pushSubscriptions.register(pool, input),
        listActive: (gameId, participantId) =>
          pushSubscriptions.listActive(pool, gameId, participantId),
        markSuccess: (id, deliveredAt) => pushSubscriptions.markSuccess(pool, id, deliveredAt),
        markFailure: (id, failedAt, stale) =>
          pushSubscriptions.markFailure(pool, id, failedAt, stale),
      },
      {
        isGameMember: async (gameId, participantId) =>
          (await authorization.findMembership(gameId, participantId)) !== null,
      },
      options.pushProvider ?? devPushProvider,
      { appOrigin: config.publicAppOrigin },
    );

    const verification = new VerificationCompletionService(new SqlVerificationRepository(pool), {
      pushNotifier: push,
    });

    const httpOptions: HttpApiOptions = {
      sessionCookieName: secureCookies ? SESSION_COOKIE_NAME : DEV_SESSION_COOKIE_NAME,
    };
    const httpApi = new HttpApi(
      {
        sessions,
        authorization: authorizationPolicies,
        gameConfiguration,
        invitations,
        onboarding: {
          onboard: async (command) => {
            const result = await membership.onboard(command);
            if (result.access === undefined) {
              throw new Error('Onboarding completed without a membership session');
            }
            return { ...result, access: result.access };
          },
        },
        snapshots: new SqlSnapshotReader(new SqlVerificationRepository(pool)),
        hostOverview: new SqlHostOverviewReader(new SqlVerificationRepository(pool)),
        verification,
        push,
        principalForSession,
        publicAppOrigin: config.publicAppOrigin,
      },
      httpOptions,
    );

    const outbox = new SqlOutboxRepository(pool);
    const realtime = new RealtimeGateway(
      authorizationPolicies.webSocketSubscription,
      {
        authenticate: async (sessionCredential) =>
          principalForSession(await sessions.authenticateSession(sessionCredential)),
      },
      {
        seedVersion: async (gameId) =>
          Number(await outbox.latestPublishedVersion(gameId)) as StateVersion,
      },
    );

    const websocket = createWebSocketUpgradeHandler((request, connection) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname !== config.wsPath) {
        connection.close(1008, 'Unknown websocket path');
        return;
      }
      const gameId = url.searchParams.get('gameId');
      if (gameId === null || !WS_GAME_ID_PATTERN.test(gameId)) {
        connection.close(1008, 'A valid gameId is required');
        return;
      }
      const lastKnownStateVersion = optionalVersion(url.searchParams.get('lastKnownStateVersion'));
      if (lastKnownStateVersion === undefined) {
        connection.close(1008, 'lastKnownStateVersion must be a non-negative integer');
        return;
      }
      const sessionCredential = parseCookieHeader(request.headers.cookie, sessionCookieName);
      if (sessionCredential === null) {
        connection.close(1008, 'Authentication is required');
        return;
      }
      void realtime
        .accept(connection, {
          gameId: gameId as GameId,
          sessionCredential,
          ...(lastKnownStateVersion === null ? {} : { lastKnownStateVersion }),
        })
        .catch(() => {
          connection.close(1008, 'Websocket connection failed');
        });
    });

    const publisher = new OutboxPublisher(outbox, {
      publish: async (event) => {
        if (event.eventType === 'game.patch') await realtime.publish(event);
      },
    });
    const outboxTimer = setInterval(() => {
      void publisher.publishPending().catch(() => {
        // The pool/outbox may be temporarily unreachable; the next poll retries.
      });
    }, outboxPollIntervalMs);

    const runtime = createApiRuntime(config, {
      httpApi,
      websocket,
      readiness: async () => {
        try {
          await pool.query('SELECT 1');
          return true;
        } catch {
          return false;
        }
      },
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    });
    await runtime.start();

    return {
      runtime,
      stop: async (reason?: string) => {
        clearInterval(outboxTimer);
        await runtime.stop(reason);
        await pool.end();
      },
    };
  } catch (error: unknown) {
    await pool.end();
    throw error;
  }
};

const optionalVersion = (raw: string | null): StateVersion | null | undefined => {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return undefined;
  return value as StateVersion;
};

export const main = async (): Promise<void> => {
  const config = readEnvironment();
  const handle = await startApiServer(config);
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal} received; shutting down`);
    void handle
      .stop(signal)
      .catch((error: unknown) => console.error('[server] shutdown failed', error))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  const address = handle.runtime.address();
  console.log(
    `[server] listening on http://${config.host}:${address?.port ?? config.port}`,
    `api=${config.apiPath}`,
    `ws=${config.wsPath}`,
    `db=${config.databaseUrl}`,
  );
};

const isMainModule = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
};

if (isMainModule()) {
  void main().catch((error: unknown) => {
    console.error('[server] failed to start', error);
    process.exitCode = 1;
  });
}
