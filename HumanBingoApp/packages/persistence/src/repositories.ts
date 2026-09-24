import { assertSafeOutboxPayload, DomainErrorCode, HumanBingoError } from '@human-bingo/domain';
import type {
  CorrelationId,
  GameId,
  IdempotencyKey,
  OutboxEventId,
  StateVersion,
} from '@human-bingo/domain';
import type {
  GameRecord,
  GameStatus,
  OutboxEventRecord,
  TaskEntryId,
  TaskEntryRecord,
} from './models.js';
import {
  StaleStateConflictError,
  withTransaction,
  type SqlClient,
  type SqlTransaction,
  type TransactionOptions,
} from './transaction.js';

interface GameRow {
  readonly id: string;
  readonly host_account_id: string;
  readonly name: string;
  readonly status: GameStatus;
  readonly task_bag_locked_at: Date | string | null;
  readonly closed_at: Date | string | null;
  readonly state_version: string | number | bigint;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface TaskEntryRow {
  readonly id: string;
  readonly game_id: string;
  readonly display_text: string;
  readonly normalized_text: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly removed_at: Date | string | null;
}

interface OutboxRow {
  readonly id: string;
  readonly game_id: string;
  readonly state_version: string | number | bigint;
  readonly event_type: string;
  readonly payload: Record<string, unknown> | string;
  readonly created_at: Date | string;
  readonly published_at: Date | string | null;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | string | null;
  readonly last_error: string | null;
}

interface IdempotencyRow {
  readonly scope_key: string;
  readonly game_id: string | null;
  readonly idempotency_key: string;
  readonly command_type: string;
  readonly state_version: string | number | bigint | null;
  readonly result_json: unknown;
  readonly created_at: Date | string;
}

export interface IdempotencyRecord {
  readonly scopeKey: string;
  readonly gameId: GameId | null;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandType: string;
  readonly stateVersion: bigint | null;
  readonly result: unknown;
  readonly createdAt: Date;
}

export interface GameMutationOutput<Value> {
  readonly value: Value;
  readonly stateVersion: StateVersion;
  readonly event: OutboxEventRecord;
  readonly replayed: boolean;
}

export interface GameMutationInput<Value> {
  readonly gameId: GameId;
  readonly idempotencyKey: IdempotencyKey;
  readonly commandType: string;
  readonly knownStateVersion: StateVersion;
  readonly correlationId: CorrelationId;
  readonly eventType: string;
  readonly eventPayload: Record<string, unknown>;
  readonly mutate: (
    transaction: SqlTransaction,
    game: GameRecord,
  ) => Promise<{ readonly value: Value }>;
  readonly loadCurrentSnapshot?: (
    transaction: SqlTransaction,
    game: GameRecord,
  ) => Promise<unknown>;
  readonly transaction?: TransactionOptions;
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function nullableDateValue(value: Date | string | null): Date | null {
  return value === null ? null : dateValue(value);
}

function bigintValue(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function stateVersion(value: string | number | bigint): StateVersion {
  return Number(bigintValue(value)) as StateVersion;
}

function parseResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value, (_key: string, nested: unknown) => {
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      const candidate = nested as { readonly __humanBingoBigInt?: unknown };
      if (typeof candidate.__humanBingoBigInt === 'string') {
        return BigInt(candidate.__humanBingoBigInt);
      }
    }
    return nested;
  }) as unknown;
}

function serializeResult(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === 'bigint' ? { __humanBingoBigInt: nested.toString() } : nested,
  );
}

function gameIdValue(value: string): GameId {
  return value as GameId;
}

function taskEntryIdValue(value: string): TaskEntryId {
  return value as TaskEntryId;
}

function idempotencyKeyValue(value: string): IdempotencyKey {
  return value as IdempotencyKey;
}

function gameRecord(row: GameRow): GameRecord {
  return {
    id: gameIdValue(row.id),
    hostAccountId: row.host_account_id,
    name: row.name,
    status: row.status,
    taskBagLockedAt: nullableDateValue(row.task_bag_locked_at),
    closedAt: nullableDateValue(row.closed_at),
    stateVersion: bigintValue(row.state_version),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function taskEntryRecord(row: TaskEntryRow): TaskEntryRecord {
  return {
    id: taskEntryIdValue(row.id),
    gameId: gameIdValue(row.game_id),
    displayText: row.display_text,
    normalizedText: row.normalized_text,
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    removedAt: nullableDateValue(row.removed_at),
  };
}

function outboxRecord(row: OutboxRow): OutboxEventRecord {
  const payload = parseResult(row.payload);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('The outbox payload must be a JSON object');
  }
  return {
    id: row.id as OutboxEventId,
    gameId: gameIdValue(row.game_id),
    stateVersion: bigintValue(row.state_version),
    eventType: row.event_type,
    payload: payload as Record<string, unknown>,
    createdAt: dateValue(row.created_at),
    publishedAt: nullableDateValue(row.published_at),
    attemptCount: row.attempt_count,
    nextAttemptAt: nullableDateValue(row.next_attempt_at),
    lastError: row.last_error,
  };
}

function idempotencyRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    scopeKey: row.scope_key,
    gameId: row.game_id === null ? null : gameIdValue(row.game_id),
    idempotencyKey: idempotencyKeyValue(row.idempotency_key),
    commandType: row.command_type,
    stateVersion: row.state_version === null ? null : bigintValue(row.state_version),
    result: parseResult(row.result_json),
    createdAt: dateValue(row.created_at),
  };
}

export class GameRepository {
  public async findById(client: SqlClient, gameId: GameId): Promise<GameRecord | null> {
    const result = await client.query<GameRow>(
      `SELECT id, host_account_id, name, status, task_bag_locked_at, closed_at,
              state_version, created_at, updated_at
         FROM games
        WHERE id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    return row === undefined ? null : gameRecord(row);
  }

  public async lockById(transaction: SqlTransaction, gameId: GameId): Promise<GameRecord> {
    const result = await transaction.query<GameRow>(
      `SELECT id, host_account_id, name, status, task_bag_locked_at, closed_at,
              state_version, created_at, updated_at
         FROM games
        WHERE id = $1
        FOR UPDATE`,
      [gameId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Game ${gameId} was not found`);
    }
    return gameRecord(row);
  }

  public async create(
    transaction: SqlTransaction,
    input: {
      readonly hostAccountId: string;
      readonly name: string;
      readonly stateVersion?: bigint;
    },
  ): Promise<GameRecord> {
    const result = await transaction.query<GameRow>(
      `INSERT INTO games (host_account_id, name, state_version)
       VALUES ($1, $2, $3)
       RETURNING id, host_account_id, name, status, task_bag_locked_at, closed_at,
                 state_version, created_at, updated_at`,
      [input.hostAccountId, input.name, input.stateVersion ?? 1n],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The database did not return the created game');
    return gameRecord(row);
  }

  public async incrementStateVersion(transaction: SqlTransaction, gameId: GameId): Promise<bigint> {
    const result = await transaction.query<{ state_version: string | number | bigint }>(
      `UPDATE games
          SET state_version = state_version + 1, updated_at = now()
        WHERE id = $1
        RETURNING state_version`,
      [gameId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Game ${gameId} disappeared while mutating`);
    return bigintValue(row.state_version);
  }
}

export class TaskEntryRepository {
  public async listActive(client: SqlClient, gameId: GameId): Promise<readonly TaskEntryRecord[]> {
    const result = await client.query<TaskEntryRow>(
      `SELECT id, game_id, display_text, normalized_text, created_at, updated_at, removed_at
         FROM task_entries
        WHERE game_id = $1 AND removed_at IS NULL
        ORDER BY created_at, id`,
      [gameId],
    );
    return result.rows.map(taskEntryRecord);
  }

  public async lockById(
    transaction: SqlTransaction,
    gameId: GameId,
    taskEntryId: TaskEntryId,
  ): Promise<TaskEntryRecord | null> {
    const result = await transaction.query<TaskEntryRow>(
      `SELECT id, game_id, display_text, normalized_text, created_at, updated_at, removed_at
         FROM task_entries
        WHERE game_id = $1 AND id = $2
        FOR UPDATE`,
      [gameId, taskEntryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : taskEntryRecord(row);
  }

  public async insert(
    transaction: SqlTransaction,
    input: {
      readonly gameId: GameId;
      readonly displayText: string;
      readonly normalizedText: string;
    },
  ): Promise<TaskEntryRecord> {
    const result = await transaction.query<TaskEntryRow>(
      `INSERT INTO task_entries (game_id, display_text, normalized_text)
       VALUES ($1, $2, $3)
       RETURNING id, game_id, display_text, normalized_text, created_at, updated_at, removed_at`,
      [input.gameId, input.displayText, input.normalizedText],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The database did not return the created task');
    return taskEntryRecord(row);
  }

  public async markRemoved(
    transaction: SqlTransaction,
    gameId: GameId,
    taskEntryId: TaskEntryId,
  ): Promise<void> {
    await transaction.query(
      `UPDATE task_entries
          SET removed_at = now(), updated_at = now()
        WHERE game_id = $1 AND id = $2 AND removed_at IS NULL`,
      [gameId, taskEntryId],
    );
  }
}

export class IdempotencyRepository {
  /**
   * Serializes commands whose target row does not exist yet (for example,
   * idempotent game creation). A normal row lock cannot protect a missing
   * idempotency record, so the lock lives for the duration of this transaction.
   * Hash collisions only serialize unrelated scopes; they cannot change the
   * command scope because the primary-key lookup still provides identity.
   */
  public async lockScope(transaction: SqlTransaction, scopeKey: string): Promise<void> {
    await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scopeKey]);
  }

  public async findForUpdate(
    transaction: SqlTransaction,
    scopeKey: string,
  ): Promise<IdempotencyRecord | null> {
    const result = await transaction.query<IdempotencyRow>(
      `SELECT scope_key, game_id, idempotency_key, command_type, state_version,
              result_json, created_at
         FROM command_idempotency
        WHERE scope_key = $1
        FOR UPDATE`,
      [scopeKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : idempotencyRecord(row);
  }

  public async insert(
    transaction: SqlTransaction,
    input: {
      readonly scopeKey: string;
      readonly gameId: GameId | null;
      readonly idempotencyKey: IdempotencyKey;
      readonly commandType: string;
      readonly stateVersion: bigint | null;
      readonly result: unknown;
    },
  ): Promise<IdempotencyRecord> {
    const result = await transaction.query<IdempotencyRow>(
      `INSERT INTO command_idempotency
         (scope_key, game_id, idempotency_key, command_type, state_version, result_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING scope_key, game_id, idempotency_key, command_type, state_version,
                 result_json, created_at`,
      [
        input.scopeKey,
        input.gameId,
        input.idempotencyKey,
        input.commandType,
        input.stateVersion,
        serializeResult(input.result),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The database did not return the idempotency record');
    return idempotencyRecord(row);
  }
}

export class OutboxEventRepository {
  public async append(
    transaction: SqlTransaction,
    input: {
      readonly gameId: GameId;
      readonly stateVersion: bigint;
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
    },
  ): Promise<OutboxEventRecord> {
    assertSafeOutboxPayload(input.gameId, input.payload);
    const result = await transaction.query<OutboxRow>(
      `INSERT INTO outbox_events (game_id, state_version, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, game_id, state_version, event_type, payload, created_at,
                 published_at, attempt_count, next_attempt_at, last_error`,
      [input.gameId, input.stateVersion, input.eventType, serializeResult(input.payload)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The database did not return the outbox event');
    return outboxRecord(row);
  }
}

export class GameMutationRepository {
  public constructor(
    private readonly games = new GameRepository(),
    private readonly idempotency = new IdempotencyRepository(),
    private readonly outbox = new OutboxEventRepository(),
  ) {}

  public async execute<Value>(
    client: SqlClient,
    input: GameMutationInput<Value>,
  ): Promise<GameMutationOutput<Value>> {
    const scopeKey = `game:${input.gameId}:${input.idempotencyKey}`;
    return withTransaction(
      client,
      async (transaction) => {
        const game = await this.games.lockById(transaction, input.gameId);
        const existing = await this.idempotency.findForUpdate(transaction, scopeKey);
        if (existing !== null) {
          if (existing.commandType !== input.commandType) {
            throw new HumanBingoError({
              code: DomainErrorCode.InvalidCommand,
              message: 'The idempotency key was already used for another command',
              correlationId: input.correlationId,
              retryable: false,
              httpStatus: 409,
            });
          }
          const existingVersion = existing.stateVersion;
          if (existingVersion === null) {
            throw new Error('The idempotency record is missing its committed state version');
          }
          const event = await this.findOutboxEvent(transaction, input.gameId, existingVersion);
          if (event === null) {
            throw new Error('The idempotency record is missing its committed outbox event');
          }
          return {
            value: existing.result as Value,
            stateVersion: stateVersion(existingVersion),
            event,
            replayed: true,
          };
        }

        if (game.stateVersion !== BigInt(input.knownStateVersion)) {
          const currentSnapshot =
            input.loadCurrentSnapshot === undefined
              ? undefined
              : await input.loadCurrentSnapshot(transaction, game);
          throw new StaleStateConflictError({
            currentStateVersion: game.stateVersion,
            ...(currentSnapshot === undefined ? {} : { currentSnapshot }),
            correlationId: input.correlationId,
          });
        }

        const mutation = await input.mutate(transaction, game);
        const nextVersion = await this.games.incrementStateVersion(transaction, input.gameId);
        const event = await this.outbox.append(transaction, {
          gameId: input.gameId,
          stateVersion: nextVersion,
          eventType: input.eventType,
          payload: input.eventPayload,
        });
        await this.idempotency.insert(transaction, {
          scopeKey,
          gameId: input.gameId,
          idempotencyKey: input.idempotencyKey,
          commandType: input.commandType,
          stateVersion: nextVersion,
          result: mutation.value,
        });
        return {
          value: mutation.value,
          stateVersion: stateVersion(nextVersion),
          event,
          replayed: false,
        };
      },
      input.transaction,
    );
  }

  private async findOutboxEvent(
    transaction: SqlTransaction,
    gameId: GameId,
    version: bigint,
  ): Promise<OutboxEventRecord | null> {
    const result = await transaction.query<OutboxRow>(
      `SELECT id, game_id, state_version, event_type, payload, created_at,
              published_at, attempt_count, next_attempt_at, last_error
         FROM outbox_events
        WHERE game_id = $1 AND state_version = $2`,
      [gameId, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : outboxRecord(row);
  }
}

/** Executes an idempotent create command whose game id does not exist yet. */
export class GameCreationRepository {
  public constructor(
    private readonly games = new GameRepository(),
    private readonly idempotency = new IdempotencyRepository(),
    private readonly outbox = new OutboxEventRepository(),
  ) {}

  public async create(
    client: SqlClient,
    input: {
      readonly hostAccountId: string;
      readonly name: string;
      readonly idempotencyKey: IdempotencyKey;
      readonly correlationId: CorrelationId;
      readonly eventPayload: Record<string, unknown>;
      readonly transaction?: TransactionOptions;
    },
  ): Promise<GameMutationOutput<GameRecord>> {
    const scopeKey = `create:${input.idempotencyKey}`;
    return withTransaction(
      client,
      async (transaction) => {
        await this.idempotency.lockScope(transaction, scopeKey);
        const existing = await this.idempotency.findForUpdate(transaction, scopeKey);
        if (existing !== null) {
          if (
            existing.commandType !== 'create_game' ||
            existing.stateVersion === null ||
            existing.gameId === null
          ) {
            throw new HumanBingoError({
              code: DomainErrorCode.InvalidCommand,
              message: 'The idempotency key was already used for another command',
              correlationId: input.correlationId,
              retryable: false,
              httpStatus: 409,
            });
          }
          const event = await this.findOutboxEvent(
            transaction,
            existing.gameId,
            existing.stateVersion,
          );
          if (event === null)
            throw new Error('The idempotency record is missing its committed outbox event');
          return {
            value: existing.result as GameRecord,
            stateVersion: stateVersion(existing.stateVersion),
            event,
            replayed: true,
          };
        }

        const game = await this.games.create(transaction, {
          hostAccountId: input.hostAccountId,
          name: input.name,
          stateVersion: 1n,
        });
        const event = await this.outbox.append(transaction, {
          gameId: game.id,
          stateVersion: game.stateVersion,
          eventType: 'game.created',
          payload: input.eventPayload,
        });
        await this.idempotency.insert(transaction, {
          scopeKey,
          gameId: game.id,
          idempotencyKey: input.idempotencyKey,
          commandType: 'create_game',
          stateVersion: game.stateVersion,
          result: game,
        });
        return {
          value: game,
          stateVersion: stateVersion(game.stateVersion),
          event,
          replayed: false,
        };
      },
      input.transaction,
    );
  }

  private async findOutboxEvent(
    transaction: SqlTransaction,
    gameId: GameId,
    version: bigint,
  ): Promise<OutboxEventRecord | null> {
    const result = await transaction.query<OutboxRow>(
      `SELECT id, game_id, state_version, event_type, payload, created_at,
              published_at, attempt_count, next_attempt_at, last_error
         FROM outbox_events
        WHERE game_id = $1 AND state_version = $2`,
      [gameId, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : outboxRecord(row);
  }
}
