import type { GameId, MembershipId, ParticipantId } from '@human-bingo/domain';
import type {
  BrowserSessionId,
  BrowserSessionRecord,
  MembershipRecord,
} from '@human-bingo/persistence';
import {
  withTransaction,
  type SqlClient,
  type SqlResult,
  type SqlTransaction,
} from '@human-bingo/persistence';
import type {
  AccessRepository,
  CreateBrowserSessionInput,
  CreateMembershipSessionInput,
  RotateBrowserSessionInput,
} from './session-service.js';

interface SqlBrowserSessionRow {
  readonly id: string;
  readonly session_id_hash: Uint8Array;
  readonly account_or_guest_identity: string;
  readonly authorization_version: string | bigint | number;
  readonly created_at: Date | string;
  readonly rotated_at: Date | string | null;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
}

interface SqlMembershipRow {
  readonly id: string;
  readonly game_id: string;
  readonly participant_id: string;
  readonly identity_key: string;
  readonly browser_session_id: string | null;
  readonly resumable_credential_hash: Uint8Array;
  readonly created_at: Date | string;
  readonly last_seen_at: Date | string;
}

const asDate = (value: Date | string): Date => new Date(value);
const asNullableDate = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);

const sessionFromRow = (row: SqlBrowserSessionRow): BrowserSessionRecord => ({
  id: row.id as BrowserSessionId,
  sessionIdHash: new Uint8Array(row.session_id_hash),
  accountOrGuestIdentity: row.account_or_guest_identity,
  authorizationVersion: BigInt(row.authorization_version),
  createdAt: asDate(row.created_at),
  rotatedAt: asNullableDate(row.rotated_at),
  expiresAt: asDate(row.expires_at),
  revokedAt: asNullableDate(row.revoked_at),
});

const membershipFromRow = (row: SqlMembershipRow): MembershipRecord => ({
  id: row.id as MembershipId,
  gameId: row.game_id as GameId,
  participantId: row.participant_id as ParticipantId,
  identityKey: row.identity_key,
  browserSessionId: row.browser_session_id as BrowserSessionId | null,
  resumableCredentialHash: new Uint8Array(row.resumable_credential_hash),
  createdAt: asDate(row.created_at),
  lastSeenAt: asDate(row.last_seen_at),
});

const selectSession = `
  SELECT id, session_id_hash, account_or_guest_identity, authorization_version,
         created_at, rotated_at, expires_at, revoked_at
    FROM browser_sessions`;

const selectMembership = `
  SELECT m.id, m.game_id, m.participant_id, m.identity_key, m.browser_session_id,
         m.resumable_credential_hash, m.created_at, m.last_seen_at
    FROM memberships m`;

/**
 * PostgreSQL-backed access repository. Session credentials are persisted
 * only as hashes, and membership sessions atomically bind the membership row
 * to the created browser session.
 */
export class SqlAccessRepository implements AccessRepository {
  public constructor(private readonly client: SqlClient) {}

  public async createBrowserSession(
    input: CreateBrowserSessionInput,
  ): Promise<BrowserSessionRecord> {
    const result = await this.client.query<SqlBrowserSessionRow>(
      `INSERT INTO browser_sessions
         (session_id_hash, account_or_guest_identity, authorization_version, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, session_id_hash, account_or_guest_identity, authorization_version,
                 created_at, rotated_at, expires_at, revoked_at`,
      [
        input.sessionIdHash,
        input.accountOrGuestIdentity,
        input.authorizationVersion,
        input.createdAt,
        input.expiresAt,
      ],
    );
    return requireRow(result, 'The database did not return the created browser session');
  }

  public async createMembershipSession(
    input: CreateMembershipSessionInput,
    suppliedTransaction?: SqlTransaction,
  ): Promise<BrowserSessionRecord> {
    if (suppliedTransaction !== undefined) {
      const result = await suppliedTransaction.query<SqlBrowserSessionRow>(
        `INSERT INTO browser_sessions
           (session_id_hash, account_or_guest_identity, authorization_version, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, session_id_hash, account_or_guest_identity, authorization_version,
                   created_at, rotated_at, expires_at, revoked_at`,
        [
          input.sessionIdHash,
          input.accountOrGuestIdentity,
          input.authorizationVersion,
          input.createdAt,
          input.expiresAt,
        ],
      );
      const session = requireRow(result, 'The database did not return the created browser session');
      await suppliedTransaction.query(`UPDATE memberships SET browser_session_id = $2 WHERE id = $1`, [
        input.membershipId,
        session.id,
      ]);
      return session;
    }
    return withTransaction(this.client, async (transaction) => {
      const result = await transaction.query<SqlBrowserSessionRow>(
        `INSERT INTO browser_sessions
           (session_id_hash, account_or_guest_identity, authorization_version, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, session_id_hash, account_or_guest_identity, authorization_version,
                   created_at, rotated_at, expires_at, revoked_at`,
        [
          input.sessionIdHash,
          input.accountOrGuestIdentity,
          input.authorizationVersion,
          input.createdAt,
          input.expiresAt,
        ],
      );
      const session = requireRow(result, 'The database did not return the created browser session');
      await transaction.query(`UPDATE memberships SET browser_session_id = $2 WHERE id = $1`, [
        input.membershipId,
        session.id,
      ]);
      return session;
    });
  }

  public async findBrowserSessionByHash(
    sessionIdHash: Uint8Array,
  ): Promise<BrowserSessionRecord | null> {
    const result = await this.client.query<SqlBrowserSessionRow>(
      `${selectSession} WHERE session_id_hash = $1`,
      [sessionIdHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : sessionFromRow(row);
  }

  public async rotateBrowserSession(
    input: RotateBrowserSessionInput,
  ): Promise<BrowserSessionRecord> {
    const result = await this.client.query<SqlBrowserSessionRow>(
      `UPDATE browser_sessions
          SET session_id_hash = $3, rotated_at = $4
        WHERE id = $1 AND session_id_hash = $2 AND revoked_at IS NULL
       RETURNING id, session_id_hash, account_or_guest_identity, authorization_version,
                 created_at, rotated_at, expires_at, revoked_at`,
      [input.sessionId, input.currentSessionIdHash, input.nextSessionIdHash, input.rotatedAt],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('Session rotation conflict: the session was missing, revoked, or reissued');
    return sessionFromRow(row);
  }

  public async revokeBrowserSession(sessionId: BrowserSessionId, revokedAt: Date): Promise<void> {
    await this.client.query(
      `UPDATE browser_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, revokedAt],
    );
  }

  public async revokeAllBrowserSessions(
    accountOrGuestIdentity: string,
    revokedAt: Date,
  ): Promise<void> {
    await this.client.query(
      `UPDATE browser_sessions SET revoked_at = $2
        WHERE account_or_guest_identity = $1 AND revoked_at IS NULL`,
      [accountOrGuestIdentity, revokedAt],
    );
  }

  public async getAuthorizationVersion(
    accountOrGuestIdentity: string,
    suppliedTransaction?: SqlTransaction,
  ): Promise<bigint> {
    const result = await (suppliedTransaction ?? this.client).query<{
      readonly version: string | bigint | number;
    }>(
      `SELECT COALESCE(MAX(authorization_version), 0)::bigint AS version
         FROM browser_sessions
        WHERE account_or_guest_identity = $1 AND revoked_at IS NULL`,
      [accountOrGuestIdentity],
    );
    return BigInt(result.rows[0]?.version ?? 0);
  }

  public async findMembershipByCredentialHash(
    gameId: GameId,
    resumableCredentialHash: Uint8Array,
  ): Promise<MembershipRecord | null> {
    const result = await this.client.query<SqlMembershipRow>(
      `${selectMembership} WHERE m.game_id = $1 AND m.resumable_credential_hash = $2`,
      [gameId, resumableCredentialHash],
    );
    const row = result.rows[0];
    return row === undefined ? null : membershipFromRow(row);
  }

  public async findMembershipByBrowserSessionId(
    sessionId: BrowserSessionId,
  ): Promise<MembershipRecord | null> {
    const result = await this.client.query<SqlMembershipRow>(
      `${selectMembership} WHERE m.browser_session_id = $1 LIMIT 1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : membershipFromRow(row);
  }
}

function requireRow(
  result: SqlResult<SqlBrowserSessionRow>,
  message: string,
): BrowserSessionRecord {
  const row = result.rows[0];
  if (row === undefined) throw new Error(message);
  return sessionFromRow(row);
}
