import { describe, expect, it } from 'vitest';
import type { BrowserSessionId, GameId, MembershipId, ParticipantId } from '@human-bingo/domain';
import type { BrowserSessionRecord, MembershipRecord } from '@human-bingo/persistence';
import type { SqlClient, SqlResult } from '@human-bingo/persistence';
import { SqlAccessRepository } from './sql-access-repository.js';

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

const sessionRow = {
  id: '00000000-0000-0000-0000-0000000000ab' as BrowserSessionId,
  session_id_hash: new Uint8Array([1, 2, 3]),
  account_or_guest_identity: 'guest:abc',
  authorization_version: '2',
  created_at: '2025-01-01T00:00:00.000Z',
  rotated_at: null,
  expires_at: '2025-01-02T00:00:00.000Z',
  revoked_at: null,
};

const membershipRow = {
  id: '00000000-0000-0000-0000-0000000000cd' as MembershipId,
  game_id: '00000000-0000-0000-0000-000000000001' as GameId,
  participant_id: '00000000-0000-0000-0000-0000000000ef' as ParticipantId,
  identity_key: 'guest:abc',
  browser_session_id: null,
  resumable_credential_hash: new Uint8Array([4, 5, 6]),
  created_at: '2025-01-01T00:00:00.000Z',
  last_seen_at: '2025-01-01T00:00:00.000Z',
};

const gameId = membershipRow.game_id;

describe('SqlAccessRepository', () => {
  it('creates a browser session and maps the returned row', async () => {
    const client = new QueueClient([{ rows: [sessionRow] }]);
    const record = await new SqlAccessRepository(client).createBrowserSession({
      sessionIdHash: new Uint8Array([1, 2, 3]),
      accountOrGuestIdentity: 'guest:abc',
      authorizationVersion: 2n,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    expect(client.calls[0]?.text).toContain('INSERT INTO browser_sessions');
    expect(record).toMatchObject<Partial<BrowserSessionRecord>>({
      id: sessionRow.id,
      accountOrGuestIdentity: 'guest:abc',
      authorizationVersion: 2n,
      rotatedAt: null,
      revokedAt: null,
    });
    expect(record.sessionIdHash).toEqual(new Uint8Array([1, 2, 3]));
    expect(record.expiresAt).toEqual(new Date('2025-01-02T00:00:00.000Z'));
  });

  it('binds the membership to the created session inside a transaction', async () => {
    const client = new QueueClient([{ rows: [sessionRow] }]);
    await new SqlAccessRepository(client).createMembershipSession({
      membershipId: membershipRow.id,
      sessionIdHash: new Uint8Array([1, 2, 3]),
      accountOrGuestIdentity: 'guest:abc',
      authorizationVersion: 2n,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    const transaction = client.calls.map((call) => call.text);
    expect(transaction[0]).toBe('BEGIN');
    expect(transaction.at(-1)).toBe('COMMIT');
    const update = client.calls.find((call) => call.text.includes('UPDATE memberships'));
    expect(update?.values).toEqual([membershipRow.id, sessionRow.id]);
  });

  it('finds a browser session by hash and maps bytea and bigint', async () => {
    const client = new QueueClient([{ rows: [sessionRow] }]);
    const record = await new SqlAccessRepository(client).findBrowserSessionByHash(
      new Uint8Array([1, 2, 3]),
    );

    expect(record?.authorizationVersion).toBe(2n);
    expect(client.calls[0]?.values).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('returns null when the session hash is unknown', async () => {
    const client = new QueueClient();
    expect(
      await new SqlAccessRepository(client).findBrowserSessionByHash(new Uint8Array([9])),
    ).toBe(null);
  });

  it('rotates the session hash only when the session is unrevoked', async () => {
    const client = new QueueClient([
      {
        rows: [
          {
            ...sessionRow,
            session_id_hash: new Uint8Array([7]),
            rotated_at: '2025-01-01T00:01:00.000Z',
          },
        ],
      },
    ]);
    const record = await new SqlAccessRepository(client).rotateBrowserSession({
      sessionId: sessionRow.id,
      currentSessionIdHash: new Uint8Array([1, 2, 3]),
      nextSessionIdHash: new Uint8Array([7]),
      rotatedAt: new Date('2025-01-01T00:01:00.000Z'),
    });

    const update = client.calls[0];
    expect(update?.text).toContain('UPDATE browser_sessions');
    expect(update?.text).toContain('revoked_at IS NULL');
    expect(update?.values).toEqual([
      sessionRow.id,
      new Uint8Array([1, 2, 3]),
      new Uint8Array([7]),
      new Date('2025-01-01T00:01:00.000Z'),
    ]);
    expect(record.rotatedAt).toEqual(new Date('2025-01-01T00:01:00.000Z'));
  });

  it('rejects rotation when the current hash does not match', async () => {
    const client = new QueueClient();
    await expect(
      new SqlAccessRepository(client).rotateBrowserSession({
        sessionId: sessionRow.id,
        currentSessionIdHash: new Uint8Array([9]),
        nextSessionIdHash: new Uint8Array([7]),
        rotatedAt: new Date('2025-01-01T00:01:00.000Z'),
      }),
    ).rejects.toThrow(/Session rotation conflict/);
  });

  it('revokes a single session idempotently', async () => {
    const client = new QueueClient();
    await new SqlAccessRepository(client).revokeBrowserSession(
      sessionRow.id,
      new Date('2025-01-01T00:02:00.000Z'),
    );

    expect(client.calls[0]?.text).toContain('UPDATE browser_sessions');
    expect(client.calls[0]?.values).toEqual([sessionRow.id, new Date('2025-01-01T00:02:00.000Z')]);
  });

  it('revokes all sessions of an identity', async () => {
    const client = new QueueClient();
    await new SqlAccessRepository(client).revokeAllBrowserSessions(
      'guest:abc',
      new Date('2025-01-01T00:02:00.000Z'),
    );

    const update = client.calls[0];
    expect(update?.text).toContain('account_or_guest_identity = $1');
    expect(update?.text).toContain('revoked_at IS NULL');
    expect(update?.values).toEqual(['guest:abc', new Date('2025-01-01T00:02:00.000Z')]);
  });

  it('reads the highest version among live sessions of an identity', async () => {
    const client = new QueueClient([{ rows: [{ version: '3' }] }]);
    expect(await new SqlAccessRepository(client).getAuthorizationVersion('guest:abc')).toBe(3n);
    expect(client.calls[0]?.text).toContain('MAX(authorization_version)');
  });

  it('defaults the authorization version to zero', async () => {
    const client = new QueueClient();
    expect(await new SqlAccessRepository(client).getAuthorizationVersion('guest:abc')).toBe(0n);
  });

  it('finds a membership by credential hash', async () => {
    const client = new QueueClient([{ rows: [membershipRow] }]);
    const membership = await new SqlAccessRepository(client).findMembershipByCredentialHash(
      gameId,
      new Uint8Array([4, 5, 6]),
    );

    expect(membership).toMatchObject<Partial<MembershipRecord>>({
      id: membershipRow.id,
      gameId,
      participantId: membershipRow.participant_id,
      identityKey: 'guest:abc',
      browserSessionId: null,
    });
    expect(membership?.resumableCredentialHash).toEqual(new Uint8Array([4, 5, 6]));
    expect(client.calls[0]?.values).toEqual([gameId, new Uint8Array([4, 5, 6])]);
  });

  it('returns null when the credential hash does not match', async () => {
    const client = new QueueClient();
    expect(
      await new SqlAccessRepository(client).findMembershipByCredentialHash(
        gameId,
        new Uint8Array([9]),
      ),
    ).toBe(null);
  });
});
