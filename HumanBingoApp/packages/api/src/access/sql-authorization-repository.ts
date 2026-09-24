import type {
  GameId,
  GameStatus,
  MembershipId,
  ParticipantId,
  VerificationRequestId,
} from '@human-bingo/domain';
import type {
  BrowserSessionId,
  MembershipRecord,
  VerificationRequestStatus,
} from '@human-bingo/persistence';
import type { SqlClient } from '@human-bingo/persistence';
import type { AuthorizationRepository } from './authorization.js';

interface SqlGameRow {
  readonly id: string;
  readonly host_account_id: string;
  readonly status: GameStatus;
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

interface SqlVerificationRequestRow {
  readonly game_id: string;
  readonly identified_participant_id: string;
  readonly status: VerificationRequestStatus;
}

const asDate = (value: Date | string): Date => new Date(value);

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

const selectMembership = `
  SELECT m.id, m.game_id, m.participant_id, m.identity_key, m.browser_session_id,
         m.resumable_credential_hash, m.created_at, m.last_seen_at
    FROM memberships m`;

/**
 * PostgreSQL-backed authorization repository. Authorization reads go straight
 * to the committed game and membership state so that access decisions observe
 * the same state as every other request in the system.
 */
export class SqlAuthorizationRepository implements AuthorizationRepository {
  public constructor(private readonly client: SqlClient) {}

  public async findGame(gameId: GameId): Promise<{
    readonly id: GameId;
    readonly hostAccountId: string;
    readonly status: GameStatus;
  } | null> {
    const result = await this.client.query<SqlGameRow>(
      `SELECT id, host_account_id, status FROM games WHERE id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id as GameId, hostAccountId: row.host_account_id, status: row.status };
  }

  public async findMembership(
    gameId: GameId,
    participantId: ParticipantId,
  ): Promise<MembershipRecord | null> {
    const result = await this.client.query<SqlMembershipRow>(
      `${selectMembership} WHERE m.game_id = $1 AND m.participant_id = $2`,
      [gameId, participantId],
    );
    const row = result.rows[0];
    return row === undefined ? null : membershipFromRow(row);
  }

  public async findVerificationRequest(
    gameId: GameId,
    verificationRequestId: VerificationRequestId,
  ): Promise<{
    readonly gameId: GameId;
    readonly identifiedParticipantId: ParticipantId;
    readonly status: VerificationRequestStatus;
  } | null> {
    const result = await this.client.query<SqlVerificationRequestRow>(
      `SELECT game_id, identified_participant_id, status
         FROM verification_requests
        WHERE game_id = $1 AND id = $2`,
      [gameId, verificationRequestId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          gameId: row.game_id as GameId,
          identifiedParticipantId: row.identified_participant_id as ParticipantId,
          status: row.status,
        };
  }
}
