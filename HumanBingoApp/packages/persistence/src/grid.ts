import type {
  GameId,
  GameRecord,
  GridRecord,
  GridId,
  ParticipantId,
  SquareRecord,
  TaskEntryRecord,
} from './models.js';
import { withTransaction, type SqlClient } from './transaction.js';

export interface GridState {
  game: GameRecord;
  tasks: TaskEntryRecord[];
  grids: GridRecord[];
  squares: SquareRecord[];
}

export interface GridCreationRepository {
  withGridState<Result>(
    gameId: GameId,
    participantId: ParticipantId,
    mutation: (state: GridState) => Promise<Result> | Result,
  ): Promise<Result>;
}

export interface InMemoryGridRepositoryOptions {
  readonly states?: readonly GridState[];
}

export class GridGameNotFoundError extends Error {
  public constructor(gameId: GameId) {
    super(`Grid game ${gameId} was not found`);
    this.name = 'GridGameNotFoundError';
  }
}

/**
 * Transactional repository for grid generation tests and the local runtime.
 * A game-scoped FIFO lock makes concurrent participant joins serialize while a
 * staged copy ensures a failed square insert never leaves a partial grid.
 */
export class InMemoryGridRepository implements GridCreationRepository {
  private readonly games = new Map<GameId, GridState>();
  private readonly locks = new Map<GameId, Promise<void>>();

  public constructor(options: InMemoryGridRepositoryOptions = {}) {
    for (const state of options.states ?? []) this.games.set(state.game.id, cloneState(state));
  }

  public seed(state: GridState): void {
    if (this.games.has(state.game.id)) throw new Error(`Game ${state.game.id} already exists`);
    this.games.set(state.game.id, cloneState(state));
  }

  public read(gameId: GameId): Promise<GridState> {
    const state = this.games.get(gameId);
    if (state === undefined) throw new GridGameNotFoundError(gameId);
    return Promise.resolve(cloneState(state));
  }

  public async withGridState<Result>(
    gameId: GameId,
    _participantId: ParticipantId,
    mutation: (state: GridState) => Promise<Result> | Result,
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
      if (stored === undefined) throw new GridGameNotFoundError(gameId);
      const staged = cloneState(stored);
      const result = await mutation(staged);
      this.games.set(gameId, cloneState(staged));
      return result;
    } finally {
      release();
      if (this.locks.get(gameId) === current) this.locks.delete(gameId);
    }
  }
}

interface GameRow {
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

interface TaskRow {
  readonly id: string;
  readonly game_id: string;
  readonly display_text: string;
  readonly normalized_text: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly removed_at: Date | string | null;
}

interface GridRow {
  readonly id: string;
  readonly game_id: string;
  readonly participant_id: string;
  readonly task_bag_version: string | number | bigint;
  readonly state_version: string | number | bigint;
  readonly created_at: Date | string;
}

interface SquareRow {
  readonly grid_id: string;
  readonly game_id: string;
  readonly square_index: number;
  readonly task_entry_id: string;
  readonly status: SquareRecord['status'];
  readonly stamp_index: number | null;
  readonly updated_at: Date | string;
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value) : new Date(value);
const asNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);
const asBigInt = (value: string | number | bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(value);

const toGame = (row: GameRow): GameRecord => ({
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

const toTask = (row: TaskRow): TaskEntryRecord => ({
  id: row.id as TaskEntryRecord['id'],
  gameId: row.game_id as GameId,
  displayText: row.display_text,
  normalizedText: row.normalized_text,
  createdAt: asDate(row.created_at),
  updatedAt: asDate(row.updated_at),
  removedAt: asNullableDate(row.removed_at),
});

const toGrid = (row: GridRow): GridRecord => ({
  id: row.id as GridId,
  gameId: row.game_id as GameId,
  participantId: row.participant_id as ParticipantId,
  taskBagVersion: asBigInt(row.task_bag_version),
  stateVersion: asBigInt(row.state_version),
  createdAt: asDate(row.created_at),
});

const toSquare = (row: SquareRow): SquareRecord => ({
  gridId: row.grid_id as GridId,
  gameId: row.game_id as GameId,
  squareIndex: row.square_index,
  taskEntryId: row.task_entry_id as SquareRecord['taskEntryId'],
  status: row.status,
  ...(row.stamp_index === null ? {} : { stampIndex: row.stamp_index }),
  updatedAt: asDate(row.updated_at),
});

/**
 * PostgreSQL adapter for the grid transaction boundary. GridService performs
 * generation in the callback; this adapter writes the resulting grid and all
 * squares only after the callback succeeds, inside one serializable transaction.
 */
export class SqlGridRepository implements GridCreationRepository {
  public constructor(private readonly client: SqlClient) {}

  public async withGridState<Result>(
    gameId: GameId,
    participantId: ParticipantId,
    mutation: (state: GridState) => Promise<Result> | Result,
  ): Promise<Result> {
    return withTransaction(this.client, async (transaction) => {
      const gameResult = await transaction.query<GameRow>(
        `SELECT id, host_account_id, name, status, task_bag_locked_at, closed_at,
                state_version, created_at, updated_at
           FROM games
          WHERE id = $1
          FOR UPDATE`,
        [gameId],
      );
      const gameRow = gameResult.rows[0];
      if (gameRow === undefined) throw new GridGameNotFoundError(gameId);

      const taskResult = await transaction.query<TaskRow>(
        `SELECT id, game_id, display_text, normalized_text, created_at, updated_at, removed_at
           FROM task_entries
          WHERE game_id = $1 AND removed_at IS NULL
          ORDER BY created_at, id`,
        [gameId],
      );
      const gridResult = await transaction.query<GridRow>(
        `SELECT id, game_id, participant_id, task_bag_version, state_version, created_at
           FROM grids
          WHERE game_id = $1 AND participant_id = $2
          FOR UPDATE`,
        [gameId, participantId],
      );
      const gridRow = gridResult.rows[0];
      const squares =
        gridRow === undefined
          ? []
          : (
              await transaction.query<SquareRow>(
                `SELECT grid_id, game_id, square_index, task_entry_id, status, stamp_index, updated_at
             FROM squares
            WHERE grid_id = $1
            ORDER BY square_index`,
                [gridRow.id],
              )
            ).rows.map(toSquare);
      const state: GridState = {
        game: toGame(gameRow),
        tasks: taskResult.rows.map(toTask),
        grids: gridRow === undefined ? [] : [toGrid(gridRow)],
        squares,
      };
      const result = await mutation(state);
      const nextGrid = state.grids.find(
        (candidate) => candidate.participantId === participantId && candidate.gameId === gameId,
      );
      if (gridRow === undefined && nextGrid !== undefined) {
        await transaction.query(
          `INSERT INTO grids
             (id, game_id, participant_id, task_bag_version, state_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            nextGrid.id,
            nextGrid.gameId,
            nextGrid.participantId,
            nextGrid.taskBagVersion,
            nextGrid.stateVersion,
            nextGrid.createdAt,
          ],
        );
        const nextSquares = state.squares.filter((square) => square.gridId === nextGrid.id);
        if (nextSquares.length !== 25) throw new Error('A grid must persist exactly 25 squares');
        for (const square of nextSquares) {
          await transaction.query(
            `INSERT INTO squares
               (grid_id, game_id, square_index, task_entry_id, status, stamp_index, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              square.gridId,
              square.gameId,
              square.squareIndex,
              square.taskEntryId,
              square.status,
              square.stampIndex ?? null,
              square.updatedAt,
            ],
          );
        }
      }
      return result;
    });
  }
}

const cloneState = (state: GridState): GridState => ({
  game: cloneGame(state.game),
  tasks: state.tasks.map(cloneTask),
  grids: state.grids.map(cloneGrid),
  squares: state.squares.map(cloneSquare),
});

const cloneGame = (record: GameRecord): GameRecord => ({
  ...record,
  taskBagLockedAt: record.taskBagLockedAt === null ? null : new Date(record.taskBagLockedAt),
  closedAt: record.closedAt === null ? null : new Date(record.closedAt),
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

const cloneTask = (record: TaskEntryRecord): TaskEntryRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  removedAt: record.removedAt === null ? null : new Date(record.removedAt),
});

const cloneGrid = (record: GridRecord): GridRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
});

const cloneSquare = (record: SquareRecord): SquareRecord => ({
  ...record,
  updatedAt: new Date(record.updatedAt),
});
