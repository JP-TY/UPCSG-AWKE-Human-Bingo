import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import type { GameId, MembershipId, ParticipantId } from '@human-bingo/domain';
import {
  createTestPostgres,
  readDatabaseTestConfig,
  truncateDatabase,
  type TestPostgres,
} from '@human-bingo/test-utils';
import type { SqlClient } from '@human-bingo/persistence';
import { SqlAccessRepository } from './sql-access-repository.js';

const GAME_ID = '00000000-0000-0000-0000-000000000001' as GameId;
const PARTICIPANT_ID = '00000000-0000-0000-0000-000000000002' as ParticipantId;
const MEMBERSHIP_ID = '00000000-0000-0000-0000-000000000003' as MembershipId;
const IDENTITY = 'guest:integration-access';

const seedGame = async (client: SqlClient): Promise<void> => {
  await client.query(
    `INSERT INTO games (id, host_account_id, name, status)
     VALUES ($1, $2, $3, 'active')`,
    [GAME_ID, 'host-account', 'Integration game'],
  );
};

const seedMembership = async (
  client: SqlClient,
  resumableCredentialHash: Uint8Array,
): Promise<void> => {
  await client.query(`INSERT INTO participants (id, game_id) VALUES ($1, $2)`, [
    PARTICIPANT_ID,
    GAME_ID,
  ]);
  await client.query(
    `INSERT INTO memberships
       (id, game_id, participant_id, identity_key, resumable_credential_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [MEMBERSHIP_ID, GAME_ID, PARTICIPANT_ID, IDENTITY, resumableCredentialHash],
  );
};

const readMembershipSessionId = async (client: SqlClient): Promise<string | null> => {
  const result = await client.query<{ readonly browser_session_id: string | null }>(
    `SELECT browser_session_id FROM memberships WHERE id = $1`,
    [MEMBERSHIP_ID],
  );
  return result.rows[0]?.browser_session_id ?? null;
};

const readSession = async (
  client: SqlClient,
  sessionIdHash: Uint8Array,
): Promise<{
  readonly id: string;
  readonly session_id_hash: Uint8Array;
  readonly rotated_at: Date | null;
  readonly revoked_at: Date | null;
} | null> => {
  const result = await client.query<{
    readonly id: string;
    readonly session_id_hash: Uint8Array;
    readonly rotated_at: Date | null;
    readonly revoked_at: Date | null;
  }>(
    `SELECT id, session_id_hash, rotated_at, revoked_at FROM browser_sessions WHERE session_id_hash = $1`,
    [sessionIdHash],
  );
  return result.rows[0] ?? null;
};

const databaseConfigured = readDatabaseTestConfig().url !== undefined;

describe.skipIf(!databaseConfigured)('SqlAccessRepository (PostgreSQL)', () => {
  let postgres: TestPostgres;
  let client: PoolClient;

  beforeAll(async () => {
    postgres = createTestPostgres();
    client = await postgres.pool.connect();
  });

  afterAll(async () => {
    client.release();
    await postgres.close();
  });

  afterEach(async () => {
    await truncateDatabase(postgres.pool);
  });

  const repository = (): SqlAccessRepository => new SqlAccessRepository(client);

  it('creates a browser session and finds it by hash', async () => {
    const hash = new Uint8Array([1, 2, 3]);
    const created = await repository().createBrowserSession({
      sessionIdHash: hash,
      accountOrGuestIdentity: IDENTITY,
      authorizationVersion: 4n,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    expect(created.sessionIdHash).toEqual(hash);
    expect(created.accountOrGuestIdentity).toBe(IDENTITY);
    expect(created.authorizationVersion).toBe(4n);
    expect(created.rotatedAt).toBeNull();
    expect(created.revokedAt).toBeNull();

    const found = await repository().findBrowserSessionByHash(hash);
    expect(found?.id).toBe(created.id);
    expect(found?.expiresAt).toEqual(new Date('2025-01-02T00:00:00.000Z'));
  });

  it('returns null when the session hash is unknown', async () => {
    expect(await repository().findBrowserSessionByHash(new Uint8Array([9, 9]))).toBeNull();
  });

  it('creates a membership session and binds the membership row', async () => {
    const credentialHash = new Uint8Array([4, 5, 6]);
    await seedGame(client);
    await seedMembership(client, credentialHash);

    const session = await repository().createMembershipSession({
      membershipId: MEMBERSHIP_ID,
      sessionIdHash: new Uint8Array([7, 8, 9]),
      accountOrGuestIdentity: IDENTITY,
      authorizationVersion: 1n,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    expect(await readMembershipSessionId(client)).toBe(session.id);

    const stored = await readSession(client, new Uint8Array([7, 8, 9]));
    expect(stored?.id).toBe(session.id);
  });

  it('finds a membership by credential hash', async () => {
    const credentialHash = new Uint8Array([4, 5, 6]);
    await seedGame(client);
    await seedMembership(client, credentialHash);

    const found = await repository().findMembershipByCredentialHash(GAME_ID, credentialHash);
    expect(found).toMatchObject({
      id: MEMBERSHIP_ID,
      gameId: GAME_ID,
      participantId: PARTICIPANT_ID,
      identityKey: IDENTITY,
      browserSessionId: null,
    });
    expect(found?.resumableCredentialHash).toEqual(credentialHash);
  });

  it('returns null for an unknown credential hash', async () => {
    await seedGame(client);
    await seedMembership(client, new Uint8Array([4, 5, 6]));
    expect(
      await repository().findMembershipByCredentialHash(GAME_ID, new Uint8Array([9])),
    ).toBeNull();
  });

  it('rotates a session hash and records the rotation time', async () => {
    const currentHash = new Uint8Array([1, 2, 3]);
    const nextHash = new Uint8Array([10, 11, 12]);
    const session = await repository().createBrowserSession({
      sessionIdHash: currentHash,
      accountOrGuestIdentity: IDENTITY,
      authorizationVersion: 1n,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    const rotated = await repository().rotateBrowserSession({
      sessionId: session.id,
      currentSessionIdHash: currentHash,
      nextSessionIdHash: nextHash,
      rotatedAt: new Date('2025-01-01T00:01:00.000Z'),
    });

    expect(rotated.sessionIdHash).toEqual(nextHash);
    expect(rotated.rotatedAt).toEqual(new Date('2025-01-01T00:01:00.000Z'));
    expect(await repository().findBrowserSessionByHash(currentHash)).toBeNull();
    expect(await repository().findBrowserSessionByHash(nextHash)).not.toBeNull();
  });

  it('rejects rotation when the current hash does not match', async () => {
    const session = await repository().createBrowserSession({
      sessionIdHash: new Uint8Array([1, 2, 3]),
      accountOrGuestIdentity: IDENTITY,
      authorizationVersion: 1n,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    await expect(
      repository().rotateBrowserSession({
        sessionId: session.id,
        currentSessionIdHash: new Uint8Array([9, 9]),
        nextSessionIdHash: new Uint8Array([10, 11, 12]),
        rotatedAt: new Date('2025-01-01T00:01:00.000Z'),
      }),
    ).rejects.toThrow(/Session rotation conflict/);
  });

  it('revokes a session and stays idempotent on a second revoke', async () => {
    const hash = new Uint8Array([1, 2, 3]);
    const session = await repository().createBrowserSession({
      sessionIdHash: hash,
      accountOrGuestIdentity: IDENTITY,
      authorizationVersion: 1n,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-02T00:00:00.000Z'),
    });

    await repository().revokeBrowserSession(session.id, new Date('2025-01-01T00:02:00.000Z'));
    await repository().revokeBrowserSession(session.id, new Date('2025-01-01T00:03:00.000Z'));

    const stored = await readSession(client, hash);
    expect(stored?.revoked_at).toEqual(new Date('2025-01-01T00:02:00.000Z'));
  });

  it('revokes all sessions of an identity without touching others', async () => {
    const create = async (identity: string, hash: Uint8Array) => {
      const session = await repository().createBrowserSession({
        sessionIdHash: hash,
        accountOrGuestIdentity: identity,
        authorizationVersion: 1n,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      });
      return session.id;
    };
    const [targetId, otherId] = [
      await create(IDENTITY, new Uint8Array([1])),
      await create('guest:other', new Uint8Array([2])),
    ];

    await repository().revokeAllBrowserSessions(IDENTITY, new Date('2025-01-01T00:04:00.000Z'));

    const [target, other] = [
      await readSession(client, new Uint8Array([1])),
      await readSession(client, new Uint8Array([2])),
    ];
    expect(target?.revoked_at).toEqual(new Date('2025-01-01T00:04:00.000Z'));
    expect(other?.revoked_at).toBeNull();
    expect(other?.id).toBe(otherId);
    expect(target?.id).toBe(targetId);
  });

  it('derives the authorization version from live sessions only', async () => {
    const create = async (identity: string, version: bigint, hash: Uint8Array) => {
      await repository().createBrowserSession({
        sessionIdHash: hash,
        accountOrGuestIdentity: identity,
        authorizationVersion: version,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        expiresAt: new Date('2025-01-02T00:00:00.000Z'),
      });
    };
    await create('guest:other', 9n, new Uint8Array([2]));

    expect(await repository().getAuthorizationVersion(IDENTITY)).toBe(0n);

    await create(IDENTITY, 3n, new Uint8Array([1]));
    await create(IDENTITY, 7n, new Uint8Array([3]));
    expect(await repository().getAuthorizationVersion(IDENTITY)).toBe(7n);

    const revoked = await repository().findBrowserSessionByHash(new Uint8Array([3]));
    await repository().revokeBrowserSession(revoked!.id, new Date('2025-01-01T00:05:00.000Z'));
    expect(await repository().getAuthorizationVersion(IDENTITY)).toBe(3n);
  });

  it('keeps unrelated identities isolated', async () => {
    await seedGame(client);
    await seedMembership(client, new Uint8Array([4, 5, 6]));

    const membership = await repository().findMembershipByCredentialHash(
      '00000000-0000-0000-0000-0000000000ff' as GameId,
      new Uint8Array([4, 5, 6]),
    );
    expect(membership).toBeNull();
  });
});
