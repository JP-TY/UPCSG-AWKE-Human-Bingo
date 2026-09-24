import { describe, expect, it } from 'vitest';
import {
  DomainErrorCode,
  GameStatus,
  type HumanBingoError,
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
import { GridService } from './grid.js';

const gameId = 'game-grid' as GameId;
const participantId = 'participant-one' as ParticipantId;
const correlationId = 'correlation-grid' as CorrelationId;
const now = new Date('2025-01-01T00:00:00.000Z');

function makeState(taskCount: number): GridState {
  const game: GameRecord = {
    id: gameId,
    hostAccountId: 'host-one',
    name: 'Grid game',
    status: GameStatus.Active,
    taskBagLockedAt: new Date('2025-01-01T00:00:00.000Z'),
    closedAt: null,
    stateVersion: 7n,
    createdAt: now,
    updatedAt: now,
  };
  const tasks: TaskEntryRecord[] = Array.from({ length: taskCount }, (_, index) => ({
    id: `task-${index + 1}` as TaskEntryId,
    gameId,
    displayText: `Task ${index + 1}`,
    normalizedText: `task ${index + 1}`,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
  }));
  return { game, tasks, grids: [], squares: [] };
}

const zeroRandom = (): Uint8Array => new Uint8Array([0, 0, 0, 0]);

const command = { gameId, participantId, correlationId };

describe('GridService', () => {
  it('samples 25 distinct locked tasks and persists unverified positions atomically', async () => {
    const repository = new InMemoryGridRepository({ states: [makeState(30)] });
    const service = new GridService(repository, {
      now: () => now,
      idFactory: () => 'grid-one',
      randomBytes: zeroRandom,
    });

    const result = await service.generateOrResume(command);
    const stored = await repository.read(gameId);

    expect(result.resumed).toBe(false);
    expect(result.squares).toHaveLength(25);
    expect(result.squares.map((square) => square.squareIndex)).toEqual(
      Array.from({ length: 25 }, (_, index) => index),
    );
    expect(new Set(result.squares.map((square) => square.taskEntryId)).size).toBe(25);
    expect(result.squares.every((square) => square.status === SquareStatus.Unverified)).toBe(true);
    expect(result.squares.every((square) => square.gameId === gameId)).toBe(true);
    expect(stored.grids).toHaveLength(1);
    expect(stored.squares).toHaveLength(25);
    expect(result.squares.map((square) => square.taskEntryId)).not.toEqual(
      stored.tasks.slice(0, 25).map((task) => task.id),
    );
  });

  it('creates independently generated grids for separate participants from the same locked bag', async () => {
    const secondParticipant = 'participant-two' as ParticipantId;
    const repository = new InMemoryGridRepository({ states: [makeState(30)] });
    let randomValue = 1;
    const service = new GridService(repository, {
      idFactory: (() => {
        let gridNumber = 0;
        return () => `grid-${++gridNumber}`;
      })(),
      randomBytes: () => {
        const value = randomValue++;
        return new Uint8Array([0, 0, 0, value]);
      },
    });

    const first = await service.generateOrResume(command);
    const second = await service.generateOrResume({ ...command, participantId: secondParticipant });
    const stored = await repository.read(gameId);

    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(false);
    expect(stored.grids).toHaveLength(2);
    expect(stored.squares).toHaveLength(50);
    expect(new Set(first.squares.map((square) => square.taskEntryId)).size).toBe(25);
    expect(new Set(second.squares.map((square) => square.taskEntryId)).size).toBe(25);
  });

  it('returns the persisted arrangement and statuses on resume without consuming randomness', async () => {
    const repository = new InMemoryGridRepository({ states: [makeState(25)] });
    let randomCalls = 0;
    const service = new GridService(repository, {
      randomBytes: () => {
        randomCalls += 1;
        return zeroRandom();
      },
    });

    const first = await service.generateOrResume(command);
    const stored = await repository.read(gameId);
    const persistedSquare = stored.squares[0];
    if (persistedSquare === undefined) throw new Error('Expected a persisted square');
    stored.squares[0] = { ...persistedSquare, status: SquareStatus.Verified };
    const resumeRepository = new InMemoryGridRepository({ states: [stored] });
    const resumed = await new GridService(resumeRepository, {
      randomBytes: () => {
        throw new Error('Randomness must not be consumed when resuming');
      },
    }).generateOrResume(command);

    expect(randomCalls).toBeGreaterThan(0);
    expect(resumed.resumed).toBe(true);
    expect(resumed.grid.id).toBe(first.grid.id);
    expect(resumed.squares.map((square) => square.taskEntryId)).toEqual(
      first.squares.map((square) => square.taskEntryId),
    );
    expect(resumed.squares[0]?.status).toBe(SquareStatus.Verified);
  });

  it('rejects an insufficient locked bag without persisting a partial grid', async () => {
    const repository = new InMemoryGridRepository({ states: [makeState(24)] });
    const service = new GridService(repository);

    await expect(service.generateOrResume(command)).rejects.toMatchObject({
      code: DomainErrorCode.InsufficientTasks,
    } satisfies Partial<HumanBingoError>);
    const stored = await repository.read(gameId);
    expect(stored.grids).toHaveLength(0);
    expect(stored.squares).toHaveLength(0);
  });
});
