import { randomUUID } from 'node:crypto';

import type { GameId, GameRecord, TaskEntryId, TaskEntryRecord } from './models.js';
import { GameConfigurationNotFoundError } from './game-configuration.js';
import type {
  CreateGameRecordInput,
  GameConfigurationRepository,
  GameConfigurationState,
} from './game-configuration.js';
import { appendGamePatchInvalidation } from './realtime-outbox.js';
import { withTransaction, type SqlClient, type SqlTransaction } from './transaction.js';

interface SqlGameRow {
  readonly id: string;
  readonly host_account_id: string;
  readonly name: string;
  readonly status: GameRecord['status'];
  readonly task_bag_locked_at: Date | string | null;
  readonly closed_at: Date | string | null;
  readonly state_version: string | number | bigint;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface SqlTaskRow {
  readonly id: string;
  readonly game_id: string;
  readonly display_text: string;
  readonly normalized_text: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly removed_at: Date | string | null;
}

const asDate = (value: Date | string): Date => new Date(value);
const asNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);
const asBigInt = (value: string | number | bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(value);

const gameFromRow = (row: SqlGameRow): GameRecord => ({
  id: row.id as GameId,
  hostAccountId: row.host_account_id,
  name: row.name,
  status: row.status,
  taskBagLockedAt: asNullableDate(row.task_bag_locked_at),
  closedAt: asNullableDate(row.closed_at),
  stateVersion: asBigInt(row.state_version),
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
});

const taskFromRow = (row: SqlTaskRow): TaskEntryRecord => ({
  id: row.id as TaskEntryId,
  gameId: row.game_id as GameId,
  displayText: row.display_text,
  normalizedText: row.normalized_text,
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
  removedAt: asNullableDate(row.removed_at),
});

async function loadState(
  transaction: SqlTransaction,
  gameId: GameId,
  lock = true,
): Promise<GameConfigurationState> {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const gameResult = await transaction.query<SqlGameRow>(
    `SELECT id, host_account_id, name, status, task_bag_locked_at, closed_at,
            state_version, created_at, updated_at
       FROM games
       WHERE id = $1${lockClause}`,
    [gameId],
  );
  const gameRow = gameResult.rows[0];
  if (gameRow === undefined) throw new GameConfigurationNotFoundError(gameId);
  const taskResult = await transaction.query<SqlTaskRow>(
    `SELECT id, game_id, display_text, normalized_text, created_at, updated_at, removed_at
       FROM task_entries
      WHERE game_id = $1
      ORDER BY created_at, id`,
    [gameId],
  );
  return {
    game: gameFromRow(gameRow),
    tasks: taskResult.rows.map(taskFromRow),
  };
}

async function persistState(
  transaction: SqlTransaction,
  state: GameConfigurationState,
): Promise<void> {
  await transaction.query(
    `UPDATE games
        SET status = $2, name = $3, task_bag_locked_at = $4, closed_at = $5,
            updated_at = $6, state_version = $7
      WHERE id = $1`,
    [
      state.game.id,
      state.game.status,
      state.game.name,
      state.game.taskBagLockedAt,
      state.game.closedAt,
      state.game.updatedAt,
      state.game.stateVersion,
    ],
  );
  for (const task of state.tasks) {
    await transaction.query(
      `INSERT INTO task_entries
         (id, game_id, display_text, normalized_text, created_at, updated_at, removed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
          SET display_text = EXCLUDED.display_text,
              normalized_text = EXCLUDED.normalized_text,
              updated_at = EXCLUDED.updated_at,
              removed_at = EXCLUDED.removed_at`,
      [
        task.id,
        task.gameId,
        task.displayText,
        task.normalizedText,
        task.createdAt,
        task.updatedAt,
        task.removedAt,
      ],
    );
  }
}

/**
 * PostgreSQL-backed game configuration store. Each state-changing command
 * locks the game row and commits the staged game/task rows together with the
 * same commit-on-success semantics as the in-memory implementation.
 */
export class SqlGameConfigurationRepository implements GameConfigurationRepository {
  public constructor(private readonly client: SqlClient) {}

  public async createGame(input: CreateGameRecordInput): Promise<GameRecord> {
    return withTransaction(this.client, async (transaction) => {
      const now = new Date(input.now ?? new Date());
      const gameId = input.id ?? (randomUUID() as GameId);
      const result = await transaction.query<SqlGameRow>(
        `INSERT INTO games (id, host_account_id, name, status, state_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, host_account_id, name, status, task_bag_locked_at, closed_at,
                   state_version, created_at, updated_at`,
        [gameId, input.hostAccountId, input.name, 'draft', 0n, now, now],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('The database did not return the created game');
      return gameFromRow(row);
    });
  }

  public read(gameId: GameId): Promise<GameConfigurationState> {
    return withTransaction(this.client, async (transaction) => loadState(transaction, gameId, false));
  }

  public withGameConfiguration<Result>(
    gameId: GameId,
    mutation: (state: GameConfigurationState) => Promise<Result> | Result,
  ): Promise<Result> {
    return withTransaction(this.client, async (transaction) => {
      const state = await loadState(transaction, gameId);
      const previousVersion = state.game.stateVersion;
      const result = await mutation(state);
      await persistState(transaction, state);
      if (state.game.stateVersion > previousVersion)
        await appendGamePatchInvalidation(transaction, gameId, state.game.stateVersion);
      return result;
    });
  }
}
