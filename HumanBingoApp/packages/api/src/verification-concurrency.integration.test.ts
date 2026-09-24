import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  GameStatus,
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
  type VerificationState,
} from '@human-bingo/persistence';
import { readPropertyTestOptions } from '@human-bingo/test-utils';

import { VerificationService } from './verification.js';

const GAME_ID = 'property-9-game' as GameId;
const GRID_ID = 'property-9-grid' as GridId;
const REQUESTER_ID = 'property-9-requester' as ParticipantId;
const IDENTIFIED_ID = 'property-9-identified' as ParticipantId;
const IDENTIFIED_CODE = 'IDENTIFIED' as PlayerCode;
const CORRELATION_ID = 'property-9' as CorrelationId;
const SQUARE_INDEX = 7;
const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

interface RaceScenario {
  readonly leftId: string;
  readonly rightId: string;
  readonly leftFirst: boolean;
}

const raceScenarioArbitrary: fc.Arbitrary<RaceScenario> = fc
  .tuple(fc.uuid(), fc.uuid(), fc.boolean())
  .filter(([leftId, rightId]) => leftId !== rightId)
  .map(([leftId, rightId, leftFirst]) => ({ leftId, rightId, leftFirst }));

function makeState(): VerificationState {
  const game: GameRecord = {
    id: GAME_ID,
    hostAccountId: 'property-9-host',
    name: 'Property 9 Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: CREATED_AT,
    closedAt: null,
    stateVersion: 0n,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const participants: ParticipantRecord[] = [
    { id: REQUESTER_ID, gameId: GAME_ID, createdAt: CREATED_AT, leftAt: null },
    { id: IDENTIFIED_ID, gameId: GAME_ID, createdAt: CREATED_AT, leftAt: null },
  ];
  const memberships: MembershipRecord[] = participants.map((participant, index) => ({
    id: `property-9-membership-${index}` as MembershipRecord['id'],
    gameId: GAME_ID,
    participantId: participant.id,
    browserSessionId: null,
    resumableCredentialHash: new Uint8Array([index + 1]),
    createdAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
  }));
  const profiles: PlayerProfileRecord[] = [
    {
      id: 'property-9-requester-profile' as PlayerProfileRecord['id'],
      gameId: GAME_ID,
      participantId: REQUESTER_ID,
      displayName: 'Requester',
      playerCode: 'REQUESTER' as PlayerCode,
      createdAt: CREATED_AT,
    },
    {
      id: 'property-9-identified-profile' as PlayerProfileRecord['id'],
      gameId: GAME_ID,
      participantId: IDENTIFIED_ID,
      displayName: 'Identified Participant',
      playerCode: IDENTIFIED_CODE,
      createdAt: CREATED_AT,
    },
  ];
  const tasks: TaskEntryRecord[] = Array.from({ length: 25 }, (_, index) => ({
    id: `property-9-task-${index}` as TaskEntryRecord['id'],
    gameId: GAME_ID,
    displayText: `Task ${index}`,
    normalizedText: `task ${index}`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    removedAt: null,
  }));
  const grid: GridRecord = {
    id: GRID_ID,
    gameId: GAME_ID,
    participantId: REQUESTER_ID,
    taskBagVersion: 1n,
    stateVersion: 0n,
    createdAt: CREATED_AT,
  };
  const squares: SquareRecord[] = tasks.map((task, squareIndex) => ({
    gridId: GRID_ID,
    gameId: GAME_ID,
    squareIndex,
    taskEntryId: task.id,
    status: SquareStatus.Unverified,
    updatedAt: CREATED_AT,
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

function requestCommand(id: string) {
  return {
    gameId: GAME_ID,
    gridId: GRID_ID,
    squareIndex: SQUARE_INDEX,
    identifiedPlayerCode: IDENTIFIED_CODE,
    correlationId: `${CORRELATION_ID}-${id}` as CorrelationId,
    knownStateVersion: 0 as StateVersion,
    idempotencyKey: id as IdempotencyKey,
  };
}

function authoritativeSnapshot(state: VerificationState) {
  return {
    stateVersion: state.game.stateVersion.toString(),
    square: state.squares
      .filter((square) => square.gridId === GRID_ID && square.squareIndex === SQUARE_INDEX)
      .map((square) => ({ index: square.squareIndex, status: square.status })),
    verificationRequests: state.verificationRequests.map((request) => ({
      id: request.id,
      gridId: request.gridId,
      squareIndex: request.squareIndex,
      requestingParticipantId: request.requestingParticipantId,
      identifiedParticipantId: request.identifiedParticipantId,
      status: request.status,
      clientCommandId: request.clientCommandId,
    })),
    notifications: state.notifications.map((notification) => ({
      verificationRequestId: notification.verificationRequestId,
      recipientParticipantId: notification.recipientParticipantId,
      status: notification.status,
    })),
  };
}

describe('Property 9: same-square concurrency invariant', () => {
  it('serializes competing requests and gives every client the same resulting snapshot', async () => {
    // Feature: human-bingo, Property 9: Same-square concurrency invariant
    // **Validates: Requirements 5.5, 7.5**
    await fc.assert(
      fc.asyncProperty(raceScenarioArbitrary, async (scenario) => {
        const repository = new InMemoryVerificationRepository({ states: [makeState()] });
        let generatedId = 0;
        const service = new VerificationService(repository, {
          now: () => CREATED_AT,
          idFactory: () => `property-9-generated-${++generatedId}`,
        });
        const left = { id: scenario.leftId, command: requestCommand(scenario.leftId) };
        const right = { id: scenario.rightId, command: requestCommand(scenario.rightId) };
        const ordered = scenario.leftFirst ? [left, right] : [right, left];

        const outcomes = await Promise.allSettled(
          ordered.map(({ command }) => service.request(command, REQUESTER_ID)),
        );
        const fulfilled = outcomes.filter(
          (
            outcome,
          ): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof service.request>>> =>
            outcome.status === 'fulfilled',
        );
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toMatchObject({ code: DomainErrorCode.StaleState });
        expect(fulfilled[0]?.value.stateVersion).toBe(1);

        const persisted = await repository.read(GAME_ID);
        const pending = persisted.verificationRequests.filter(
          (request) => request.status === VerificationRequestStatus.Pending,
        );
        expect(pending).toHaveLength(1);
        expect(pending[0]?.squareIndex).toBe(SQUARE_INDEX);
        expect(pending[0]?.clientCommandId).toBe(ordered[0]?.id);
        expect(
          persisted.squares.filter((square) => square.status === SquareStatus.Pending),
        ).toHaveLength(1);
        expect(persisted.game.stateVersion).toBe(1n);
        expect(persisted.grids).toHaveLength(1);
        expect(persisted.grids[0]?.stateVersion).toBe(1n);

        const firstClientSnapshot = authoritativeSnapshot(await repository.read(GAME_ID));
        const secondClientSnapshot = authoritativeSnapshot(await repository.read(GAME_ID));
        expect(firstClientSnapshot).toEqual(secondClientSnapshot);
        expect(firstClientSnapshot).toMatchObject({
          stateVersion: '1',
          square: [{ index: SQUARE_INDEX, status: SquareStatus.Pending }],
          verificationRequests: [
            {
              gridId: GRID_ID,
              squareIndex: SQUARE_INDEX,
              status: VerificationRequestStatus.Pending,
              clientCommandId: ordered[0]?.id,
            },
          ],
        });
      }),
      readPropertyTestOptions(),
    );
  });
});
