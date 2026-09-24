/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';

import {
  GameStatus,
  type GameId,
  type GameMutationResult,
  type MembershipDto,
  type OnboardParticipantResult,
  type ParticipantDto,
  type PlayerProfileDto,
  type StateVersion,
} from '@human-bingo/domain';
import type { MembershipRecord } from '@human-bingo/persistence';
import type { AuthorizationPrincipal } from './access/authorization.js';

import { HttpApi, type HttpApiDependencies } from './http.js';
import type { AuthenticatedSession, MembershipAccessResult } from './access/session-service.js';

const gameId = 'game-1' as GameId;
const membershipId = 'membership-1';
const participantId = 'participant-1';
const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const session: AuthenticatedSession = {
  record: {
    id: 'session-1' as never,
    sessionIdHash: new Uint8Array([1]),
    accountOrGuestIdentity: 'host-1',
    authorizationVersion: 1n,
    createdAt: fixedDate,
    rotatedAt: null,
    expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    revokedAt: null,
  },
  session: {
    id: 'session-1' as never,
    membershipId: membershipId as never,
    expiresAt: '2025-01-02T00:00:00.000Z' as never,
    authorizationVersion: 1,
  },
};

const membership: MembershipRecord = {
  id: membershipId as never,
  gameId,
  participantId: participantId as never,
  browserSessionId: 'session-1' as never,
  resumableCredentialHash: new Uint8Array([2]),
  createdAt: fixedDate,
  lastSeenAt: fixedDate,
};

const createApi = (
  overrides: Partial<HttpApiDependencies> = {},
): {
  readonly api: HttpApi;
  readonly calls: {
    readonly configuration: Array<Record<string, unknown>>;
    readonly verification: Array<Record<string, unknown>>;
  };
} => {
  const calls = {
    configuration: [] as Array<Record<string, unknown>>,
    verification: [] as Array<Record<string, unknown>>,
  };
  const principal: AuthorizationPrincipal = {
    accountOrGuestIdentity: 'host-1',
    membershipId: membershipId as never,
    participantId: participantId as never,
    authorizationVersion: 1n,
  };
  const defaultDependencies: HttpApiDependencies = {
    sessions: {
      authenticateSession: async (credential: string) => {
        if (credential !== 'session-secret') throw new Error('bad session');
        return session;
      },
      validateCsrfToken: async (_credential: string, token: string) => {
        if (token !== 'csrf-ok') throw new Error('bad csrf');
      },
      sessionCookieHeader: (cookie: { readonly name: string; readonly value: string }) =>
        `${cookie.name}=${cookie.value}`,
    } as never,
    authorization: {
      hostSetup: {
        authorize: async () => ({ gameId, principal, role: 'host' as const }),
      },
      memberSnapshot: {
        authorize: async () => ({
          gameId,
          principal,
          participantId: participantId as never,
          membership,
        }),
      },
      leaderboard: {
        authorize: async () => ({
          gameId,
          principal,
          participantId: participantId as never,
          membership,
        }),
      },
      resumableAccess: {
        authorize: async () => ({
          gameId,
          principal,
          participantId: participantId as never,
          membership,
        }),
      },
      webSocketSubscription: {
        authorize: async () => ({
          gameId,
          principal,
          participantId: participantId as never,
          membership,
        }),
      },
    },
    gameConfiguration: {
      createGame: async () => ({
        game: {
          id: gameId,
          name: 'Game',
          status: GameStatus.Draft,
          distinctTaskCount: 0,
          taskBagLocked: false,
          stateVersion: 0 as StateVersion,
          createdAt: fixedDate.toISOString() as never,
          updatedAt: fixedDate.toISOString() as never,
        },
      }),
      execute: async (command: Record<string, unknown>) => {
        calls.configuration.push(command);
        return {
          game: {
            id: gameId,
            name: 'Renamed',
            status: GameStatus.Draft,
            distinctTaskCount: 0,
            taskBagLocked: false,
            stateVersion: 1 as StateVersion,
            createdAt: fixedDate.toISOString() as never,
            updatedAt: fixedDate.toISOString() as never,
          },
          tasks: [],
          stateVersion: 1 as StateVersion,
        } satisfies GameMutationResult;
      },
      read: async () => ({
        game: {
          id: gameId,
          name: 'Renamed',
          status: GameStatus.Draft,
          distinctTaskCount: 0,
          taskBagLocked: false,
          stateVersion: 1 as StateVersion,
          createdAt: fixedDate.toISOString() as never,
          updatedAt: fixedDate.toISOString() as never,
        },
        tasks: [] as never,
      }),
    } as never,
    invitations: {
      create: async () => ({ invitation: {} as never }),
      resolve: async () => ({
        preview: {
          gameId,
          gameName: 'Game',
          gameStatus: GameStatus.InvitationAvailable,
          invitationStatus: 'available',
          joinCode: 'ABC123',
        } as never,
      }),
    },
    onboarding: {
      onboard: async () => ({ onboarding: {} as never, access: {} as MembershipAccessResult }),
    },
    snapshots: {
      read: async () => ({ snapshot: {} as never }),
    },
    hostOverview: {
      read: async () => ({
        gameId: gameId as never,
        participants: [],
        leaderboards: {} as never,
        stateVersion: 0 as never,
      }),
    },
    verification: {
      request: async (command: Record<string, unknown>) => {
        calls.verification.push(command);
        return {} as never;
      },
      respond: async () => ({}) as never,
      listNotifications: async () => ({ notifications: [], pendingCount: 0 }),
    } as never,
    push: {
      register: async () => ({ subscriptionId: 'subscription-1' as never }),
    },
    principalForSession: async () => principal,
  };
  return { api: new HttpApi({ ...defaultDependencies, ...overrides }), calls };
};

const request = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request =>
  new Request(`https://app.example${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const cookieHeaders = { cookie: '__Host-hb_session=session-secret', 'x-csrf-token': 'csrf-ok' };

describe('documented HTTP API', () => {
  it('resolves public invitation representations without authenticating or mutating membership', async () => {
    const { api } = createApi();
    const response = await api.handle(
      request('GET', '/api/invitations/ABC123', undefined, { 'x-correlation-id': 'corr-public' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toBe('corr-public');
    expect(await json(response)).toMatchObject({
      preview: { gameId, joinCode: 'ABC123' },
      correlationId: 'corr-public',
    });
  });

  it('derives the invitation canonical link from the request origin', async () => {
    const options: Array<{ readonly canonicalBaseUrl?: string } | undefined> = [];
    const { api } = createApi({
      invitations: {
        create: async (
          _command: unknown,
          createOptions: { readonly canonicalBaseUrl?: string } | undefined,
        ) => {
          options.push(createOptions);
          return { invitation: {} as never };
        },
        resolve: async () => ({
          preview: {
            gameId,
            gameName: 'Game',
            gameStatus: GameStatus.InvitationAvailable,
            invitationStatus: 'available',
            joinCode: 'ABC123',
          } as never,
        }),
      },
    });
    const response = await api.handle(
      request(
        'POST',
        `/api/games/${gameId}/invitation`,
        undefined,
        { ...cookieHeaders, "idempotency-key": "invite-1", origin: "http://localhost:5173" },
      ),
    );
    expect(response.status).toBe(200);
    expect(options[0]).toEqual({ canonicalBaseUrl: 'http://localhost:5173' });
  });

  it('falls back to the configured public app origin for the invitation link', async () => {
    const options: Array<{ readonly canonicalBaseUrl?: string } | undefined> = [];
    const { api } = createApi({
      publicAppOrigin: 'https://play.example',
      invitations: {
        create: async (
          _command: unknown,
          createOptions: { readonly canonicalBaseUrl?: string } | undefined,
        ) => {
          options.push(createOptions);
          return { invitation: {} as never };
        },
        resolve: async () => ({
          preview: {
            gameId,
            gameName: 'Game',
            gameStatus: GameStatus.InvitationAvailable,
            invitationStatus: 'available',
            joinCode: 'ABC123',
          } as never,
        }),
      },
    });
    const response = await api.handle(
      request(
        'POST',
        `/api/games/${gameId}/invitation`,
        undefined,
        { ...cookieHeaders, 'idempotency-key': 'invite-1' },
      ),
    );
    expect(response.status).toBe(200);
    expect(options[0]).toEqual({ canonicalBaseUrl: 'https://play.example' });
  });

  it('omits the canonical base URL when no origin is available', async () => {
    const options: Array<{ readonly canonicalBaseUrl?: string } | undefined> = [];
    const { api } = createApi({
      invitations: {
        create: async (
          _command: unknown,
          createOptions: { readonly canonicalBaseUrl?: string } | undefined,
        ) => {
          options.push(createOptions);
          return { invitation: {} as never };
        },
        resolve: async () => ({
          preview: {
            gameId,
            gameName: 'Game',
            gameStatus: GameStatus.InvitationAvailable,
            invitationStatus: 'available',
            joinCode: 'ABC123',
          } as never,
        }),
      },
    });
    const response = await api.handle(
      request(
        'POST',
        `/api/games/${gameId}/invitation`,
        undefined,
        { ...cookieHeaders, 'idempotency-key': 'invite-1' },
      ),
    );
    expect(response.status).toBe(200);
    expect(options[0]).toEqual({});
  });

  it('rejects cookie-authenticated mutations without CSRF before calling application services', async () => {
    const { api, calls } = createApi();
    const response = await api.handle(
      request(
        'PATCH',
        `/api/games/${gameId}`,
        {
          action: 'rename',
          name: 'Unsafe',
          knownStateVersion: 0,
          idempotencyKey: 'rename-1',
        },
        { cookie: cookieHeaders.cookie },
      ),
    );
    expect(response.status).toBe(403);
    expect((await json(response)).error).toMatchObject({ code: 'FORBIDDEN' });
    expect(calls.configuration).toHaveLength(0);
  });

  it('requires a known state version and idempotency key, then forwards a typed host command', async () => {
    const { api, calls } = createApi();
    const missingVersion = await api.handle(
      request(
        'PATCH',
        `/api/games/${gameId}`,
        {
          action: 'rename',
          name: 'Renamed',
          idempotencyKey: 'rename-1',
        },
        cookieHeaders,
      ),
    );
    expect(missingVersion.status).toBe(422);

    const response = await api.handle(
      request(
        'PATCH',
        `/api/games/${gameId}`,
        {
          action: 'rename',
          name: 'Renamed',
          knownStateVersion: 0,
        },
        { ...cookieHeaders, 'idempotency-key': 'rename-1', 'x-correlation-id': 'corr-command' },
      ),
    );
    expect(response.status).toBe(200);
    expect(calls.configuration[0]).toMatchObject({
      gameId,
      name: 'Renamed',
      knownStateVersion: 0,
      idempotencyKey: 'rename-1',
    });
    expect((await json(response)).correlationId).toBe('corr-command');
  });

  it('loads the host setup state through the authorized host route', async () => {
    const { api } = createApi();
    const response = await api.handle(
      request('GET', `/api/games/${gameId}/host`, undefined, cookieHeaders),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.game).toMatchObject({ id: gameId, name: 'Renamed' });
    expect(body.overview).toMatchObject({ gameId });
  });

  it('rejects host setup loads without a host session', async () => {
    const { api } = createApi();
    const response = await api.handle(request('GET', `/api/games/${gameId}/host`));
    expect(response.status).toBe(401);
  });

  it('loads the compact host overview through its authorized route', async () => {
    const { api } = createApi();
    const response = await api.handle(
      request('GET', `/api/games/${gameId}/host-overview`, undefined, cookieHeaders),
    );
    expect(response.status).toBe(200);
    expect((await json(response)).overview).toMatchObject({ gameId });
  });

  it('authorizes snapshots and verification commands with the session-bound participant', async () => {
    const { api, calls } = createApi();
    const snapshot = await api.handle(
      request('GET', `/api/games/${gameId}/snapshot?since_version=4`, undefined, cookieHeaders),
    );
    expect(snapshot.status).toBe(200);

    const verification = await api.handle(
      request(
        'POST',
        `/api/games/${gameId}/verification-requests`,
        {
          gridId: 'grid-1',
          squareIndex: 7,
          identifiedPlayerCode: 'PLAYER2',
          knownStateVersion: 4,
        },
        { ...cookieHeaders, 'idempotency-key': 'verify-1' },
      ),
    );
    expect(verification.status).toBe(201);
    expect(calls.verification[0]).toMatchObject({
      gameId,
      gridId: 'grid-1',
      squareIndex: 7,
      identifiedPlayerCode: 'PLAYER2',
    });
  });

  it('sets membership cookies on onboarding but never serializes raw credentials in the JSON DTO', async () => {
    const access = {
      sessionCookie: { name: 'session', value: 'raw-session' },
      csrfCookie: { name: 'csrf', value: 'raw-csrf' },
      resumableCookie: { name: 'resume', value: 'raw-resume' },
    } as never;
    const onboarding: OnboardParticipantResult = {
      onboarding: {
        game: { id: gameId } as never,
        membership: {} as MembershipDto,
        participant: {} as ParticipantDto,
        profile: {} as PlayerProfileDto,
        grid: {} as never,
        resumed: false,
        stateVersion: 1 as StateVersion,
      },
    };
    const { api } = createApi({ onboarding: { onboard: async () => ({ ...onboarding, access }) } });
    const response = await api.handle(
      request('POST', `/api/games/${gameId}/onboarding`, {
        joinCode: 'ABC123',
        displayName: 'Player',
        idempotencyKey: 'onboard-1',
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('raw-session');
    const payload = JSON.stringify(await json(response));
    expect(payload).toContain('onboarding');
    expect(payload).not.toContain('raw-session');
    expect(payload).not.toContain('raw-resume');
  });

  it('serves member notifications and the documented root push-subscription route', async () => {
    const { api } = createApi();
    const notifications = await api.handle(
      request(
        'GET',
        `/api/games/${gameId}/notifications?include_resolved=true`,
        undefined,
        cookieHeaders,
      ),
    );
    expect(notifications.status).toBe(200);
    expect(await json(notifications)).toMatchObject({ notifications: [], pendingCount: 0 });

    const push = await api.handle(
      request(
        'POST',
        '/api/push-subscriptions',
        {
          gameId,
          idempotencyKey: 'push-1',
          subscription: {
            endpoint: 'https://push.example/subscription',
            p256dh: 'public-key',
            auth: 'auth-secret',
          },
        },
        cookieHeaders,
      ),
    );
    expect(push.status).toBe(201);
    expect(await json(push)).toMatchObject({ subscriptionId: 'subscription-1' });
  });
});
