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
  type TaskEntryRecord,
} from '@human-bingo/persistence';
import { readPropertyTestOptions, seededRandom } from '@human-bingo/test-utils';

import { GridService } from './grid.js';

const GAME_ID = 'property-4-game' as GameId;
const PARTICIPANT_ID = 'property-4-participant' as ParticipantId;
const CORRELATION_ID = 'property-4-correlation' as CorrelationId;
const NOW = new Date('2025-01-01T00:00:00.000Z');

interface OnboardingScenario {
  readonly taskCount: number;
  readonly resumeCount: number;
  readonly statuses: readonly SquareStatus[];
  readonly randomSeed: number;
}

const squareStatusArbitrary = fc.constantFrom(
  SquareStatus.Unverified,
  SquareStatus.Pending,
  SquareStatus.Rejected,
  SquareStatus.Verified,
);

const onboardingScenarioArbitrary: fc.Arbitrary<OnboardingScenario> = fc.record({
  taskCount: fc.integer({ min: 25, max: 50 }),
  resumeCount: fc.integer({ min: 1, max: 8 }),
  statuses: fc.array(squareStatusArbitrary, { minLength: 25, maxLength: 25 }),
  randomSeed: fc.nat(),
});

const makeState = (taskCount: number): GridState => {
  const game: GameRecord = {
    id: GAME_ID,
    hostAccountId: 'property-4-host',
    name: 'Property 4 Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: new Date('2025-01-01T00:00:00.000Z'),
    closedAt: null,
    stateVersion: 1n,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const tasks: TaskEntryRecord[] = Array.from({ length: taskCount }, (_, index) => ({
    id: `property-4-task-${index + 1}` as TaskEntryId,
    gameId: GAME_ID,
    displayText: `Property 4 task ${index + 1}`,
    normalizedText: `property 4 task ${index + 1}`,
    createdAt: NOW,
    updatedAt: NOW,
    removedAt: null,
  }));

  return { game, tasks, grids: [], squares: [] };
};

const command = {
  gameId: GAME_ID,
  participantId: PARTICIPANT_ID,
  correlationId: CORRELATION_ID,
};

describe('Property 4: onboarding and resume idempotence', () => {
  it('keeps one persisted grid and restores its positions and square statuses for every resume', async () => {
    // Feature: human-bingo, Property 4
    // **Validates: Requirements 3.1, 3.2, 3.4, 3.5, 4.1, 4.5**
    const options = readPropertyTestOptions();

    await fc.assert(
      fc.asyncProperty(onboardingScenarioArbitrary, async (scenario) => {
        const repository = new InMemoryGridRepository({ states: [makeState(scenario.taskCount)] });
        const random = seededRandom(scenario.randomSeed);
        const service = new GridService(repository, {
          now: () => NOW,
          idFactory: () => 'property-4-grid',
          randomBytes: (size) => random.bytes(size),
        });

        const first = await service.generateOrResume(command);
        expect(first.resumed).toBe(false);
        expect(first.squares).toHaveLength(25);
        expect(first.squares.every((square) => square.status === SquareStatus.Unverified)).toBe(
          true,
        );

        const firstTaskIds = first.squares.map((square) => square.taskEntryId);
        const firstGridId = first.grid.id;

        await repository.withGridState(GAME_ID, PARTICIPANT_ID, (state) => {
          state.squares = state.squares.map((square, index) => ({
            ...square,
            status: scenario.statuses[index] ?? SquareStatus.Unverified,
            updatedAt: NOW,
          }));
        });

        for (let attempt = 0; attempt < scenario.resumeCount; attempt += 1) {
          const resumed = await service.generateOrResume(command);

          expect(resumed.resumed).toBe(true);
          expect(resumed.grid.id).toBe(firstGridId);
          expect(resumed.squares.map((square) => square.taskEntryId)).toEqual(firstTaskIds);
          expect(resumed.squares.map((square) => square.status)).toEqual(scenario.statuses);
        }

        const stored = await repository.read(GAME_ID);
        expect(stored.game.status).toBe(GameStatus.Active);
        expect(stored.game.taskBagLockedAt).not.toBeNull();
        expect(stored.grids).toHaveLength(1);
        expect(stored.grids[0]?.participantId).toBe(PARTICIPANT_ID);
        expect(stored.squares).toHaveLength(25);
        expect(stored.squares.map((square) => square.taskEntryId)).toEqual(firstTaskIds);
        expect(stored.squares.map((square) => square.status)).toEqual(scenario.statuses);
      }),
      options,
    );
  });
});
