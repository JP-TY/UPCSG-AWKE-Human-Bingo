/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import {
  DomainErrorCode,
  GameStatus,
  VerificationRequestStatus,
  type GameId,
  type MembershipId,
  type ParticipantId,
  type VerificationRequestId,
} from '@human-bingo/domain';
import type { MembershipRecord } from '@human-bingo/persistence';
import {
  AuthorizationMiddleware,
  type AuthorizationPrincipal,
  type AuthorizationRepository,
} from './authorization.js';

const gameId = 'game-a' as GameId;
const otherGameId = 'game-b' as GameId;
const membershipId = 'membership-a' as MembershipId;
const participantId = 'participant-a' as ParticipantId;
const otherParticipantId = 'participant-b' as ParticipantId;
const requestId = 'request-a' as VerificationRequestId;
const now = new Date('2025-01-01T00:00:00.000Z');

const member: MembershipRecord = {
  id: membershipId,
  gameId,
  participantId,
  browserSessionId: null,
  resumableCredentialHash: new Uint8Array([1]),
  createdAt: now,
  lastSeenAt: now,
};

const principal: AuthorizationPrincipal = {
  accountOrGuestIdentity: `membership:${membershipId}`,
  membershipId,
  participantId,
  authorizationVersion: 1n,
};

const repositoryFor = (status: GameStatus = GameStatus.Active): AuthorizationRepository => ({
  findGame: async (requestedGameId) => {
    if (requestedGameId === gameId) {
      return { id: gameId, hostAccountId: 'host-a', status };
    }
    return { id: otherGameId, hostAccountId: 'host-b', status: GameStatus.Active };
  },
  findMembership: async (requestedGameId, requestedParticipantId) =>
    requestedGameId === member.gameId && requestedParticipantId === member.participantId
      ? member
      : null,
  findVerificationRequest: async (requestedGameId, requestedRequestId) => {
    if (requestedGameId !== gameId || requestedRequestId !== requestId) return null;
    return {
      gameId,
      identifiedParticipantId: participantId,
      status: VerificationRequestStatus.Pending,
    };
  },
});

describe('AuthorizationMiddleware', () => {
  it('allows member reads on closed games but rejects every member mutation', async () => {
    const middleware = new AuthorizationMiddleware(repositoryFor(GameStatus.Closed));

    await expect(middleware.authorizeMember({ gameId, principal })).resolves.toMatchObject({
      gameId,
      participantId,
      status: GameStatus.Closed,
    });
    await expect(middleware.authorizeMemberMutation({ gameId, principal })).rejects.toMatchObject({
      code: DomainErrorCode.GameClosed,
      httpStatus: 409,
    });
  });

  it('restricts host setup to the host and rejects setup after closure', async () => {
    const active = new AuthorizationMiddleware(repositoryFor());
    await expect(
      active.authorizeHost({ gameId, principal: { accountOrGuestIdentity: 'host-a' } }),
    ).resolves.toMatchObject({ role: 'host', status: GameStatus.Active });
    await expect(
      active.authorizeHost({ gameId, principal: { accountOrGuestIdentity: 'not-the-host' } }),
    ).rejects.toMatchObject({ code: DomainErrorCode.Forbidden });

    const closed = new AuthorizationMiddleware(repositoryFor(GameStatus.Closed));
    await expect(
      closed.authorizeHost({ gameId, principal: { accountOrGuestIdentity: 'host-a' } }),
    ).rejects.toMatchObject({ code: DomainErrorCode.GameClosed });
  });

  it('allows both the joined member and host to subscribe to the game channel', async () => {
    const middleware = new AuthorizationMiddleware(repositoryFor());

    await expect(middleware.authorizeWebSocketSubscriber({ gameId, principal })).resolves.toMatchObject({
      role: 'member',
      participantId,
    });
    await expect(
      middleware.authorizeWebSocketSubscriber({
        gameId,
        principal: { accountOrGuestIdentity: 'host-a' },
      }),
    ).resolves.toMatchObject({ role: 'host', gameId });
  });

  it('does not grant a channel subscription to an unrelated principal', async () => {
    const middleware = new AuthorizationMiddleware(repositoryFor());
    await expect(
      middleware.authorizeWebSocketSubscriber({
        gameId,
        principal: { accountOrGuestIdentity: 'not-the-host' },
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.Forbidden });
  });

  it('does not permit a resumable credential to select another participant', async () => {
    const middleware = new AuthorizationMiddleware(repositoryFor());
    await expect(
      middleware.authorizeResumable({
        gameId,
        participantId: otherParticipantId,
        principal,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.Forbidden });
  });

  it('requires the identified participant and scopes request lookup to the game', async () => {
    const middleware = new AuthorizationMiddleware(repositoryFor());
    await expect(
      middleware.authorizeVerificationResponse({
        gameId,
        principal,
        verificationRequestId: requestId,
      }),
    ).resolves.toMatchObject({ identifiedParticipantId: participantId });

    await expect(
      middleware.authorizeVerificationResponse({
        gameId,
        principal: {
          ...principal,
          participantId: otherParticipantId,
          membershipId: 'membership-b' as MembershipId,
          accountOrGuestIdentity: 'membership:membership-b',
        },
        verificationRequestId: requestId,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.Forbidden });

    await expect(
      middleware.authorizeVerificationResponse({
        gameId: otherGameId,
        principal,
        verificationRequestId: requestId,
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.Forbidden });
  });
});
