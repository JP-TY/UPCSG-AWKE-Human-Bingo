import type { BrowserSessionRecord, MembershipRecord } from '@human-bingo/persistence';
import type { D1DatabaseLike, D1Transaction } from '@human-bingo/persistence';
import { withD1Transaction } from '@human-bingo/persistence';
import type {
  AccessRepository,
  CreateBrowserSessionInput,
  CreateMembershipSessionInput,
  RotateBrowserSessionInput,
} from './session-service.js';

interface D1SessionRow {
  readonly id: string;
  readonly session_id_hash: Uint8Array;
  readonly account_or_guest_identity: string;
  readonly authorization_version: number;
  readonly created_at: string;
  readonly rotated_at: string | null;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

const toSession = (row: D1SessionRow): BrowserSessionRecord => ({
  id: row.id as BrowserSessionRecord['id'],
  sessionIdHash: new Uint8Array(row.session_id_hash as unknown as ArrayBuffer),
  accountOrGuestIdentity: row.account_or_guest_identity,
  authorizationVersion: BigInt(row.authorization_version),
  createdAt: new Date(row.created_at),
  rotatedAt: row.rotated_at ? new Date(row.rotated_at) : null,
  expiresAt: new Date(row.expires_at),
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
});

export class D1AccessRepository implements AccessRepository {
  public constructor(private readonly db: D1DatabaseLike) {}

  public async createBrowserSession(input: CreateBrowserSessionInput): Promise<BrowserSessionRecord> {
    return withD1Transaction(this.db, async (tx) => {
      const res = await tx.query<D1SessionRow>(
        `INSERT INTO browser_sessions (id, session_id_hash, account_or_guest_identity, authorization_version, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id, session_id_hash, account_or_guest_identity, authorization_version, created_at, rotated_at, expires_at, revoked_at`,
        [crypto.randomUUID(), input.sessionIdHash, input.accountOrGuestIdentity, Number(input.authorizationVersion), input.createdAt.toISOString(), input.expiresAt.toISOString()],
      );
      const row = res.rows[0] as unknown as D1SessionRow;
      if (!row) throw new Error('D1 did not return created browser session');
      return toSession(row);
    });
  }

  public async createMembershipSession(
    input: CreateMembershipSessionInput,
    tx?: D1Transaction,
  ): Promise<BrowserSessionRecord> {
    const doCreate = async (client: D1Transaction) => {
      const res = await client.query<D1SessionRow>(
        `INSERT INTO browser_sessions (id, session_id_hash, account_or_guest_identity, authorization_version, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id, session_id_hash, account_or_guest_identity, authorization_version, created_at, rotated_at, expires_at, revoked_at`,
        [crypto.randomUUID(), input.sessionIdHash, input.accountOrGuestIdentity, Number(input.authorizationVersion), input.createdAt.toISOString(), input.expiresAt.toISOString()],
      );
      const row = res.rows[0] as unknown as D1SessionRow;
      if (!row) throw new Error('D1 did not return created membership session');
      await client.query(`UPDATE memberships SET browser_session_id = ? WHERE id = ?`, [row.id, input.membershipId]);
      return toSession(row);
    };
    if (tx) return doCreate(tx);
    return withD1Transaction(this.db, (inner) => doCreate(inner));
  }

  public async findBrowserSessionByHash(sessionIdHash: Uint8Array): Promise<BrowserSessionRecord | null> {
    const res = (await this.db
      .prepare(`SELECT id, session_id_hash, account_or_guest_identity, authorization_version, created_at, rotated_at, expires_at, revoked_at FROM browser_sessions WHERE session_id_hash = ?`)
      .bind(sessionIdHash)
      .first()) as unknown as D1SessionRow | null;
    return res ? toSession(res) : null;
  }

  public async getAuthorizationVersion(identity: string, tx?: D1Transaction): Promise<bigint> {
    if (tx) {
      const res = await tx.query<{ version: number }>(
        `SELECT COALESCE(MAX(authorization_version), 0) AS version FROM browser_sessions WHERE account_or_guest_identity = ? AND revoked_at IS NULL`,
        [identity],
      );
      return BigInt((res.rows[0] as unknown as { version: number })?.version ?? 0);
    }
    const res = await this.db
      .prepare(`SELECT COALESCE(MAX(authorization_version), 0) AS version FROM browser_sessions WHERE account_or_guest_identity = ? AND revoked_at IS NULL`)
      .bind(identity)
      .first<{ version: number }>();
    return BigInt(res?.version ?? 0);
  }

  public rotateBrowserSession(_input: RotateBrowserSessionInput): Promise<BrowserSessionRecord> {
    void _input;
    throw new Error('rotateBrowserSession not implemented for D1 in this iteration');
  }
  public async revokeBrowserSession(): Promise<void> {
    await Promise.resolve();
  }
  public async revokeAllBrowserSessions(): Promise<void> {
    await Promise.resolve();
  }
  public findMembershipByCredentialHash(): Promise<MembershipRecord | null> {
    return Promise.resolve(null);
  }
  public findMembershipByBrowserSessionId(): Promise<MembershipRecord | null> {
    return Promise.resolve(null);
  }
}
