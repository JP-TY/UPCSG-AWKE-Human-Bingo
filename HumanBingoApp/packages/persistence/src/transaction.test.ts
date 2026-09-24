import { describe, expect, it } from 'vitest';
import type { SqlClient, SqlResult } from './transaction.js';
import { withTransaction } from './transaction.js';

class PinnedClient implements SqlClient {
  readonly calls: string[] = [];
  released = false;

  public query<Row = Record<string, unknown>>(
    text: string,
    _values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    void _values;
    this.calls.push(text);
    return Promise.resolve({ rows: [] });
  }

  public release(): void {
    this.released = true;
  }
}

class PoolLikeClient implements SqlClient {
  readonly poolCalls: string[] = [];

  public constructor(private readonly connection: PinnedClient) {}

  public query<Row = Record<string, unknown>>(
    text: string,
    _values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    void _values;
    this.poolCalls.push(text);
    return Promise.reject(new Error('Transactions must not query the pool directly'));
  }

  public connect(): Promise<PinnedClient> {
    return Promise.resolve(this.connection);
  }
}

describe('withTransaction', () => {
  it('pins pool queries to one connection and releases it after commit', async () => {
    const connection = new PinnedClient();
    const pool = new PoolLikeClient(connection);

    const result = await withTransaction(pool, async (transaction) => {
      expect(transaction).toBe(connection);
      await transaction.query('SELECT 1');
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(connection.calls).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'SELECT 1',
      'COMMIT',
    ]);
    expect(connection.released).toBe(true);
    expect(pool.poolCalls).toEqual([]);
  });
});
