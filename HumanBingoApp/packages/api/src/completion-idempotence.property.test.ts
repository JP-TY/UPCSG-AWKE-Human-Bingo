import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CompletionCategory,
  getCompletedLines,
  getLineIndices,
  GameStatus,
  HASHTAG_INDICES,
  isBlackoutComplete,
  isHashtagComplete,
  LineDirection,
  SquareStatus,
  type CompletionKey,
  type CorrelationId,
  type CompletionId,
  type GameId,
  type GridId,
  type IdempotencyKey,
  type LinePosition,
  type ParticipantId,
  type PlayerCode,
  type StateVersion,
  type VerificationRequestId,
} from '@human-bingo/domain';
import {
  emptyVerificationState,
  InMemoryVerificationRepository,
  type CompletionRecord,
  type GameRecord,
  type GridRecord,
  type MembershipRecord,
  type ParticipantRecord,
  type PlayerProfileRecord,
  type TaskEntryRecord,
  type VerificationState,
} from '@human-bingo/persistence';
import { readPropertyTestOptions } from '@human-bingo/test-utils';

import { VerificationService } from './verification.js';
import { projectLeaderboards } from './leaderboards.js';

const GAME_ID = 'property-11-game' as GameId;
const GRID_ID = 'property-11-grid' as GridId;
const REQUESTER_ID = 'property-11-requester' as ParticipantId;
const IDENTIFIED_ID = 'property-11-identified' as ParticipantId;
const IDENTIFIED_CODE = 'IDENTIFIED' as PlayerCode;
const CORRELATION_ID = 'property-11' as CorrelationId;
const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');

const EXTRA_PARTICIPANTS: readonly { readonly id: ParticipantId; readonly code: PlayerCode }[] = [
  { id: 'property-11-identified-2' as ParticipantId, code: 'EXTRA2' as PlayerCode },
  { id: 'property-11-identified-3' as ParticipantId, code: 'EXTRA3' as PlayerCode },
  { id: 'property-11-identified-4' as ParticipantId, code: 'EXTRA4' as PlayerCode },
];

type PersistenceCompletionKey = CompletionRecord['completionKey'];

type CompletionPlan = {
  readonly category: CompletionCategory;
  readonly key: PersistenceCompletionKey;
  readonly indices: readonly number[];
  readonly trigger: number;
};

type CompletionScenario = {
  readonly plan: CompletionPlan;
  readonly fullBoard: boolean;
  readonly extraIndices: readonly number[];
  readonly laterOffsetMs: number;
  readonly duplicateDeliveries: number;
};

const linePlans: readonly CompletionPlan[] = [
  ...Array.from({ length: 5 }, (_, index) => ({
    category: CompletionCategory.Line,
    key: `row:${index + 1}` as PersistenceCompletionKey,
    indices: getLineIndices({
      direction: LineDirection.Horizontal,
      position: (index + 1) as 1 | 2 | 3 | 4 | 5,
    }),
    trigger: 0,
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    category: CompletionCategory.Line,
    key: `column:${index + 1}` as PersistenceCompletionKey,
    indices: getLineIndices({
      direction: LineDirection.Vertical,
      position: (index + 1) as 1 | 2 | 3 | 4 | 5,
    }),
    trigger: 0,
  })),
  {
    category: CompletionCategory.Line,
    key: 'diag:tlbr',
    indices: getLineIndices({
      direction: LineDirection.Diagonal,
      position: 'top_left_to_bottom_right',
    }),
    trigger: 0,
  },
  {
    category: CompletionCategory.Line,
    key: 'diag:trbl',
    indices: getLineIndices({
      direction: LineDirection.Diagonal,
      position: 'top_right_to_bottom_left',
    }),
    trigger: 4,
  },
];

function planArbitrary(base: CompletionPlan): fc.Arbitrary<CompletionPlan> {
  return fc
    .record({
      triggerOffset: fc.integer({ min: 0, max: base.indices.length - 1 }),
    })
    .map(({ triggerOffset }) => ({
      ...base,
      trigger: base.indices[triggerOffset]!,
    }));
}

const generatedPlanArbitrary = fc.oneof(
  fc
    .integer({ min: 0, max: linePlans.length - 1 })
    .chain((index) => planArbitrary(linePlans[index]!)),
  fc.integer({ min: 0, max: 24 }).map((trigger) => ({
    category: CompletionCategory.Blackout,
    key: 'blackout' as const,
    indices: Array.from({ length: 25 }, (_, index) => index),
    trigger,
  })),
  fc.integer({ min: 0, max: HASHTAG_INDICES.length - 1 }).chain((triggerOffset) =>
    planArbitrary({
      category: CompletionCategory.Hashtag,
      key: 'hashtag',
      indices: HASHTAG_INDICES,
      trigger: HASHTAG_INDICES[triggerOffset]!,
    }),
  ),
);

const scenarioArbitrary: fc.Arbitrary<CompletionScenario> = generatedPlanArbitrary.chain((plan) =>
  fc
    .record({
      fullBoard: fc.boolean(),
      extraIndices: fc.uniqueArray(fc.integer({ min: 0, max: 24 }), { maxLength: 3 }),
      laterOffsetMs: fc.integer({ min: 0, max: 1000 }),
      duplicateDeliveries: fc.integer({ min: 1, max: 3 }),
    })
    .filter(({ extraIndices }) => extraIndices.every((index) => !plan.indices.includes(index)))
    .map(({ fullBoard, extraIndices, laterOffsetMs, duplicateDeliveries }) => ({
      plan,
      fullBoard,
      extraIndices: fullBoard ? [] : extraIndices,
      laterOffsetMs,
      duplicateDeliveries,
    })),
);

function persistenceKeyForLine(line: LinePosition): PersistenceCompletionKey {
  if (line.direction === LineDirection.Horizontal) return `row:${line.position}`;
  if (line.direction === LineDirection.Vertical) return `column:${line.position}`;
  return line.position === 'top_left_to_bottom_right' ? 'diag:tlbr' : 'diag:trbl';
}

function categoryForKey(key: PersistenceCompletionKey): CompletionCategory {
  if (key === 'blackout') return CompletionCategory.Blackout;
  if (key === 'hashtag') return CompletionCategory.Hashtag;
  return CompletionCategory.Line;
}

function domainKeyForPersistenceKey(key: PersistenceCompletionKey): CompletionKey {
  switch (key) {
    case 'blackout':
    case 'hashtag':
      return key;
    case 'diag:tlbr':
      return 'diagonal:top_left_to_bottom_right';
    case 'diag:trbl':
      return 'diagonal:top_right_to_bottom_left';
    default: {
      const [direction, position] = key.split(':');
      return direction === 'row'
        ? (`horizontal:${position}` as CompletionKey)
        : (`vertical:${position}` as CompletionKey);
    }
  }
}

function qualifyingKeys(statuses: readonly SquareStatus[]): Set<PersistenceCompletionKey> {
  const keys = new Set<PersistenceCompletionKey>();
  if (isBlackoutComplete(statuses)) keys.add('blackout');
  if (isHashtagComplete(statuses)) keys.add('hashtag');
  for (const line of getCompletedLines(statuses)) keys.add(persistenceKeyForLine(line));
  return keys;
}

function makeGame(): GameRecord {
  return {
    id: GAME_ID,
    hostAccountId: 'property-11-host',
    name: 'Property 11 Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: CREATED_AT,
    closedAt: null,
    stateVersion: 0n,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function makeState(scenario: CompletionScenario): VerificationState {
  const game = makeGame();
  const participants: ParticipantRecord[] = [
    { id: REQUESTER_ID, gameId: GAME_ID, createdAt: CREATED_AT, leftAt: null },
    { id: IDENTIFIED_ID, gameId: GAME_ID, createdAt: CREATED_AT, leftAt: null },
    ...EXTRA_PARTICIPANTS.map(({ id }) => ({
      id,
      gameId: GAME_ID,
      createdAt: CREATED_AT,
      leftAt: null,
    })),
  ];
  const memberships: MembershipRecord[] = participants.map((participant, index) => ({
    id: `property-11-membership-${index}` as MembershipRecord['id'],
    gameId: GAME_ID,
    participantId: participant.id,
    browserSessionId: null,
    resumableCredentialHash: new Uint8Array([index + 1]),
    createdAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
  }));
  const profiles: PlayerProfileRecord[] = [
    {
      id: 'property-11-requester-profile' as PlayerProfileRecord['id'],
      gameId: GAME_ID,
      participantId: REQUESTER_ID,
      displayName: 'Requester',
      playerCode: 'REQUESTER',
      createdAt: CREATED_AT,
    },
    {
      id: 'property-11-identified-profile' as PlayerProfileRecord['id'],
      gameId: GAME_ID,
      participantId: IDENTIFIED_ID,
      displayName: 'Identified Participant',
      playerCode: IDENTIFIED_CODE,
      createdAt: CREATED_AT,
    },
    ...EXTRA_PARTICIPANTS.map(({ id, code }, index) => ({
      id: `property-11-extra-profile-${index + 1}` as PlayerProfileRecord['id'],
      gameId: GAME_ID,
      participantId: id,
      displayName: `Extra Participant ${index + 2}`,
      playerCode: code,
      createdAt: CREATED_AT,
    })),
  ];
  const tasks: TaskEntryRecord[] = Array.from({ length: 25 }, (_, index) => ({
    id: `property-11-task-${index}` as TaskEntryRecord['id'],
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
  const initiallyVerified = new Set<number>();
  if (scenario.fullBoard) {
    for (let index = 0; index < 25; index += 1) {
      if (index !== scenario.plan.trigger) initiallyVerified.add(index);
    }
  } else {
    for (const index of scenario.plan.indices) {
      if (index !== scenario.plan.trigger) initiallyVerified.add(index);
    }
  }
  const squares = tasks.map((task, squareIndex) => ({
    gridId: GRID_ID,
    gameId: GAME_ID,
    squareIndex,
    taskEntryId: task.id,
    status: initiallyVerified.has(squareIndex) ? SquareStatus.Verified : SquareStatus.Unverified,
    updatedAt: CREATED_AT,
  }));
  const initialKeys = qualifyingKeys(squares.map((square) => square.status));
  const completions: CompletionRecord[] = [...initialKeys].map((key, index) => ({
    id: `property-11-seeded-completion-${index}` as CompletionId,
    gameId: GAME_ID,
    participantId: REQUESTER_ID,
    category: categoryForKey(key),
    completionKey: key,
    completedAt: CREATED_AT,
    createdAt: CREATED_AT,
  }));

  return emptyVerificationState({
    game,
    tasks,
    memberships,
    participants,
    profiles,
    grids: [grid],
    squares,
    completions,
  });
}

function requestCommand(
  id: string,
  squareIndex: number,
  knownStateVersion: number,
  identifiedPlayerCode: PlayerCode,
) {
  return {
    gameId: GAME_ID,
    gridId: GRID_ID,
    squareIndex,
    identifiedPlayerCode,
    correlationId: `${CORRELATION_ID}-${id}` as CorrelationId,
    knownStateVersion: knownStateVersion as StateVersion,
    idempotencyKey: `${CORRELATION_ID}-${id}` as IdempotencyKey,
  };
}

function responseCommand(
  id: string,
  verificationRequestId: VerificationRequestId,
  knownStateVersion: number,
) {
  return {
    gameId: GAME_ID,
    verificationRequestId,
    decision: 'confirm' as const,
    correlationId: `${CORRELATION_ID}-${id}` as CorrelationId,
    knownStateVersion: knownStateVersion as StateVersion,
    idempotencyKey: `${CORRELATION_ID}-${id}` as IdempotencyKey,
  };
}

function mutationFingerprint(state: VerificationState): string {
  return JSON.stringify({
    game: {
      stateVersion: String(state.game.stateVersion),
      updatedAt: state.game.updatedAt.toISOString(),
    },
    squares: state.squares.map((square) => [
      square.squareIndex,
      square.status,
      square.updatedAt.toISOString(),
    ]),
    requests: state.verificationRequests.map((request) => ({
      id: request.id,
      squareIndex: request.squareIndex,
      status: request.status,
      clientCommandId: request.clientCommandId,
    })),
    notifications: state.notifications.map((notification) => ({
      verificationRequestId: notification.verificationRequestId,
      status: notification.status,
    })),
    completions: state.completions.map((completion) => ({
      category: completion.category,
      key: completion.completionKey,
      completedAt: completion.completedAt.toISOString(),
    })),
  });
}

function completionTimestampMap(state: VerificationState): Map<string, string> {
  return new Map(
    state.completions.map((completion) => [
      `${completion.category}:${completion.completionKey}`,
      completion.completedAt.toISOString(),
    ]),
  );
}

function assertCompletionInvariant(state: VerificationState): void {
  const statuses = state.squares
    .filter((square) => square.gridId === GRID_ID)
    .sort((left, right) => left.squareIndex - right.squareIndex)
    .map((square) => square.status);
  const expected = qualifyingKeys(statuses);
  const identities = state.completions.map(
    (completion) => `${completion.category}:${completion.completionKey}`,
  );
  expect(new Set(identities).size).toBe(identities.length);
  expect(new Set(state.completions.map((completion) => completion.completionKey))).toEqual(
    expected,
  );

  const leaderboards = projectLeaderboards(state);
  const blackoutCount = state.completions.filter(
    (completion) => completion.category === CompletionCategory.Blackout,
  ).length;
  const lineCount = state.completions.filter(
    (completion) => completion.category === CompletionCategory.Line,
  ).length;
  const hashtagCount = state.completions.filter(
    (completion) => completion.category === CompletionCategory.Hashtag,
  ).length;
  expect(leaderboards.blackout.totalCompletions).toBe(blackoutCount);
  expect(leaderboards.hashtag.totalCompletions).toBe(hashtagCount);
  expect(leaderboards.line.entries[0]?.completionCount ?? 0).toBe(lineCount);
}

describe('Property 11: completion insertion idempotence and counts', () => {
  it('keeps one row and one count increment per qualifying key across repeated evaluations and duplicate deliveries', async () => {
    // Feature: human-bingo, Property 11: Completion insertion idempotence and counts
    // Validates: Requirements 8.2, 8.3, 9.4, 10.3
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        let now = new Date(CREATED_AT);
        let generatedId = 0;
        const repository = new InMemoryVerificationRepository({ states: [makeState(scenario)] });
        const service = new VerificationService(repository, {
          now: () => new Date(now),
          idFactory: () => `property-11-generated-${++generatedId}`,
        });

        let state = await repository.read(GAME_ID);
        assertCompletionInvariant(state);
        const beforeFirst = await repository.read(GAME_ID);
        const targetRequest = await service.request(
          requestCommand(
            'target-request',
            scenario.plan.trigger,
            Number(beforeFirst.game.stateVersion),
            IDENTIFIED_CODE,
          ),
          REQUESTER_ID,
        );
        const targetResponseCommand = responseCommand(
          'target-response',
          targetRequest.request.id,
          Number(targetRequest.stateVersion),
        );
        const first = await service.confirm(targetResponseCommand, IDENTIFIED_ID);
        state = await repository.read(GAME_ID);
        assertCompletionInvariant(state);
        const firstTimestampMap = completionTimestampMap(state);
        const firstFingerprint = mutationFingerprint(state);
        const priorCompletionKeys = new Set(
          beforeFirst.completions.map((completion) => completion.completionKey),
        );
        const insertedCompletionKeys = state.completions
          .map((completion) => completion.completionKey)
          .filter((key) => !priorCompletionKeys.has(key));
        expect(first.completions.map((completion) => completion.completionKey).sort()).toEqual(
          insertedCompletionKeys.map(domainKeyForPersistenceKey).sort(),
        );
        expect(new Set(first.completions.map((completion) => completion.completionKey)).size).toBe(
          first.completions.length,
        );
        expect(
          first.completions.every(
            (completion) => completion.completedAt === CREATED_AT.toISOString(),
          ),
        ).toBe(true);

        for (let duplicate = 0; duplicate < scenario.duplicateDeliveries; duplicate += 1) {
          await expect(service.confirm(targetResponseCommand, IDENTIFIED_ID)).resolves.toEqual(
            first,
          );
          expect(mutationFingerprint(await repository.read(GAME_ID))).toBe(firstFingerprint);
        }

        now = new Date(CREATED_AT.getTime() + scenario.laterOffsetMs);
        for (const [extraPosition, squareIndex] of scenario.extraIndices.entries()) {
          state = await repository.read(GAME_ID);
          const extraParticipant = EXTRA_PARTICIPANTS[extraPosition];
          if (extraParticipant === undefined) {
            throw new Error('Not enough distinct identified participants for extra requests');
          }
          const request = await service.request(
            requestCommand(
              `extra-${extraPosition}-request`,
              squareIndex,
              Number(state.game.stateVersion),
              extraParticipant.code,
            ),
            REQUESTER_ID,
          );
          await service.confirm(
            responseCommand(
              `extra-${extraPosition}-response`,
              request.request.id,
              Number(request.stateVersion),
            ),
            extraParticipant.id,
          );
          state = await repository.read(GAME_ID);
          assertCompletionInvariant(state);
          for (const [identity, timestamp] of firstTimestampMap) {
            expect(completionTimestampMap(state).get(identity)).toBe(timestamp);
          }
        }

        state = await repository.read(GAME_ID);
        assertCompletionInvariant(state);
        const finalKeys = new Set(state.completions.map((completion) => completion.completionKey));
        expect(finalKeys).toEqual(
          qualifyingKeys(
            state.squares
              .filter((square) => square.gridId === GRID_ID)
              .sort((left, right) => left.squareIndex - right.squareIndex)
              .map((square) => square.status),
          ),
        );
        expect(
          state.completions.every((completion) => completion.participantId === REQUESTER_ID),
        ).toBe(true);
      }),
      readPropertyTestOptions(),
    );
  });
});
