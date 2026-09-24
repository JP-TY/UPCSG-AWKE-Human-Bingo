import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CorrelationId,
  GameId,
  IdempotencyKey,
  InvitationInput,
  OnboardParticipantCommand,
} from '@human-bingo/domain';
import {
  SqlGridRepository,
  SqlInvitationRepository,
  SqlMembershipRepository,
} from '@human-bingo/persistence';
import {
  createTestPostgres,
  readDatabaseTestConfig,
  truncateDatabase,
  type TestPostgres,
} from '@human-bingo/test-utils';
import type { PoolClient } from 'pg';

import { SessionService } from './access/session-service.js';
import { SqlAccessRepository } from './access/sql-access-repository.js';
import { GridService } from './grid.js';
import { InvitationService, tokenFromCanonicalLink } from './invitation.js';
import { MembershipService } from './membership.js';

const CORRELATION_ID = 'onboarding-regression' as CorrelationId;
const SECRET = 'integration-secret-0123456789abcdef0123456789abcdef';

const database = readDatabaseTestConfig();

describe.skipIf(!database.enabled || database.url === undefined)('real-stack onboarding', () => {
  let postgres: TestPostgres | undefined;
  let client: PoolClient | undefined;

  beforeAll(async () => {
    postgres = createTestPostgres();
    client = await postgres.pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await postgres?.close();
  });

  const db = (): PoolClient => client!;
  const access = (): SqlAccessRepository => new SqlAccessRepository(db());
  const membershipStore = (): SqlMembershipRepository => new SqlMembershipRepository(db());
  const invitationStore = (): SqlInvitationRepository => new SqlInvitationRepository(db());

  const seedJoinableGame = async (): Promise<GameId> => {
    const game = await db().query<{ id: string }>(
      `INSERT INTO games (host_account_id, name, status)
       VALUES ($1, $2, 'invitation_available')
       RETURNING id`,
      ['integration-host', 'Onboarding Bingo'],
    );
    const gameId = game.rows[0]?.id;
    if (gameId === undefined) throw new Error('seed game failed');
    for (let index = 0; index < 25; index += 1) {
      await db().query(
        `INSERT INTO task_entries (game_id, display_text, normalized_text)
         VALUES ($1, $2, $3)`,
        [gameId, `Task ${index + 1}`, `task ${index + 1}`],
      );
    }
    return gameId as GameId;
  };

  it('commits the membership and binds its session in one flow', async () => {
    await truncateDatabase(db());

    const gameId = await seedJoinableGame();

    const sessions = new SessionService(access(), {
      secret: SECRET,
    });
    const invitations = new InvitationService(invitationStore(), {
      canonicalBaseUrl: 'https://fallback.example',
    });
    const invited = await invitations.create(
      { gameId, correlationId: CORRELATION_ID, idempotencyKey: 'invite-1' as IdempotencyKey },
      { canonicalBaseUrl: 'https://bingo.example' },
    );
    expect(invited.invitation.canonicalLink).toMatch(
      /^https:\/\/bingo\.example\/invite\/[A-Za-z0-9_-]+$/,
    );

    const membership = new MembershipService(membershipStore(), new GridService(new SqlGridRepository(db())), {
      sessionIssuer: sessions,
      assertInvitationUsable: (input) => invitations.assertUsableForOnboarding(input),
    });

    const input: InvitationInput = { token: tokenFromCanonicalLink(invited.invitation.canonicalLink) };
    const command = (displayName: string, idempotencyKey: string): OnboardParticipantCommand => ({
      gameId,
      input,
      displayName,
      correlationId: CORRELATION_ID,
      idempotencyKey: idempotencyKey as IdempotencyKey,
    });

    const first = await membership.onboard(command('Ada Lovelace', 'join-ada'));
    expect(first.access).toBeDefined();
    const firstAccess = first.access!;
    expect(firstAccess.membership.id).toBeDefined();

    const stored = await membershipStore().read(gameId);
    expect(stored.memberships).toHaveLength(1);
    expect(stored.memberships[0]?.browserSessionId).toBe(firstAccess.session.id);
    expect(stored.participants).toHaveLength(1);
    expect(stored.playerProfiles[0]?.displayName).toBe('Ada Lovelace');
    expect(stored.squares.filter((square) => square.gridId === stored.grids[0]?.id)).toHaveLength(
      25,
    );

    const bound = await access().findMembershipByBrowserSessionId(firstAccess.session.id);
    expect(bound?.gameId).toBe(gameId);
    expect(bound?.participantId).toBe(stored.participants[0]?.id);

    await expect(
      sessions.authenticateSession(firstAccess.sessionCredential),
    ).resolves.toMatchObject({ session: { id: firstAccess.session.id } });

    const second = await membership.onboard(command('Grace Hopper', 'join-grace'));
    expect(second.access).toBeDefined();
    const secondAccess = second.access!;
    expect(secondAccess.membership.id).not.toBe(firstAccess.membership.id);
    const afterSecond = await membershipStore().read(gameId);
    expect(afterSecond.memberships).toHaveLength(2);
    expect(afterSecond.participants).toHaveLength(2);
    expect(
      afterSecond.memberships.find((item) => item.id === secondAccess.membership.id)
        ?.browserSessionId,
    ).toBe(secondAccess.session.id);
  });
});