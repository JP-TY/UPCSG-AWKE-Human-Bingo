import { randomUUID } from 'node:crypto';

import { GameStatus } from '@human-bingo/domain';
import type { GameId, GameRecord, TaskEntryId, TaskEntryRecord } from './models.js';

export interface CreateGameRecordInput {
  readonly id?: GameId;
  readonly hostAccountId: string;
  readonly name: string;
  readonly now?: Date;
}

/**
 * A transaction-scoped copy of the game configuration. Implementations must
 * commit changes only when the callback resolves, and discard them on error.
 */
export interface GameConfigurationState {
  game: GameRecord;
  tasks: TaskEntryRecord[];
}

export interface GameConfigurationRepository {
  createGame(input: CreateGameRecordInput): Promise<GameRecord>;
  read?(gameId: GameId): Promise<GameConfigurationState>;
  withGameConfiguration<Result>(
    gameId: GameId,
    mutation: (state: GameConfigurationState) => Promise<Result> | Result,
  ): Promise<Result>;
}

export class GameConfigurationNotFoundError extends Error {
  public constructor(gameId: GameId) {
    super(`Game configuration ${gameId} was not found`);
    this.name = 'GameConfigurationNotFoundError';
  }
}

export interface InMemoryGameConfigurationRepositoryOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/**
 * Transactional repository used by the application tests and local runtime.
 * The same callback contract is suitable for a PostgreSQL implementation that
 * locks the game row and commits the callback's staged state in one transaction.
 */
export class InMemoryGameConfigurationRepository implements GameConfigurationRepository {
  private readonly games = new Map<GameId, GameConfigurationState>();
  private readonly locks = new Map<GameId, Promise<void>>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(options: InMemoryGameConfigurationRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public createGame(input: CreateGameRecordInput): Promise<GameRecord> {
    const now = new Date(input.now ?? this.now());
    const gameId = input.id ?? (this.idFactory() as GameId);
    const record: GameRecord = {
      id: gameId,
      hostAccountId: input.hostAccountId,
      name: input.name,
      status: GameStatus.Draft,
      taskBagLockedAt: null,
      closedAt: null,
      stateVersion: 0n,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    if (this.games.has(gameId)) {
      throw new Error(`Game ${gameId} already exists`);
    }
    this.games.set(gameId, { game: cloneGame(record), tasks: [] });
    return Promise.resolve<GameRecord>(cloneGame(record));
  }

  public read(gameId: GameId): Promise<GameConfigurationState> {
    const state = this.games.get(gameId);
    if (state === undefined) throw new GameConfigurationNotFoundError(gameId);
    return Promise.resolve({
      game: cloneGame(state.game),
      tasks: state.tasks.map(cloneTask),
    });
  }

  public async withGameConfiguration<Result>(
    gameId: GameId,
    mutation: (state: GameConfigurationState) => Promise<Result> | Result,
  ): Promise<Result> {
    const previous = this.locks.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(gameId, current);
    await previous;

    try {
      const stored = this.games.get(gameId);
      if (stored === undefined) {
        throw new GameConfigurationNotFoundError(gameId);
      }

      const staged: GameConfigurationState = {
        game: cloneGame(stored.game),
        tasks: stored.tasks.map(cloneTask),
      };
      const result = await mutation(staged);
      this.games.set(gameId, {
        game: cloneGame(staged.game),
        tasks: staged.tasks.map(cloneTask),
      });
      return result;
    } finally {
      release();
      if (this.locks.get(gameId) === current) {
        this.locks.delete(gameId);
      }
    }
  }
}

const cloneGame = (game: GameRecord): GameRecord => ({
  ...game,
  taskBagLockedAt: game.taskBagLockedAt === null ? null : new Date(game.taskBagLockedAt),
  closedAt: game.closedAt === null ? null : new Date(game.closedAt),
  createdAt: new Date(game.createdAt),
  updatedAt: new Date(game.updatedAt),
});

const cloneTask = (task: TaskEntryRecord): TaskEntryRecord => ({
  ...task,
  createdAt: new Date(task.createdAt),
  updatedAt: new Date(task.updatedAt),
  removedAt: task.removedAt === null ? null : new Date(task.removedAt),
});

export const createTaskEntryRecord = (input: {
  readonly id?: TaskEntryId;
  readonly gameId: GameId;
  readonly displayText: string;
  readonly normalizedText: string;
  readonly now?: Date;
  readonly idFactory?: () => string;
}): TaskEntryRecord => {
  const now = new Date(input.now ?? new Date());
  return {
    id: input.id ?? ((input.idFactory ?? randomUUID)() as TaskEntryId),
    gameId: input.gameId,
    displayText: input.displayText,
    normalizedText: input.normalizedText,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    removedAt: null,
  };
};
