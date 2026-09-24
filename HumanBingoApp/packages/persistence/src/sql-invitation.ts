import { randomUUID } from 'node:crypto';

import type { GameStatus } from '@human-bingo/domain';
import type { GameId, InvitationId, InvitationRecord } from './models.js';
import type {
  CreateInvitationRecordInput,
  InvitationGameRecord,
  InvitationRepository,
} from './invitation.js';
import type { SqlClient } from './transaction.js';

interface SqlInvitationRow {
  readonly id: string;
  readonly game_id: string;
  readonly join_code: string;
  readonly token_hash: Uint8Array;
  readonly expires_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly created_at: Date | string;
}

interface SqlInvitationGameRow {
  readonly id: string;
  readonly name: string;
  readonly status: GameStatus;
}

const asDate = (value: Date | string): Date => new Date(value);
const asNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);

const invitationFromRow = (row: SqlInvitationRow): InvitationRecord => ({
  id: row.id as InvitationId,
  gameId: row.game_id as GameId,
  joinCode: row.join_code,
  tokenHash: new Uint8Array(row.token_hash),
  expiresAt: asNullableDate(row.expires_at),
  revokedAt: asNullableDate(row.revoked_at),
  createdAt: asDate(row.created_at),
});

const selectInvitation = `
  SELECT id, game_id, join_code, token_hash, expires_at, revoked_at, created_at
    FROM invitations`;

/**
 * PostgreSQL-backed invitation store. Bearer tokens are persisted only as
 * hashes; the game row is read again inside the onboarding transaction so a
 * status change between resolution and join cannot be missed.
 */
export class SqlInvitationRepository implements InvitationRepository {
  public constructor(private readonly client: SqlClient) {}

  public async findGame(gameId: GameId): Promise<InvitationGameRecord | null> {
    const result = await this.client.query<SqlInvitationGameRow>(
      `SELECT id, name, status FROM games WHERE id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id as GameId, name: row.name, status: row.status };
  }

  public async findByGameId(gameId: GameId): Promise<InvitationRecord | null> {
    const result = await this.client.query<SqlInvitationRow>(
      `${selectInvitation} WHERE game_id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    return row === undefined ? null : invitationFromRow(row);
  }

  public async findByJoinCode(joinCode: string): Promise<InvitationRecord | null> {
    const result = await this.client.query<SqlInvitationRow>(
      `${selectInvitation} WHERE join_code = $1`,
      [joinCode],
    );
    const row = result.rows[0];
    return row === undefined ? null : invitationFromRow(row);
  }

  public async findByTokenHash(tokenHash: Uint8Array): Promise<InvitationRecord | null> {
    const result = await this.client.query<SqlInvitationRow>(
      `${selectInvitation} WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : invitationFromRow(row);
  }

  public async insert(input: CreateInvitationRecordInput): Promise<InvitationRecord> {
    const now = new Date(input.now ?? new Date());
    const id = input.id ?? (randomUUID() as InvitationId);
    const result = await this.client.query<SqlInvitationRow>(
      `INSERT INTO invitations (id, game_id, join_code, token_hash, expires_at, revoked_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, game_id, join_code, token_hash, expires_at, revoked_at, created_at`,
      [id, input.gameId, input.joinCode, input.tokenHash, input.expiresAt ?? null, null, now],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The database did not return the created invitation');
    return invitationFromRow(row);
  }
}
