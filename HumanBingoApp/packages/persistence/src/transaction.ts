import { DomainErrorCode, HumanBingoError } from '@human-bingo/domain';
import type { CorrelationId } from '@human-bingo/domain';

/** A small adapter interface implemented by node-postgres and test clients. */
export interface SqlResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface SqlClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

export type SqlTransaction = SqlClient;
export type TransactionIsolationLevel = 'serializable' | 'repeatable read' | 'read committed';

interface SqlConnection extends SqlClient {
  release(): void;
}

interface SqlPool extends SqlClient {
  connect(): Promise<SqlConnection>;
}

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  /** Number of retries after a serialization/deadlock failure. */
  readonly maxRetries?: number;
}

export interface TransactionAttemptContext {
  readonly attempt: number;
}

export class TransactionRollbackError extends Error {
  public constructor(message = 'The database transaction was rolled back') {
    super(message);
    this.name = 'TransactionRollbackError';
  }
}

interface DatabaseErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

function isRetryableTransactionError(error: unknown): boolean {
  const databaseError = error as DatabaseErrorLike;
  return databaseError.code === '40001' || databaseError.code === '40P01';
}

async function rollbackQuietly(client: SqlClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // A failed rollback makes the connection unsafe to reuse. The original error
    // remains the useful error for the caller and the pool should discard it.
  }
}

const isSqlPool = (client: SqlClient): client is SqlPool =>
  'connect' in client &&
  typeof (client as unknown as { connect?: unknown }).connect === 'function' &&
  typeof (client as unknown as { release?: unknown }).release !== 'function';

/**
 * Runs work in a database transaction. SERIALIZABLE is the default because all
 * state-changing commands lock their game row and must be safe under retries.
 * Serialization/deadlock failures are retried only before the callback has
 * returned successfully; application errors are never swallowed or retried.
 */
export async function withTransaction<Value>(
  client: SqlClient,
  work: (transaction: SqlTransaction, context: TransactionAttemptContext) => Promise<Value>,
  options: TransactionOptions = {},
): Promise<Value> {
  const isolationLevel = options.isolationLevel ?? 'serializable';
  const maxRetries = Math.max(0, options.maxRetries ?? 2);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const connection = isSqlPool(client) ? await client.connect() : undefined;
    const transaction: SqlClient = connection ?? client;
    try {
      await transaction.query('BEGIN');
      await transaction.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel.toUpperCase()}`);
      const value = await work(transaction, { attempt });
      await transaction.query('COMMIT');
      return value;
    } catch (error: unknown) {
      await rollbackQuietly(transaction);
      if (isRetryableTransactionError(error) && attempt < maxRetries) {
        continue;
      }
      throw error;
    } finally {
      connection?.release();
    }
  }

  throw new TransactionRollbackError();
}

export const runInTransaction = withTransaction;

/**
 * A stale command carries the authoritative version and, when the caller
 * supplies a loader, the current member-scoped snapshot. The snapshot is kept
 * off the generic error DTO so repositories cannot accidentally expose it to an
 * unauthorized caller.
 */
export class StaleStateConflictError extends Error {
  public readonly code = 'STALE_STATE';
  public readonly currentStateVersion: bigint;
  public readonly currentSnapshot: unknown;
  public readonly correlationId: CorrelationId;
  public readonly retryable = true;

  public constructor(input: {
    readonly currentStateVersion: bigint;
    readonly currentSnapshot?: unknown;
    readonly correlationId: CorrelationId;
    readonly message?: string;
  }) {
    super(input.message ?? 'The command was based on stale game state');
    this.name = 'StaleStateConflictError';
    this.currentStateVersion = input.currentStateVersion;
    this.currentSnapshot = input.currentSnapshot;
    this.correlationId = input.correlationId;
  }

  public toDomainError(): HumanBingoError {
    // The optional snapshot is deliberately not serialized into the DTO, so
    // callers can refresh it only through their authorized query path.
    return new HumanBingoError({
      code: DomainErrorCode.StaleState,
      message: this.message,
      correlationId: this.correlationId,
      retryable: true,
      httpStatus: 409,
      metadata: { currentStateVersion: Number(this.currentStateVersion) },
    });
  }
}

export function isStaleStateConflict(error: unknown): error is StaleStateConflictError {
  return error instanceof StaleStateConflictError;
}
