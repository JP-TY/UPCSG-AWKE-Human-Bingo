import { describe, expect, it } from 'vitest';
import type { GameId, GameStatus, ParticipantId, VerificationRequestId } from '@human-bingo/domain';
import type { MembershipRecord } from '@human-bingo/persistence';
import type { SqlClient, SqlResult } from '@human-bingo/persistence';
import { SqlAuthorizationRepository } from './sql-authorization-repository.js';

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

const gameRow = {
  id: '00000000-0000-0000-0000-000000000001' as GameId,
  host_account_id: 'host-account',
  status: 'active' as GameStatus,
};

const membershipRow = {
  id: '00000000-0000-0000-0000-0000000000cd' as MembershipRecord['id'],
  game_id: gameRow.id,
  participant_id: '00000000-0000-0000-0000-0000000000ef' as ParticipantId,
  identity_key: 'guest:abc',
  browser_session_id: null,
  resumable_credential_hash: new Uint8Array([4, 5, 6]),
  created_at: '2025-01-01T00:00:00.000Z',
  last_seen_at: '2025-01-01T00:00:00.000Z',
};

const verificationRow = {
  game_id: gameRow.id,
  identified_participant_id: membershipRow.participant_id,
  status: 'pending' as const,
};

describe('SqlAuthorizationRepository', () => {
  it('reads the game row for authorization', async () => {
    const client = new QueueClient([{ rows: [gameRow] }]);
    const game = await new SqlAuthorizationRepository(client).findGame(gameRow.id);

    expect(game).toEqual({
      id: gameRow.id,
      hostAccountId: 'host-account',
      status: 'active',
    });
    expect(client.calls[0]?.values).toEqual([gameRow.id]);
  });

  it('returns null when the game does not exist', async () => {
    const client = new QueueClient();
    expect(await new SqlAuthorizationRepository(client).findGame(gameRow.id)).toBe(null);
  });

  it('finds the membership scoped by game and participant', async () => {
    const client = new QueueClient([{ rows: [membershipRow] }]);
    const membership = await new SqlAuthorizationRepository(client).findMembership(
      gameRow.id,
      membershipRow.participant_id,
    );

    expect(membership).toMatchObject<Partial<MembershipRecord>>({
      id: membershipRow.id,
      gameId: gameRow.id,
      participantId: membershipRow.participant_id,
      identityKey: 'guest:abc',
      browserSessionId: null,
    });
    expect(membership?.resumableCredentialHash).toEqual(new Uint8Array([4, 5, 6]));
    expect(client.calls[0]?.values).toEqual([gameRow.id, membershipRow.participant_id]);
  });

  it('returns null when the membership does not exist', async () => {
    const client = new QueueClient();
    expect(
      await new SqlAuthorizationRepository(client).findMembership(
        gameRow.id,
        membershipRow.participant_id,
      ),
    ).toBe(null);
  });

  it('reads a verification request scoped by game and request id', async () => {
    const client = new QueueClient([{ rows: [verificationRow] }]);
    const verificationRequestId = '00000000-0000-0000-0000-0000000000ff' as VerificationRequestId;
    const request = await new SqlAuthorizationRepository(client).findVerificationRequest(
      gameRow.id,
      verificationRequestId,
    );

    expect(request).toEqual({
      gameId: gameRow.id,
      identifiedParticipantId: membershipRow.participant_id,
      status: 'pending',
    });
    expect(client.calls[0]?.values).toEqual([gameRow.id, verificationRequestId]);
  });

  it('returns null when the verification request is not in this game', async () => {
    const client = new QueueClient();
    expect(
      await new SqlAuthorizationRepository(client).findVerificationRequest(
        gameRow.id,
        '00000000-0000-0000-0000-0000000000ff' as VerificationRequestId,
      ),
    ).toBe(null);
  });
});
