/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  type GameId,
  type MembershipId,
  type ParticipantId,
  type StateVersion,
  type VerificationRequestId,
  VerificationRequestStatus,
} from '@human-bingo/domain';
import type { MembershipRecord } from '@human-bingo/persistence';
import {
  AuthorizationMiddleware,
  ScopedQueryPolicies,
  type AuthorizationRepository,
} from './access/authorization.js';
import type { AuthenticatedSession, SessionCookie } from './access/session-service.js';
import { HttpApi, type HttpApiDependencies } from './http.js';
import {
  createObservability,
  createStructuredLogger,
  type StructuredLogRecord,
} from './observability.js';
import { InMemoryRateLimiter, rateLimitedError } from './security.js';

const GAME_A = 'game-a' as GameId;
const GAME_B = 'game-b' as GameId;
const HOST_SESSION = 'host-session-secret';
const MEMBER_ONE_SESSION = 'member-one-session-secret';
const MEMBER_TWO_SESSION = 'member-two-session-secret';
const OUTSIDER_SESSION = 'outsider-session-secret';
const HOST_ACCOUNT = 'host-account';
const PARTICIPANT_ONE = 'participant-one' as ParticipantId;
const PARTICIPANT_TWO = 'participant-two' as ParticipantId;
const MEMBER_ONE = 'membership-one' as MembershipId;
const MEMBER_TWO = 'membership-two' as MembershipId;
const FIXED_DATE = new Date('2025-01-01T00:00:00.000Z');

const error = (
  code: DomainErrorCode,
  message: string,
  correlationId = 'integration-correlation',
  httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503 = 403,
  metadata?: Readonly<Record<string, string | number | boolean>>,
): HumanBingoError =>
  new HumanBingoError({
    code,
    message,
    correlationId: correlationId as never,
    retryable: code === DomainErrorCode.RateLimited,
    httpStatus,
    ...(metadata === undefined ? {} : { metadata }),
  });

const membership = (
  id: MembershipId,
  gameId: GameId,
  participantId: ParticipantId,
): MembershipRecord => ({
  id,
  gameId,
  participantId,
  browserSessionId: null,
  resumableCredentialHash: new Uint8Array([1, 2, 3]),
  createdAt: FIXED_DATE,
  lastSeenAt: FIXED_DATE,
});

const sessions: Record<string, AuthenticatedSession> = {
  [HOST_SESSION]: {
    record: {
      id: 'session-host' as never,
      sessionIdHash: new Uint8Array([1]),
      accountOrGuestIdentity: HOST_ACCOUNT,
      authorizationVersion: 1n,
      createdAt: FIXED_DATE,
      rotatedAt: null,
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      revokedAt: null,
    },
    session: {
      id: 'session-host' as never,
      expiresAt: '2025-01-02T00:00:00.000Z' as never,
      authorizationVersion: 1,
    },
  },
  [MEMBER_ONE_SESSION]: {
    record: {
      id: 'session-one' as never,
      sessionIdHash: new Uint8Array([2]),
      accountOrGuestIdentity: 'membership:membership-one',
      authorizationVersion: 1n,
      createdAt: FIXED_DATE,
      rotatedAt: null,
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      revokedAt: null,
    },
    session: {
      id: 'session-one' as never,
      membershipId: MEMBER_ONE,
      expiresAt: '2025-01-02T00:00:00.000Z' as never,
      authorizationVersion: 1,
    },
  },
  [MEMBER_TWO_SESSION]: {
    record: {
      id: 'session-two' as never,
      sessionIdHash: new Uint8Array([3]),
      accountOrGuestIdentity: 'membership:membership-two',
      authorizationVersion: 1n,
      createdAt: FIXED_DATE,
      rotatedAt: null,
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      revokedAt: null,
    },
    session: {
      id: 'session-two' as never,
      membershipId: MEMBER_TWO,
      expiresAt: '2025-01-02T00:00:00.000Z' as never,
      authorizationVersion: 1,
    },
  },
  [OUTSIDER_SESSION]: {
    record: {
      id: 'session-outsider' as never,
      sessionIdHash: new Uint8Array([4]),
      accountOrGuestIdentity: 'outsider-account',
      authorizationVersion: 1n,
      createdAt: FIXED_DATE,
      rotatedAt: null,
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      revokedAt: null,
    },
    session: {
      id: 'session-outsider' as never,
      expiresAt: '2025-01-02T00:00:00.000Z' as never,
      authorizationVersion: 1,
    },
  },
};

const games = new Map<
  GameId,
  { readonly id: GameId; readonly hostAccountId: string; readonly status: GameStatus }
>([
  [GAME_A, { id: GAME_A, hostAccountId: HOST_ACCOUNT, status: GameStatus.Active }],
  [GAME_B, { id: GAME_B, hostAccountId: 'other-host', status: GameStatus.Active }],
]);

const memberships = new Map<string, MembershipRecord>([
  [`${GAME_A}:${PARTICIPANT_ONE}`, membership(MEMBER_ONE, GAME_A, PARTICIPANT_ONE)],
  [`${GAME_A}:${PARTICIPANT_TWO}`, membership(MEMBER_TWO, GAME_A, PARTICIPANT_TWO)],
]);

const authorizationRepository: AuthorizationRepository = {
  findGame: async (gameId) => games.get(gameId) ?? null,
  findMembership: async (gameId, participantId) =>
    memberships.get(`${gameId}:${participantId}`) ?? null,
  findVerificationRequest: async (gameId, verificationRequestId) =>
    gameId === GAME_A && verificationRequestId === ('request-1' as VerificationRequestId)
      ? {
          gameId: GAME_A,
          identifiedParticipantId: PARTICIPANT_TWO,
          status: VerificationRequestStatus.Pending,
        }
      : null,
};

const authorization = new ScopedQueryPolicies(new AuthorizationMiddleware(authorizationRepository));

const authenticatedFor = (credential: string): AuthenticatedSession => {
  const authenticated = sessions[credential];
  if (authenticated === undefined)
    throw error(DomainErrorCode.Unauthorized, 'Authentication is required.', 'auth', 401);
  return authenticated;
};

const principalFor = (authenticated: AuthenticatedSession) => {
  switch (authenticated.record.accountOrGuestIdentity) {
    case HOST_ACCOUNT:
      return { accountOrGuestIdentity: HOST_ACCOUNT, authorizationVersion: 1n };
    case 'membership:membership-one':
      return {
        accountOrGuestIdentity: 'membership:membership-one',
        membershipId: MEMBER_ONE,
        participantId: PARTICIPANT_ONE,
        authorizationVersion: 1n,
      };
    case 'membership:membership-two':
      return {
        accountOrGuestIdentity: 'membership:membership-two',
        membershipId: MEMBER_TWO,
        participantId: PARTICIPANT_TWO,
        authorizationVersion: 1n,
      };
    default:
      return { accountOrGuestIdentity: 'outsider-account', authorizationVersion: 1n };
  }
};

interface Harness {
  readonly api: HttpApi;
  readonly calls: {
    configuration: number;
    snapshots: number;
    verificationRequests: number;
    verificationResponses: number;
    onboarding: number;
  };
}

const cookieHeader = (credential: string): string => `__Host-hb_session=${credential}`;

const request = (
  method: string,
  path: string,
  credential?: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request =>
  new Request(`https://app.example${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(credential === undefined ? {} : { cookie: cookieHeader(credential) }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const makeApi = (
  options: {
    readonly invitationLimiter?: InMemoryRateLimiter;
    readonly staleConfiguration?: boolean;
  } = {},
): Harness => {
  const calls = {
    configuration: 0,
    snapshots: 0,
    verificationRequests: 0,
    verificationResponses: 0,
    onboarding: 0,
  };
  const sessionsDependency = {
    authenticateSession: async (credential: string) => authenticatedFor(credential),
    validateCsrfToken: async (credential: string, token: string) => {
      if (token !== `csrf-${credential}`)
        throw error(DomainErrorCode.Forbidden, 'CSRF validation failed.', 'csrf', 403);
    },
    sessionCookieHeader: (cookie: SessionCookie) => `${cookie.name}=${cookie.value}`,
  };

  const invitations = {
    create: async () => ({ invitation: {} as never }),
    resolve: async ({
      input,
    }: {
      readonly input: { readonly joinCode?: string; readonly token?: string };
    }) => {
      const raw = input.joinCode ?? input.token ?? '';
      const decision = options.invitationLimiter?.consume('ip:integration');
      if (decision !== undefined && !decision.allowed)
        throw rateLimitedError(decision.retryAfterMs);
      if (raw === 'EXPIRE')
        throw error(
          DomainErrorCode.InvitationInvalid,
          'The invitation is invalid.',
          'invitation',
          404,
        );
      if (raw === 'REVOKE')
        throw error(
          DomainErrorCode.InvitationInvalid,
          'The invitation is invalid.',
          'invitation',
          404,
        );
      if (raw === 'CLOSED')
        throw error(
          DomainErrorCode.InvitationClosed,
          'The game is no longer accepting participants.',
          'invitation',
          404,
        );
      return {
        preview: {
          gameId: GAME_A,
          gameName: 'Private game name',
          gameStatus: GameStatus.Active,
          invitationStatus: 'available',
          joinCode: 'GOOD01',
        },
      } as never;
    },
  };

  const dependencies: HttpApiDependencies = {
    sessions: sessionsDependency as never,
    authorization,
    gameConfiguration: {
      createGame: async () => ({ game: {} as never }),
      execute: async () => {
        if (options.staleConfiguration === true) {
          throw error(
            DomainErrorCode.StaleState,
            'The command was based on stale state.',
            'stale-command',
            409,
            { currentStateVersion: 3 },
          );
        }
        calls.configuration += 1;
        return { game: {} as never, tasks: [], stateVersion: 2 as StateVersion };
      },
    } as never,
    invitations,
    onboarding: {
      onboard: async () => {
        calls.onboarding += 1;
        return { onboarding: {} as never, access: {} as never };
      },
    },
    snapshots: {
      read: async () => {
        calls.snapshots += 1;
        return { snapshot: { game: { id: GAME_A, name: 'Private game name' } } as never };
      },
    },
    verification: {
      request: async (command: { readonly identifiedPlayerCode: string }) => {
        if (command.identifiedPlayerCode === 'FOREIGN-CODE') {
          throw error(
            DomainErrorCode.InvalidPlayerCode,
            'The Player_Code is invalid for this game.',
            'cross-game',
            422,
          );
        }
        calls.verificationRequests += 1;
        return {} as never;
      },
      respond: async (_command: unknown, participantId: ParticipantId) => {
        calls.verificationResponses += 1;
        if (participantId === PARTICIPANT_ONE) {
          throw error(
            DomainErrorCode.NotIdentifiedParticipant,
            'Only the identified participant may respond to this request.',
            'other-participant',
            403,
          );
        }
        return {} as never;
      },
      listNotifications: async () => ({ notifications: [], pendingCount: 0 }),
    } as never,
    hostOverview: {
      read: async () => ({
        gameId: GAME_A as never,
        participants: [],
        leaderboards: {} as never,
        stateVersion: 0 as never,
      }),
    },
    push: { register: async () => ({ subscriptionId: 'subscription-1' as never }) },
    principalForSession: async (authenticated) => principalFor(authenticated),
  };
  return { api: new HttpApi(dependencies), calls };
};

describe('task 10.1 API authorization and security integration', () => {
  it('enforces host/member/nonmember and cross-game scope without leaking resource data', async () => {
    const harness = makeApi();

    const hostMutation = await harness.api.handle(
      request(
        'PATCH',
        `/api/games/${GAME_A}`,
        HOST_SESSION,
        { action: 'rename', name: 'Host update', knownStateVersion: 1 },
        { 'x-csrf-token': `csrf-${HOST_SESSION}`, 'idempotency-key': 'host-update' },
      ),
    );
    expect(hostMutation.status).toBe(200);
    expect(harness.calls.configuration).toBe(1);

    const memberOnHostRoute = await harness.api.handle(
      request(
        'PATCH',
        `/api/games/${GAME_A}`,
        MEMBER_ONE_SESSION,
        { action: 'rename', name: 'Unauthorized', knownStateVersion: 1 },
        { 'x-csrf-token': `csrf-${MEMBER_ONE_SESSION}`, 'idempotency-key': 'member-update' },
      ),
    );
    expect(memberOnHostRoute.status).toBe(403);
    expect(harness.calls.configuration).toBe(1);

    const outsiderSnapshot = await harness.api.handle(
      request('GET', `/api/games/${GAME_A}/snapshot`, OUTSIDER_SESSION),
    );
    expect(outsiderSnapshot.status).toBe(403);
    expect(harness.calls.snapshots).toBe(0);
    const outsiderBody = JSON.stringify(await json(outsiderSnapshot));
    expect(outsiderBody).not.toContain('Private game name');
    expect(outsiderBody).not.toContain('host-account');

    const memberCrossGameSnapshot = await harness.api.handle(
      request('GET', `/api/games/${GAME_B}/snapshot`, MEMBER_ONE_SESSION),
    );
    expect(memberCrossGameSnapshot.status).toBe(403);
    expect(harness.calls.snapshots).toBe(0);
  });

  it('binds verification responses to the session participant and protects the identified participant action', async () => {
    const harness = makeApi();
    const body = {
      gameId: GAME_A,
      knownStateVersion: 1,
    };
    const otherParticipant = await harness.api.handle(
      request('POST', '/api/verification-requests/request-1/confirm', MEMBER_ONE_SESSION, body, {
        'x-csrf-token': `csrf-${MEMBER_ONE_SESSION}`,
        'idempotency-key': 'response-one',
      }),
    );
    expect(otherParticipant.status).toBe(403);
    expect((await json(otherParticipant)).error).toMatchObject({
      code: 'NOT_IDENTIFIED_PARTICIPANT',
    });

    const identifiedParticipant = await harness.api.handle(
      request('POST', '/api/verification-requests/request-1/confirm', MEMBER_TWO_SESSION, body, {
        'x-csrf-token': `csrf-${MEMBER_TWO_SESSION}`,
        'idempotency-key': 'response-two',
      }),
    );
    expect(identifiedParticipant.status).toBe(200);
    expect(harness.calls.verificationResponses).toBe(1);
  });

  it('rejects cross-game Player_Codes before creating a verification request', async () => {
    const harness = makeApi();
    const response = await harness.api.handle(
      request(
        'POST',
        `/api/games/${GAME_A}/verification-requests`,
        MEMBER_ONE_SESSION,
        {
          gridId: 'grid-one',
          squareIndex: 7,
          identifiedPlayerCode: 'FOREIGN-CODE',
          knownStateVersion: 1,
        },
        { 'x-csrf-token': `csrf-${MEMBER_ONE_SESSION}`, 'idempotency-key': 'foreign-code' },
      ),
    );

    expect(response.status).toBe(422);
    expect((await json(response)).error).toMatchObject({ code: 'INVALID_PLAYER_CODE' });
    expect(harness.calls.verificationRequests).toBe(0);
  });

  it('rejects expired, revoked, and closed invitations without onboarding mutation', async () => {
    const harness = makeApi();
    for (const code of ['EXPIRE', 'REVOKE', 'CLOSED']) {
      const response = await harness.api.handle(request('GET', `/api/invitations/${code}`));
      expect(response.status).toBe(404);
      const responseBody = await json(response);
      expect(responseBody.error).toMatchObject({
        code: code === 'CLOSED' ? 'INVITATION_CLOSED' : 'INVITATION_INVALID',
      });
    }
    expect(harness.calls.onboarding).toBe(0);

    const validPreview = await harness.api.handle(request('GET', '/api/invitations/GOOD01'));
    expect(validPreview.status).toBe(200);
    const previewBody = JSON.stringify(await json(validPreview));
    expect(previewBody).not.toContain('tokenHash');
    expect(previewBody).not.toContain('session');
    expect(previewBody).not.toContain('raw-invitation-token');
  });

  it('enforces CSRF on cookie-authenticated mutations and stale state before mutation', async () => {
    const harness = makeApi({ staleConfiguration: true });
    const missingCsrf = await harness.api.handle(
      request('PATCH', `/api/games/${GAME_A}`, HOST_SESSION, {
        action: 'rename',
        name: 'Unsafe',
        knownStateVersion: 1,
      }),
    );
    expect(missingCsrf.status).toBe(403);
    expect(harness.calls.configuration).toBe(0);

    const badCsrf = await harness.api.handle(
      request(
        'PATCH',
        `/api/games/${GAME_A}`,
        HOST_SESSION,
        { action: 'rename', name: 'Unsafe', knownStateVersion: 1 },
        { 'x-csrf-token': 'csrf-for-a-different-session', 'idempotency-key': 'bad-csrf' },
      ),
    );
    expect(badCsrf.status).toBe(403);
    expect(harness.calls.configuration).toBe(0);

    const stale = await harness.api.handle(
      request(
        'PATCH',
        `/api/games/${GAME_A}`,
        HOST_SESSION,
        { action: 'rename', name: 'Stale', knownStateVersion: 1 },
        { 'x-csrf-token': `csrf-${HOST_SESSION}`, 'idempotency-key': 'stale' },
      ),
    );
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatchObject({
      code: 'STALE_STATE',
      metadata: { currentStateVersion: 3 },
    });
    expect(harness.calls.configuration).toBe(0);
  });

  it('rate-limits invitation resolution without creating membership or disclosing whether later codes exist', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 2, windowMs: 1_000, now: () => 10_000 });
    const harness = makeApi({ invitationLimiter: limiter });

    await expect(
      harness.api.handle(request('GET', '/api/invitations/GOOD01')),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      harness.api.handle(request('GET', '/api/invitations/GOOD01')),
    ).resolves.toMatchObject({ status: 200 });
    const limited = await harness.api.handle(request('GET', '/api/invitations/UNKNOWN'));
    expect(limited.status).toBe(429);
    expect((await json(limited)).error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(harness.calls.onboarding).toBe(0);
  });

  it('keeps credentials and private participant data out of DTOs and structured logs', async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger(
      (record) => records.push(record),
      () => FIXED_DATE,
    );
    const observability = createObservability({ logger, now: () => FIXED_DATE });
    logger.info('request.received', {
      correlationId: 'correlation-private',
      metadata: {
        cookie: 'raw-session-cookie',
        invitationToken: 'raw-invitation-token',
        playerCode: 'PLAYER-PRIVATE',
        pushSubscription: 'raw-push-secret',
        requestPayload: { password: 'private-password' },
      },
    });

    const harness = makeApi();
    const publicResponse = await harness.api.handle(request('GET', '/api/invitations/GOOD01'));
    expect(publicResponse.status).toBe(200);
    const publicBody = JSON.stringify(await json(publicResponse));
    expect(publicBody).not.toContain('raw-invitation-token');
    expect(publicBody).not.toContain('hostAccountId');

    const serializedLogs = JSON.stringify(records);
    expect(serializedLogs).not.toContain('raw-session-cookie');
    expect(serializedLogs).not.toContain('raw-invitation-token');
    expect(serializedLogs).not.toContain('PLAYER-PRIVATE');
    expect(serializedLogs).not.toContain('raw-push-secret');
    expect(serializedLogs).not.toContain('private-password');
    expect(serializedLogs).toContain('[REDACTED]');
    expect(observability).toBeDefined();
  });
});
