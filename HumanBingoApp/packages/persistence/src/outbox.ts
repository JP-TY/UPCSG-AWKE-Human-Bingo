import type { OutboxEventId } from '@human-bingo/domain';
import type { OutboxEventRecord } from './models.js';
import { withTransaction, type SqlClient } from './transaction.js';

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

const dateValue = (value: Date | string): Date =>
  value instanceof Date ? new Date(value) : new Date(value);
const nullableDateValue = (value: Date | string | null): Date | null =>
  value === null ? null : dateValue(value);
const bigintValue = (value: string | number | bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(value);

function parsePayload(value: Record<string, unknown> | string): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The outbox payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function toRecord(row: OutboxRow): OutboxEventRecord {
  return {
    id: row.id as OutboxEventId,
    gameId: row.game_id as OutboxEventRecord['gameId'],
    stateVersion: bigintValue(row.state_version),
    eventType: row.event_type,
    payload: parsePayload(row.payload),
    createdAt: dateValue(row.created_at),
    publishedAt: nullableDateValue(row.published_at),
    attemptCount: row.attempt_count,
    nextAttemptAt: nullableDateValue(row.next_attempt_at),
    lastError: row.last_error,
  };
}

export interface OutboxClaimOptions {
  readonly leaseMs?: number;
}

/** SQL-backed outbox store with row leases so multiple workers do not publish a row concurrently. */
export class SqlOutboxRepository {
  public constructor(private readonly client: SqlClient) {}

  public async claimPending(
    now = new Date(),
    limit = 100,
    options: OutboxClaimOptions = {},
  ): Promise<readonly OutboxEventRecord[]> {
    if (!Number.isInteger(limit) || limit <= 0)
      throw new RangeError('Outbox batch size must be positive');
    const leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isInteger(leaseMs) || leaseMs <= 0)
      throw new RangeError('Outbox lease must be positive');
    return withTransaction(this.client, async (transaction) => {
      const result = await transaction.query<OutboxRow>(
        `SELECT id, game_id, state_version, event_type, payload, created_at,
                published_at, attempt_count, next_attempt_at, last_error
           FROM outbox_events
          WHERE published_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY game_id, state_version, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2`,
        [now, limit],
      );
      const leaseUntil = new Date(now.getTime() + leaseMs);
      for (const row of result.rows) {
        await transaction.query(
          `UPDATE outbox_events
              SET attempt_count = attempt_count + 1, next_attempt_at = $2
            WHERE id = $1`,
          [row.id, leaseUntil],
        );
      }
      return result.rows.map((row) =>
        toRecord({ ...row, attempt_count: row.attempt_count + 1, next_attempt_at: leaseUntil }),
      );
    });
  }

  public async markPublished(eventId: string, publishedAt = new Date()): Promise<void> {
    await this.client.query(
      `UPDATE outbox_events
          SET published_at = $2, next_attempt_at = NULL, last_error = NULL
        WHERE id = $1 AND published_at IS NULL`,
      [eventId, publishedAt],
    );
  }

  public async markFailed(
    eventId: string,
    failedAt = new Date(),
    error = 'Outbox delivery failed',
    retryDelayMs = 1_000,
  ): Promise<void> {
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0)
      throw new RangeError('Retry delay must be non-negative');
    await this.client.query(
      `UPDATE outbox_events
          SET next_attempt_at = $2, last_error = $3
        WHERE id = $1 AND published_at IS NULL`,
      [eventId, new Date(failedAt.getTime() + retryDelayMs), error.slice(0, 1_024)],
    );
  }

  /** Highest state version already delivered for a game; 0 when nothing was published yet. */
  public async latestPublishedVersion(gameId: string): Promise<bigint> {
    const result = await this.client.query<{ published_version: string | number | bigint | null }>(
      `SELECT MAX(state_version) AS published_version
         FROM outbox_events
        WHERE game_id = $1 AND published_at IS NOT NULL`,
      [gameId],
    );
    const value = result.rows[0]?.published_version;
    return value === null || value === undefined ? 0n : bigintValue(value);
  }
}

export interface EventConsumerReceiptStore {
  readonly consumerName: string;
  readonly hasProcessed: (eventId: string) => Promise<boolean>;
  readonly tryClaim: (eventId: string) => Promise<boolean>;
  readonly markProcessed: (eventId: string) => Promise<void>;
  readonly releaseClaim: (eventId: string) => Promise<void>;
}

/** Durable idempotency receipts for consumers shared by multiple worker instances. */
export class SqlEventConsumerReceiptRepository implements EventConsumerReceiptStore {
  public readonly consumerName: string;

  public constructor(
    private readonly client: SqlClient,
    consumerName: string,
  ) {
    if (consumerName.trim().length === 0) throw new RangeError('Consumer name is required');
    this.consumerName = consumerName;
  }

  public async hasProcessed(eventId: string): Promise<boolean> {
    const result = await this.client.query<{ processed_at: Date | string | null }>(
      `SELECT processed_at
         FROM event_consumer_receipts
        WHERE consumer_name = $1 AND event_id = $2`,
      [this.consumerName, eventId],
    );
    return result.rows[0]?.processed_at !== null && result.rows[0] !== undefined;
  }

  public async tryClaim(eventId: string): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO event_consumer_receipts (consumer_name, event_id, claimed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (consumer_name, event_id) DO NOTHING`,
      [this.consumerName, eventId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async markProcessed(eventId: string): Promise<void> {
    await this.client.query(
      `UPDATE event_consumer_receipts
          SET processed_at = now()
        WHERE consumer_name = $1 AND event_id = $2`,
      [this.consumerName, eventId],
    );
  }

  public async releaseClaim(eventId: string): Promise<void> {
    await this.client.query(
      `DELETE FROM event_consumer_receipts
        WHERE consumer_name = $1 AND event_id = $2 AND processed_at IS NULL`,
      [this.consumerName, eventId],
    );
  }
}
