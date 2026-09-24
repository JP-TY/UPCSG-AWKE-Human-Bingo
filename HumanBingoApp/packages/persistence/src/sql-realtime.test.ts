import { describe, expect, it } from 'vitest';
import type { GameId } from '@human-bingo/domain';
import { SqlGameConfigurationRepository, type SqlClient, type SqlResult } from './index.js';

const gameId = '11111111-1111-4111-8111-111111111111' as GameId;

class QueueClient implements SqlClient {
  readonly calls: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  private index = 0;

  public constructor(private readonly responses: readonly unknown[]) {}

  public query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    if (/^(BEGIN|SET TRANSACTION|COMMIT|ROLLBACK)/.test(text)) return Promise.resolve({ rows: [] });
    const response = this.responses[this.index] as SqlResult<Row> | undefined;
    this.index += 1;
    return Promise.resolve(response ?? { rows: [] });
  }
}

const gameRow = {
  id: gameId,
  host_account_id: 'host-1',
  name: 'Realtime game',
  status: 'draft' as const,
  task_bag_locked_at: null,
  closed_at: null,
  state_version: '0',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

const outboxRow = {
  id: 'event-1',
  game_id: gameId,
  state_version: '1',
  event_type: 'game.patch',
  payload: { changes: {} },
  created_at: '2025-01-01T00:00:00.000Z',
  published_at: null,
  attempt_count: 0,
  next_attempt_at: null,
  last_error: null,
};

describe('SQL realtime invalidations', () => {
  it('writes one game.patch outbox event with the state mutation', async () => {
    const client = new QueueClient([
      { rows: [gameRow] },
      { rows: [] },
      { rows: [] },
      { rows: [outboxRow] },
    ]);
    const repository = new SqlGameConfigurationRepository(client);

    await repository.withGameConfiguration(gameId, (state) => {
      state.game = { ...state.game, stateVersion: 1n };
    });

    const outboxCall = client.calls.find((call) => call.text.includes('INSERT INTO outbox_events'));
    expect(outboxCall?.values).toEqual([
      gameId,
      1n,
      'game.patch',
      JSON.stringify({ changes: {} }),
    ]);
  });

  it('does not emit an event for an authoritative read', async () => {
    const client = new QueueClient([{ rows: [gameRow] }, { rows: [] }, { rows: [] }]);
    const repository = new SqlGameConfigurationRepository(client);

    await repository.withGameConfiguration(gameId, () => undefined);

    expect(client.calls.some((call) => call.text.includes('INSERT INTO outbox_events'))).toBe(false);
  });

  it('reads game configuration without writing the game or task rows', async () => {
    const client = new QueueClient([{ rows: [gameRow] }, { rows: [] }]);
    const repository = new SqlGameConfigurationRepository(client);

    await repository.read(gameId);

    expect(client.calls.some((call) => call.text.includes('UPDATE games'))).toBe(false);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO task_entries'))).toBe(false);
  });
});
