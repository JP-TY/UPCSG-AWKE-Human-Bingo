import type { GameId, ParticipantId, PushSubscriptionId } from '@human-bingo/domain';
import type { PushSubscriptionRecord } from './models.js';
import type { SqlClient } from './transaction.js';

interface PushSubscriptionRow {
  readonly id: string;
  readonly game_id: string;
  readonly participant_id: string;
  readonly endpoint_hash: Uint8Array;
  readonly provider_data: Record<string, unknown> | string;
  readonly created_at: Date | string;
  readonly last_success_at: Date | string | null;
  readonly last_failure_at: Date | string | null;
  readonly revoked_at: Date | string | null;
}

export interface RegisterPushSubscriptionInput {
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly endpointHash: Uint8Array;
  readonly providerData: Record<string, unknown>;
}

export interface PushSubscriptionRepository {
  register(
    client: SqlClient,
    input: RegisterPushSubscriptionInput,
  ): Promise<PushSubscriptionRecord>;
  listActive(
    client: SqlClient,
    gameId: GameId,
    participantId: ParticipantId,
  ): Promise<readonly PushSubscriptionRecord[]>;
  markSuccess(client: SqlClient, id: PushSubscriptionId, deliveredAt: Date): Promise<void>;
  markFailure(
    client: SqlClient,
    id: PushSubscriptionId,
    failedAt: Date,
    stale: boolean,
  ): Promise<void>;
}

/** PostgreSQL adapter for the optional, best-effort push delivery path. */
export class SqlPushSubscriptionRepository implements PushSubscriptionRepository {
  public async register(
    client: SqlClient,
    input: RegisterPushSubscriptionInput,
  ): Promise<PushSubscriptionRecord> {
    const result = await client.query<PushSubscriptionRow>(
      `INSERT INTO push_subscriptions
         (game_id, participant_id, endpoint_hash, provider_data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (game_id, participant_id, endpoint_hash)
       DO UPDATE SET provider_data = EXCLUDED.provider_data, revoked_at = NULL
       RETURNING id, game_id, participant_id, endpoint_hash, provider_data, created_at,
                 last_success_at, last_failure_at, revoked_at`,
      [input.gameId, input.participantId, input.endpointHash, JSON.stringify(input.providerData)],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The database did not return the push subscription');
    return toRecord(row);
  }

  public async listActive(
    client: SqlClient,
    gameId: GameId,
    participantId: ParticipantId,
  ): Promise<readonly PushSubscriptionRecord[]> {
    const result = await client.query<PushSubscriptionRow>(
      `SELECT id, game_id, participant_id, endpoint_hash, provider_data, created_at,
              last_success_at, last_failure_at, revoked_at
         FROM push_subscriptions
        WHERE game_id = $1 AND participant_id = $2 AND revoked_at IS NULL
        ORDER BY created_at, id`,
      [gameId, participantId],
    );
    return result.rows.map(toRecord);
  }

  public async markSuccess(
    client: SqlClient,
    id: PushSubscriptionId,
    deliveredAt: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE push_subscriptions
          SET last_success_at = $2, last_failure_at = NULL
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, deliveredAt],
    );
  }

  public async markFailure(
    client: SqlClient,
    id: PushSubscriptionId,
    failedAt: Date,
    stale: boolean,
  ): Promise<void> {
    await client.query(
      `UPDATE push_subscriptions
          SET last_failure_at = $2,
              revoked_at = CASE WHEN $3 THEN COALESCE(revoked_at, $2) ELSE revoked_at END
        WHERE id = $1`,
      [id, failedAt, stale],
    );
  }
}

function toRecord(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id as PushSubscriptionId,
    gameId: row.game_id as GameId,
    participantId: row.participant_id as ParticipantId,
    endpointHash: new Uint8Array(row.endpoint_hash),
    providerData: parseProviderData(row.provider_data),
    createdAt: dateValue(row.created_at),
    lastSuccessAt: nullableDateValue(row.last_success_at),
    lastFailureAt: nullableDateValue(row.last_failure_at),
    revokedAt: nullableDateValue(row.revoked_at),
  };
}

function parseProviderData(value: Record<string, unknown> | string): Record<string, unknown> {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Push provider data must be a JSON object');
  }
  return { ...(parsed as Record<string, unknown>) };
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function nullableDateValue(value: Date | string | null): Date | null {
  return value === null ? null : dateValue(value);
}
