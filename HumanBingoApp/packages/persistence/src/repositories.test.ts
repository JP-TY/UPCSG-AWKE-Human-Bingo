import { describe, expect, it } from 'vitest';
import type { CorrelationId, GameId, IdempotencyKey, StateVersion } from '@human-bingo/domain';
import {
  GameCreationRepository,
  GameMutationRepository,
  type SqlClient,
  type SqlResult,
  StaleStateConflictError,
  withTransaction,
} from './index.js';

const gameId = 'game-1' as GameId;
const idempotencyKey = 'command-1' as IdempotencyKey;
const correlationId = 'correlation-1' as CorrelationId;

const gameRow = {
  id: gameId,
  host_account_id: 'host-1',
  name: 'Team bingo',
  status: 'draft' as const,
  task_bag_locked_at: null,
  closed_at: null,
  state_version: '4',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

const outboxRow = {
  id: 'event-1',
  game_id: gameId,
  state_version: '5',
  event_type: 'game.renamed',
  payload: { gameId, name: 'Team bingo' },
  created_at: '2025-01-01T00:00:00.000Z',
  published_at: null,
  attempt_count: 0,
  next_attempt_at: null,
  last_error: null,
};

class QueueClient implements SqlClient {
  public readonly calls: Array<{ readonly text: string; readonly values?: readonly unknown[] }> =
    [];
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

function rows<Row>(...values: Row[]): SqlResult<Row> {
  return { rows: values };
}

const mutationInput = {
  gameId,
  idempotencyKey,
  commandType: 'rename_game',
  knownStateVersion: 4 as StateVersion,
  correlationId,
  eventType: 'game.renamed',
  eventPayload: { gameId, name: 'Team bingo' },
  mutate: () => Promise.resolve({ value: { accepted: true } }),
};

describe('withTransaction', () => {
  it('uses serializable isolation and commits successful work', async () => {
    const client = new QueueClient();
    const value = await withTransaction(client, (_transaction, context) =>
      Promise.resolve(context.attempt),
    );

    expect(value).toBe(0);
    expect(client.calls.map((call) => call.text)).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'COMMIT',
    ]);
  });

  it('rolls back application failures without committing', async () => {
    const client = new QueueClient();
    await expect(
      withTransaction(client, () => Promise.reject(new Error('mutation failed'))),
    ).rejects.toThrow('mutation failed');
    expect(client.calls.map((call) => call.text)).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'ROLLBACK',
    ]);
  });

  it('retries deadlock failures and exposes a fresh attempt context', async () => {
    const client = new QueueClient();
    const attempts: number[] = [];
    const value = await withTransaction(client, (_transaction, context) => {
      attempts.push(context.attempt);
      if (context.attempt === 0) {
        const error = new Error('deadlock detected') as Error & { code: string };
        error.code = '40P01';
        return Promise.reject(error);
      }
      return Promise.resolve({ committedAttempt: context.attempt });
    });

    expect(value).toEqual({ committedAttempt: 1 });
    expect(attempts).toEqual([0, 1]);
    expect(client.calls.map((call) => call.text)).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'ROLLBACK',
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'COMMIT',
    ]);
  });

  it('retries serialization failures and commits only the successful attempt', async () => {
    const client = new QueueClient();
    let attempts = 0;
    const value = await withTransaction(client, (_transaction, context) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('serialization failure') as Error & { code: string };
        error.code = '40001';
        return Promise.reject(error);
      }
      return Promise.resolve(context.attempt);
    });

    expect(value).toBe(1);
    expect(client.calls.map((call) => call.text)).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'ROLLBACK',
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'COMMIT',
    ]);
  });
});

describe('GameMutationRepository', () => {
  it('locks the game, checks the known version, bumps once, and writes one outbox event atomically', async () => {
    const client = new QueueClient([
      rows(gameRow),
      rows(),
      rows({ state_version: '5' }),
      rows(outboxRow),
      rows({
        scope_key: `game:${gameId}:${idempotencyKey}`,
        game_id: gameId,
        idempotency_key: idempotencyKey,
        command_type: 'rename_game',
        state_version: '5',
        result_json: JSON.stringify({ accepted: true }),
        created_at: '2025-01-01T00:00:00.000Z',
      }),
    ]);
    const result = await new GameMutationRepository().execute(client, mutationInput);

    expect(result.value).toEqual({ accepted: true });
    expect(result.stateVersion).toBe(5);
    expect(result.replayed).toBe(false);
    expect(result.event.stateVersion).toBe(5n);
    expect(client.calls[2]?.text).toContain('FOR UPDATE');
    expect(client.calls[4]?.text).toContain('state_version = state_version + 1');
    expect(client.calls[5]?.text).toContain('INSERT INTO outbox_events');
    expect(client.calls[6]?.text).toContain('INSERT INTO command_idempotency');
  });

  it('returns a typed stale conflict and does not mutate or write an outbox event', async () => {
    const client = new QueueClient([rows(gameRow), rows()]);
    const input = { ...mutationInput, knownStateVersion: 3 as StateVersion };

    await expect(new GameMutationRepository().execute(client, input)).rejects.toBeInstanceOf(
      StaleStateConflictError,
    );
    const callTexts = client.calls.map((call) => call.text);
    expect(callTexts[2]).toContain('FOR UPDATE');
    expect(callTexts[3]).toContain('command_idempotency');
    expect(callTexts.at(-1)).toBe('ROLLBACK');
    expect(client.calls.some((call) => call.text.includes('INSERT INTO outbox_events'))).toBe(
      false,
    );
    expect(
      client.calls.some((call) => call.text.includes('state_version = state_version + 1')),
    ).toBe(false);
  });

  it('replays a committed idempotent command without a second state version or outbox event', async () => {
    const client = new QueueClient([
      rows(gameRow),
      rows({
        scope_key: `game:${gameId}:${idempotencyKey}`,
        game_id: gameId,
        idempotency_key: idempotencyKey,
        command_type: 'rename_game',
        state_version: '5',
        result_json: JSON.stringify({ accepted: true }),
        created_at: '2025-01-01T00:00:00.000Z',
      }),
      rows(outboxRow),
    ]);
    const result = await new GameMutationRepository().execute(client, mutationInput);

    expect(result.value).toEqual({ accepted: true });
    expect(result.replayed).toBe(true);
    expect(
      client.calls.some((call) => call.text.includes('state_version = state_version + 1')),
    ).toBe(false);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO outbox_events'))).toBe(
      false,
    );
    expect(client.calls.some((call) => call.text.includes('INSERT INTO command_idempotency'))).toBe(
      false,
    );
  });

  it('rolls back a failed mutation before state version or outbox writes', async () => {
    const client = new QueueClient([rows(gameRow), rows()]);
    const input = {
      ...mutationInput,
      mutate: () => Promise.reject(new Error('profile generation failed')),
    };

    await expect(new GameMutationRepository().execute(client, input)).rejects.toThrow(
      'profile generation failed',
    );
    expect(client.calls.map((call) => call.text).slice(-1)[0]).toBe('ROLLBACK');
    expect(
      client.calls.some((call) => call.text.includes('state_version = state_version + 1')),
    ).toBe(false);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO outbox_events'))).toBe(
      false,
    );
  });
});

describe('GameCreationRepository', () => {
  const createdGameRow = {
    ...gameRow,
    id: 'game-created' as GameId,
    state_version: '1',
  };
  const createdOutboxRow = {
    ...outboxRow,
    id: 'event-created',
    game_id: 'game-created' as GameId,
    state_version: '1',
    event_type: 'game.created',
  };

  it('serializes creation by idempotency scope and writes the game, event, and replay record in one transaction', async () => {
    const client = new QueueClient([
      rows(),
      rows(),
      rows(createdGameRow),
      rows(createdOutboxRow),
      rows({
        scope_key: 'create:create-1',
        game_id: 'game-created',
        idempotency_key: 'create-1',
        command_type: 'create_game',
        state_version: '1',
        result_json: JSON.stringify(createdGameRow),
        created_at: '2025-01-01T00:00:00.000Z',
      }),
    ]);

    const result = await new GameCreationRepository().create(client, {
      hostAccountId: 'host-1',
      name: 'Team bingo',
      idempotencyKey: 'create-1' as IdempotencyKey,
      correlationId,
      eventPayload: { gameId: 'game-created' },
    });

    expect(result.value.id).toBe('game-created');
    expect(result.stateVersion).toBe(1);
    expect(result.replayed).toBe(false);
    expect(client.calls[2]?.text).toContain('pg_advisory_xact_lock');
    expect(client.calls[3]?.text).toContain('FROM command_idempotency');
    expect(client.calls.some((call) => call.text.includes('INSERT INTO games'))).toBe(true);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO outbox_events'))).toBe(true);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO command_idempotency'))).toBe(
      true,
    );
  });

  it('replays an existing creation after locking its scope without creating another game or event', async () => {
    const client = new QueueClient([
      rows(),
      rows({
        scope_key: 'create:create-1',
        game_id: 'game-created',
        idempotency_key: 'create-1',
        command_type: 'create_game',
        state_version: '1',
        result_json: JSON.stringify(createdGameRow),
        created_at: '2025-01-01T00:00:00.000Z',
      }),
      rows(createdOutboxRow),
    ]);

    const result = await new GameCreationRepository().create(client, {
      hostAccountId: 'host-1',
      name: 'Team bingo',
      idempotencyKey: 'create-1' as IdempotencyKey,
      correlationId,
      eventPayload: { gameId: 'game-created' },
    });

    expect(result.value.id).toBe('game-created');
    expect(result.replayed).toBe(true);
    expect(client.calls[2]?.text).toContain('pg_advisory_xact_lock');
    expect(client.calls.some((call) => call.text.includes('INSERT INTO games'))).toBe(false);
    expect(client.calls.some((call) => call.text.includes('INSERT INTO outbox_events'))).toBe(
      false,
    );
    expect(client.calls.some((call) => call.text.includes('INSERT INTO command_idempotency'))).toBe(
      false,
    );
  });
});

describe('outbox payload authorization boundary', () => {
  it('rolls back a mutation whose event payload contains a session credential', async () => {
    const client = new QueueClient([rows(gameRow), rows(), rows({ state_version: '5' })]);
    const input = {
      ...mutationInput,
      eventPayload: { gameId, sessionCredential: 'raw-session-secret' },
    };

    await expect(new GameMutationRepository().execute(client, input)).rejects.toThrow(
      'Outbox payload contains a secret field',
    );
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK');
    expect(client.calls.some((call) => call.text.includes('INSERT INTO command_idempotency'))).toBe(
      false,
    );
  });
});
