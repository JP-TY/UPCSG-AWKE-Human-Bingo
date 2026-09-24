import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  GameStatus,
  NotificationStatus,
  SquareStatus,
  VerificationRequestStatus,
  type CorrelationId,
  type GameId,
  type GridId,
  type IdempotencyKey,
  type ParticipantId,
  type PlayerCode,
  type StateVersion,
} from '@human-bingo/domain';
import {
  emptyVerificationState,
  InMemoryVerificationRepository,
  type GameRecord,
  type GridRecord,
  type MembershipRecord,
  type ParticipantRecord,
  type PlayerProfileRecord,
  type SquareRecord,
  type TaskEntryRecord,
} from '@human-bingo/persistence';

import { VerificationService } from './verification.js';

const gameId = 'property-7-game' as GameId;
const gridId = 'property-7-grid' as GridId;
const requesterId = 'property-7-requester' as ParticipantId;
const identifiedId = 'property-7-identified' as ParticipantId;
const requesterCode = 'REQUESTER' as PlayerCode;
const identifiedCode = 'IDENTIFIED' as PlayerCode;
const correlationId = 'property-7' as CorrelationId;
const createdAt = new Date('2025-01-01T00:00:00.000Z');

function recordFixture(): ReturnType<typeof emptyVerificationState> {
  const game: GameRecord = {
    id: gameId,
    hostAccountId: 'property-7-host',
    name: 'Property 7 Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: createdAt,
    closedAt: null,
    stateVersion: 0n,
    createdAt,
    updatedAt: createdAt,
  };
  const participants: ParticipantRecord[] = [
    { id: requesterId, gameId, createdAt, leftAt: null },
    { id: identifiedId, gameId, createdAt, leftAt: null },
  ];
  const memberships: MembershipRecord[] = participants.map((participant, index) => ({
    id: `property-7-membership-${index}` as MembershipRecord['id'],
    gameId,
    participantId: participant.id,
    browserSessionId: null,
    resumableCredentialHash: new Uint8Array([index + 1]),
    createdAt,
    lastSeenAt: createdAt,
  }));
  const profiles: PlayerProfileRecord[] = [
    {
      id: 'property-7-requester-profile' as PlayerProfileRecord['id'],
      gameId,
      participantId: requesterId,
      displayName: 'Requester',
      playerCode: requesterCode,
      createdAt,
    },
    {
      id: 'property-7-identified-profile' as PlayerProfileRecord['id'],
      gameId,
      participantId: identifiedId,
      displayName: 'Identified Participant',
      playerCode: identifiedCode,
      createdAt,
    },
  ];
  const tasks: TaskEntryRecord[] = Array.from({ length: 25 }, (_, squareIndex) => ({
    id: `property-7-task-${squareIndex}` as TaskEntryRecord['id'],
    gameId,
    displayText: `Task ${squareIndex}`,
    normalizedText: `task ${squareIndex}`,
    createdAt,
    updatedAt: createdAt,
    removedAt: null,
  }));
  const grid: GridRecord = {
    id: gridId,
    gameId,
    participantId: requesterId,
    taskBagVersion: 1n,
    stateVersion: 0n,
    createdAt,
  };
  const squares: SquareRecord[] = tasks.map((task, squareIndex) => ({
    gridId,
    gameId,
    squareIndex,
    taskEntryId: task.id,
    status: SquareStatus.Unverified,
    updatedAt: createdAt,
  }));

  return emptyVerificationState({
    game,
    tasks,
    memberships,
    participants,
    profiles,
    grids: [grid],
    squares,
  });
}

describe('Durable notification lifecycle properties', () => {
  it('keeps one recipient-scoped notification pending, then resolves it into retained history', async () => {
    // Feature: human-bingo, Property 7: Durable notification lifecycle
    // Validates: Requirements 6.1, 6.4, 6.7
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          squareIndex: fc.integer({ min: 0, max: 24 }),
          decision: fc.constantFrom<'confirm' | 'reject'>('confirm', 'reject'),
        }),
        async ({ squareIndex, decision }) => {
          const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
          const service = new VerificationService(repository, {
            now: () => createdAt,
            idFactory: (() => {
              let sequence = 0;
              return () => `property-7-generated-${++sequence}`;
            })(),
          });

          const request = await service.request(
            {
              gameId,
              gridId,
              squareIndex,
              identifiedPlayerCode: identifiedCode,
              correlationId,
              knownStateVersion: 0 as StateVersion,
              idempotencyKey: `property-7-request-${squareIndex}` as IdempotencyKey,
            },
            requesterId,
          );

          expect(request.notifications).toHaveLength(1);
          expect(request.notifications[0]).toMatchObject({
            recipientParticipantId: identifiedId,
            verificationRequestId: request.request.id,
            status: NotificationStatus.Pending,
          });

          const pending = await service.listNotifications({ gameId, correlationId }, identifiedId);
          expect(pending.pendingCount).toBe(1);
          expect(pending.notifications).toHaveLength(1);
          expect(pending.notifications[0]).toMatchObject({
            recipientParticipantId: identifiedId,
            verificationRequestId: request.request.id,
            status: NotificationStatus.Pending,
          });

          const resolved = await service.respond(
            {
              gameId,
              verificationRequestId: request.request.id,
              decision,
              correlationId,
              knownStateVersion: 1 as StateVersion,
              idempotencyKey: `property-7-response-${squareIndex}-${decision}` as IdempotencyKey,
            },
            identifiedId,
          );

          expect(resolved.request.status).toBe(
            decision === 'confirm'
              ? VerificationRequestStatus.Confirmed
              : VerificationRequestStatus.Rejected,
          );
          expect(resolved.notifications).toHaveLength(1);
          expect(resolved.notifications[0]).toMatchObject({
            recipientParticipantId: identifiedId,
            verificationRequestId: request.request.id,
            status: NotificationStatus.Resolved,
          });

          const afterResolution = await service.listNotifications(
            { gameId, correlationId },
            identifiedId,
          );
          expect(afterResolution).toEqual({ notifications: [], pendingCount: 0 });

          const history = await service.listNotifications(
            { gameId, correlationId, includeResolved: true },
            identifiedId,
          );
          expect(history.pendingCount).toBe(0);
          expect(history.notifications).toHaveLength(1);
          expect(history.notifications[0]).toMatchObject({
            recipientParticipantId: identifiedId,
            verificationRequestId: request.request.id,
            status: NotificationStatus.Resolved,
          });
          expect(history.notifications[0]?.resolvedAt).toBeDefined();

          const persisted = await repository.read(gameId);
          expect(
            persisted.notifications.filter(
              (notification) => notification.verificationRequestId === request.request.id,
            ),
          ).toHaveLength(1);
          expect(persisted.notifications[0]?.status).toBe(NotificationStatus.Resolved);
        },
      ),
      { numRuns: 100 },
    );
  });
});
