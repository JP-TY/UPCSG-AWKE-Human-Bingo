import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import type { GameId, ParticipantId, VerificationRequestId } from '@human-bingo/domain';
import {
  createTestPostgres,
  readDatabaseTestConfig,
  truncateDatabase,
  type TestPostgres,
} from '@human-bingo/test-utils';
import type { SqlClient } from '@human-bingo/persistence';
import { SqlAuthorizationRepository } from './sql-authorization-repository.js';

const GAME_ID = '00000000-0000-0000-0000-000000000001' as GameId;
const OTHER_GAME_ID = '00000000-0000-0000-0000-00000000000a' as GameId;
const HOST_PARTICIPANT_ID = '00000000-0000-0000-0000-000000000002' as ParticipantId;
const MEMBER_PARTICIPANT_ID = '00000000-0000-0000-0000-000000000003' as ParticipantId;
const VERIFICATION_REQUEST_ID = '00000000-0000-0000-0000-000000000004' as VerificationRequestId;
const IDENTITY = 'guest:integration-authorization';

const seedGame = async (client: SqlClient): Promise<void> => {
  await client.query(
    `INSERT INTO games (id, host_account_id, name, status)
     VALUES ($1, $2, $3, 'active')`,
    [GAME_ID, 'host-account', 'Integration game'],
  );
};

const seedMembership = async (
  client: SqlClient,
  participantId: string,
  credentialHash: Uint8Array,
): Promise<void> => {
  await client.query(`INSERT INTO participants (id, game_id) VALUES ($1, $2)`, [
    participantId,
    GAME_ID,
  ]);
  await client.query(
    `INSERT INTO memberships
       (id, game_id, participant_id, identity_key, resumable_credential_hash)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [GAME_ID, participantId, IDENTITY, credentialHash],
  );
};

const seedVerificationRequest = async (client: SqlClient): Promise<void> => {
  await client.query(`INSERT INTO participants (id, game_id) VALUES ($1, $2), ($3, $2)`, [
    HOST_PARTICIPANT_ID,
    GAME_ID,
    MEMBER_PARTICIPANT_ID,
  ]);
  await client.query(
    `INSERT INTO task_entries (id, game_id, display_text, normalized_text)
     VALUES ($1, $2, 'Write a test', 'write a test')`,
    ['00000000-0000-0000-0000-000000000005', GAME_ID],
  );
  await client.query(`INSERT INTO grids (id, game_id, participant_id) VALUES ($1, $2, $3)`, [
    '00000000-0000-0000-0000-000000000006',
    GAME_ID,
    MEMBER_PARTICIPANT_ID,
  ]);
  await client.query(
    `INSERT INTO squares (grid_id, game_id, square_index, task_entry_id)
     VALUES ($1, $2, 0, $3)`,
    ['00000000-0000-0000-0000-000000000006', GAME_ID, '00000000-0000-0000-0000-000000000005'],
  );
  await client.query(
    `INSERT INTO verification_requests
       (id, game_id, grid_id, square_index, requesting_participant_id,
        identified_participant_id, status, client_command_id)
     VALUES ($1, $2, $3, 0, $4, $5, 'pending', gen_random_uuid())`,
    [
      VERIFICATION_REQUEST_ID,
      GAME_ID,
      '00000000-0000-0000-0000-000000000006',
      HOST_PARTICIPANT_ID,
      MEMBER_PARTICIPANT_ID,
    ],
  );
};

const databaseConfigured = readDatabaseTestConfig().url !== undefined;

describe.skipIf(!databaseConfigured)('SqlAuthorizationRepository (PostgreSQL)', () => {
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

  const repository = (): SqlAuthorizationRepository => new SqlAuthorizationRepository(client);

  it('reads the game row for authorization', async () => {
    await seedGame(client);
    expect(await repository().findGame(GAME_ID)).toEqual({
      id: GAME_ID,
      hostAccountId: 'host-account',
      status: 'active',
    });
  });

  it('returns null when the game does not exist', async () => {
    expect(await repository().findGame(GAME_ID)).toBeNull();
  });

  it('finds the membership scoped by game and participant', async () => {
    await seedGame(client);
    await seedMembership(client, MEMBER_PARTICIPANT_ID, new Uint8Array([4, 5, 6]));

    const membership = await repository().findMembership(GAME_ID, MEMBER_PARTICIPANT_ID);
    expect(membership).toMatchObject({
      gameId: GAME_ID,
      participantId: MEMBER_PARTICIPANT_ID,
      identityKey: IDENTITY,
      browserSessionId: null,
    });
    expect(membership?.resumableCredentialHash).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('returns null when the participant is not in the game', async () => {
    await seedGame(client);
    await seedMembership(client, MEMBER_PARTICIPANT_ID, new Uint8Array([4, 5, 6]));
    expect(await repository().findMembership(GAME_ID, HOST_PARTICIPANT_ID)).toBeNull();
  });

  it('reads a verification request scoped by game and request id', async () => {
    await seedGame(client);
    await seedVerificationRequest(client);

    expect(await repository().findVerificationRequest(GAME_ID, VERIFICATION_REQUEST_ID)).toEqual({
      gameId: GAME_ID,
      identifiedParticipantId: MEMBER_PARTICIPANT_ID,
      status: 'pending',
    });
  });

  it('returns null when the verification request belongs to another game', async () => {
    await seedGame(client);
    await seedVerificationRequest(client);
    expect(
      await repository().findVerificationRequest(OTHER_GAME_ID, VERIFICATION_REQUEST_ID),
    ).toBeNull();
  });
});
