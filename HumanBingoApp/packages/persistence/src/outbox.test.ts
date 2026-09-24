import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlResult } from './transaction.js';
import { SqlEventConsumerReceiptRepository, SqlOutboxRepository } from './outbox.js';

class QueueClient implements SqlClient {
  readonly calls: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  private responseIndex = 0;

  public constructor(private readonly responses: readonly unknown[] = []) {}

  public query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    if (/^(BEGIN|SET TRANSACTION|COMMIT|ROLLBACK)/.test(text)) return Promise.resolve({ rows: [] });
    const response = this.responses[this.responseIndex] as SqlResult<Row> | undefined;
    this.responseIndex += 1;
    return Promise.resolve(response ?? { rows: [] });
  }
}

const row = {
  id: 'event-1',
  game_id: 'game-1',
  state_version: '4',
  event_type: 'game.patch',
  payload: { changes: { squares: [] } },
  created_at: '2025-01-01T00:00:00.000Z',
  published_at: null,
  attempt_count: 0,
  next_attempt_at: null,
  last_error: null,
};

describe('SqlOutboxRepository', () => {
  it('claims pending events in game/version order with a lease and increments attempts', async () => {
    const client = new QueueClient([{ rows: [row] }]);
    const now = new Date('2025-01-01T00:00:00.000Z');
    const events = await new SqlOutboxRepository(client).claimPending(now, 10, { leaseMs: 5_000 });

    expect(events[0]).toMatchObject({
      id: 'event-1',
      gameId: 'game-1',
      stateVersion: 4n,
      attemptCount: 1,
      nextAttemptAt: new Date('2025-01-01T00:00:05.000Z'),
    });
    expect(client.calls[2]?.text).toContain('ORDER BY game_id, state_version');
    expect(client.calls[3]?.text).toContain('attempt_count = attempt_count + 1');
    expect(client.calls.at(-1)?.text).toBe('COMMIT');
  });

  it('marks published rows terminal and failed rows retryable without changing event identity', async () => {
    const client = new QueueClient();
    const repository = new SqlOutboxRepository(client);
    await repository.markPublished('event-1', new Date('2025-01-01T00:00:00.000Z'));
    await repository.markFailed(
      'event-1',
      new Date('2025-01-01T00:00:00.000Z'),
      'broker unavailable',
    );

    expect(client.calls[0]?.text).toContain('published_at = $2');
    expect(client.calls[1]?.text).toContain('next_attempt_at = $2');
    expect(client.calls[1]?.values?.[2]).toBe('broker unavailable');
  });
});

describe('SqlEventConsumerReceiptRepository', () => {
  it('provides durable claim, completion, and release operations', async () => {
    const client = new QueueClient([{ rows: [{ processed_at: null }] }, { rows: [], rowCount: 1 }]);
    const repository = new SqlEventConsumerReceiptRepository(client, 'push-worker');

    expect(await repository.hasProcessed('event-1')).toBe(false);
    expect(await repository.tryClaim('event-1')).toBe(true);
    await repository.markProcessed('event-1');
    await repository.releaseClaim('event-1');

    expect(client.calls.map((call) => call.text)).toEqual([
      expect.stringContaining('SELECT processed_at'),
      expect.stringContaining('INSERT INTO event_consumer_receipts'),
      expect.stringContaining('UPDATE event_consumer_receipts'),
      expect.stringContaining('DELETE FROM event_consumer_receipts'),
    ]);
  });
});
