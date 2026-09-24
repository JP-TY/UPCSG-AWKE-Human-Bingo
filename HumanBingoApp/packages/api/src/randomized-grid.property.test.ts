import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GameStatus,
  SquareStatus,
  type CorrelationId,
  type GameId,
  type ParticipantId,
  type TaskEntryId,
} from '@human-bingo/domain';
import {
  InMemoryGridRepository,
  type GameRecord,
  type GridState,
  type SquareRecord,
  type TaskEntryRecord,
} from '@human-bingo/persistence';
import { readPropertyTestOptions, seededRandom } from '@human-bingo/test-utils';

import { GridService } from './grid.js';

const GAME_ID = 'property-5-game' as GameId;
const FIRST_PARTICIPANT_ID = 'property-5-participant-one' as ParticipantId;
const SECOND_PARTICIPANT_ID = 'property-5-participant-two' as ParticipantId;
const CORRELATION_ID = 'property-5-correlation' as CorrelationId;
const NOW = new Date('2025-01-01T00:00:00.000Z');

interface GridScenario {
  readonly taskCount: number;
  readonly randomSeed: number;
}

const gridScenarioArbitrary: fc.Arbitrary<GridScenario> = fc.record({
  taskCount: fc.integer({ min: 25, max: 50 }),
  randomSeed: fc.integer(),
});

const makeState = (taskCount: number): GridState => {
  const game: GameRecord = {
    id: GAME_ID,
    hostAccountId: 'property-5-host',
    name: 'Property 5 Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: NOW,
    closedAt: null,
    stateVersion: 1n,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const tasks: TaskEntryRecord[] = Array.from({ length: taskCount }, (_, index) => ({
    id: `property-5-task-${index}` as TaskEntryId,
    gameId: GAME_ID,
    displayText: `Property 5 task ${index}`,
    normalizedText: `property 5 task ${index}`,
    createdAt: NOW,
    updatedAt: NOW,
    removedAt: null,
  }));

  return { game, tasks, grids: [], squares: [] };
};

const arrangementFor = (squares: readonly SquareRecord[]): string[] =>
  squares
    .slice()
    .sort((left, right) => left.squareIndex - right.squareIndex)
    .map((square) => square.taskEntryId);

const assertValidArrangement = (
  squares: readonly SquareRecord[],
  lockedTaskIds: ReadonlySet<string>,
  sequentialTaskIds: readonly string[],
): void => {
  const arrangement = arrangementFor(squares);
  expect(arrangement).toHaveLength(25);
  expect(squares.map((square) => square.squareIndex).sort((left, right) => left - right)).toEqual(
    Array.from({ length: 25 }, (_, index) => index),
  );
  expect(new Set(arrangement).size).toBe(25);
  expect(arrangement.every((taskId) => lockedTaskIds.has(taskId))).toBe(true);
  expect(arrangement).not.toEqual(sequentialTaskIds);
  expect(squares.every((square) => square.status === SquareStatus.Unverified)).toBe(true);
};

const storedArrangementFor = (squares: readonly SquareRecord[], gridId: string): string[] =>
  arrangementFor(squares.filter((square) => square.gridId === gridId));

describe('Property 5: randomized grid permutation', () => {
  it('persists valid independent permutations for multiple participants', async () => {
    // Feature: human-bingo, Property 5
    // **Validates: Requirements 4.2, 4.3, 4.4, 4.6**
    await fc.assert(
      fc.asyncProperty(gridScenarioArbitrary, async ({ taskCount, randomSeed }) => {
        const repository = new InMemoryGridRepository({ states: [makeState(taskCount)] });
        const random = seededRandom(randomSeed);
        let gridSequence = 0;
        const service = new GridService(repository, {
          now: () => NOW,
          idFactory: () => `property-5-grid-${++gridSequence}`,
          randomBytes: (size) => random.bytes(size),
        });
        const lockedTaskIds = new Set(
          Array.from({ length: taskCount }, (_, index) => `property-5-task-${index}`),
        );
        const sequentialTaskIds = Array.from(
          { length: 25 },
          (_, index) => `property-5-task-${index}`,
        );

        const first = await service.generateOrResume({
          gameId: GAME_ID,
          participantId: FIRST_PARTICIPANT_ID,
          correlationId: CORRELATION_ID,
        });
        assertValidArrangement(first.squares, lockedTaskIds, sequentialTaskIds);
        const firstArrangement = arrangementFor(first.squares);

        const second = await service.generateOrResume({
          gameId: GAME_ID,
          participantId: SECOND_PARTICIPANT_ID,
          correlationId: CORRELATION_ID,
        });
        assertValidArrangement(second.squares, lockedTaskIds, sequentialTaskIds);
        const secondArrangement = arrangementFor(second.squares);

        const stored = await repository.read(GAME_ID);
        expect(stored.grids).toHaveLength(2);
        expect(stored.squares).toHaveLength(50);
        expect(storedArrangementFor(stored.squares, first.grid.id)).toEqual(firstArrangement);
        expect(storedArrangementFor(stored.squares, second.grid.id)).toEqual(secondArrangement);
        expect(stored.squares.filter((square) => square.gridId === first.grid.id)).toHaveLength(25);
        expect(stored.squares.filter((square) => square.gridId === second.grid.id)).toHaveLength(
          25,
        );

        // The two arrangements may be equal by chance; the property only
        // requires independent persistence and valid per-grid permutations.
      }),
      readPropertyTestOptions(),
    );
  });
});
