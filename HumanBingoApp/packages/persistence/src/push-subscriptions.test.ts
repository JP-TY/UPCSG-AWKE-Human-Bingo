import { describe, expect, it } from 'vitest';

import type { GameId, ParticipantId } from '@human-bingo/domain';

import { SqlPushSubscriptionRepository } from './push-subscriptions.js';
import type { SqlClient } from './transaction.js';

class RecordingClient implements SqlClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];

  public constructor(private readonly response: unknown = { rows: [] }) {}

  public query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    return Promise.resolve(this.response as { readonly rows: readonly Row[] });
  }
}

describe('SqlPushSubscriptionRepository', () => {
  it('upserts subscriptions and reactivates a revoked endpoint', async () => {
    const client = new RecordingClient({
      rows: [
        {
          id: 'subscription-1',
          game_id: 'game-1',
          participant_id: 'participant-1',
          endpoint_hash: new Uint8Array([1, 2]),
          provider_data: '{"endpoint":"https://push.example/1"}',
          created_at: '2025-01-01T00:00:00.000Z',
          last_success_at: null,
          last_failure_at: null,
          revoked_at: null,
        },
      ],
    });
    const repository = new SqlPushSubscriptionRepository();
    const record = await repository.register(client, {
      gameId: 'game-1' as GameId,
      participantId: 'participant-1' as ParticipantId,
      endpointHash: new Uint8Array([1, 2]),
      providerData: { endpoint: 'https://push.example/1' },
    });

    expect(record.id).toBe('subscription-1');
    expect(client.queries[0]?.text).toContain(
      'ON CONFLICT (game_id, participant_id, endpoint_hash)',
    );
    expect(client.queries[0]?.values?.[3]).toBe('{"endpoint":"https://push.example/1"}');
  });

  it('records failures and revokes only stale endpoints', async () => {
    const client = new RecordingClient();
    const repository = new SqlPushSubscriptionRepository();
    await repository.markFailure(
      client,
      'subscription-1' as never,
      new Date('2025-01-01T00:00:00.000Z'),
      true,
    );
    expect(client.queries[0]?.text).toContain('revoked_at = CASE WHEN $3');
    expect(client.queries[0]?.values?.[2]).toBe(true);
  });
});
