import { describe, expect, it } from 'vitest';
import {
  DomainErrorCode,
  GameStatus,
  type CorrelationId,
  type GameId,
  type OnboardParticipantCommand,
  type TaskEntryId,
} from '@human-bingo/domain';
import {
  InMemoryMembershipRepository,
  type GameRecord,
  type MembershipState,
  type TaskEntryRecord,
} from '@human-bingo/persistence';
import { GridService } from './grid.js';
import { MembershipService } from './membership.js';

const gameId = 'membership-game' as GameId;
const correlationId = 'membership-correlation' as CorrelationId;
const now = new Date('2025-01-01T00:00:00.000Z');

const makeState = (): MembershipState => {
  const game: GameRecord = {
    id: gameId,
    hostAccountId: 'host',
    name: 'Membership game',
    status: GameStatus.InvitationAvailable,
    taskBagLockedAt: null,
    closedAt: null,
    stateVersion: 3n,
    createdAt: now,
    updatedAt: now,
  };
  const tasks: TaskEntryRecord[] = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index}` as TaskEntryId,
    gameId,
    displayText: `Task ${index}`,
    normalizedText: `task ${index}`,
    createdAt: now,
    updatedAt: now,
    removedAt: null,
  }));
  return {
    game,
    tasks,
    grids: [],
    squares: [],
    participants: [],
    memberships: [],
    playerProfiles: [],
  };
};

const command = (identity: string, key: string): OnboardParticipantCommand => ({
  gameId,
  input: { joinCode: 'ABC123' as never },
  displayName: 'Ada',
  participantIdentity: identity,
  correlationId,
  idempotencyKey: key as never,
});

const serviceFor = (
  repository: InMemoryMembershipRepository,
  playerCodeFactory = () => 'PLAYER1',
) =>
  new MembershipService(
    repository,
    new GridService({
      // MembershipService uses the in-state entry point; this repository is not called by the grid service.
      withGridState: () => Promise.reject(new Error('unexpected standalone grid transaction')),
    }),
    {
      now: () => now,
      idFactory: (() => {
        let next = 0;
        return () => `id-${++next}`;
      })(),
      randomBytes: () => new Uint8Array([1, 2, 3, 4, 5, 6]),
      playerCodeFactory,
    },
  );

describe('MembershipService', () => {
  it('creates one membership/profile/grid and transitions the game to active', async () => {
    const repository = new InMemoryMembershipRepository({ states: [makeState()] });
    const service = serviceFor(repository);

    const first = await service.onboard(command('browser-one', 'join-one'));
    const storedAfterFirst = await repository.read(gameId);

    expect(first.onboarding.resumed).toBe(false);
    expect(first.onboarding.game.status).toBe(GameStatus.Active);
    expect(first.onboarding.profile.playerCode).toBe('PLAYER1');
    expect(storedAfterFirst.participants).toHaveLength(1);
    expect(storedAfterFirst.memberships).toHaveLength(1);
    expect(storedAfterFirst.memberships[0]?.browserSessionId).not.toBeNull();
    expect(storedAfterFirst.playerProfiles).toHaveLength(1);
    expect(storedAfterFirst.grids).toHaveLength(1);
    expect(storedAfterFirst.squares).toHaveLength(25);
  });

  it('resumes the existing identity without creating or regenerating records', async () => {
    const repository = new InMemoryMembershipRepository({ states: [makeState()] });
    const service = serviceFor(repository);

    const first = await service.onboard(command('browser-one', 'join-one'));
    const firstState = await repository.read(gameId);
    const resumed = await service.onboard({
      ...command('browser-one', 'join-two'),
      displayName: 'Changed name',
    });
    const secondState = await repository.read(gameId);

    expect(resumed.onboarding.resumed).toBe(true);
    expect(resumed.onboarding.profile.playerCode).toBe(first.onboarding.profile.playerCode);
    expect(resumed.onboarding.grid.squares.map((square) => square.taskEntryId)).toEqual(
      first.onboarding.grid.squares.map((square) => square.taskEntryId),
    );
    expect(secondState.participants).toHaveLength(1);
    expect(secondState.memberships).toHaveLength(1);
    expect(secondState.playerProfiles).toHaveLength(1);
    expect(secondState.grids).toHaveLength(1);
    expect(secondState.squares).toHaveLength(25);
    expect(secondState.memberships[0]?.lastSeenAt).toEqual(now);
    expect(firstState.memberships[0]?.id).toBe(secondState.memberships[0]?.id);
  });

  it('rolls back all staged rows when Player_Code generation exhausts its retry bound', async () => {
    const repository = new InMemoryMembershipRepository({ states: [makeState()] });
    const service = new MembershipService(
      repository,
      new GridService({
        withGridState: () => Promise.reject(new Error('unexpected standalone grid transaction')),
      }),
      {
        now: () => now,
        playerCodeFactory: () => '',
        maxPlayerCodeRetries: 3,
      },
    );

    await expect(service.onboard(command('browser-one', 'join-one'))).rejects.toMatchObject({
      code: DomainErrorCode.PlayerCodeGenerationFailed,
      retryable: true,
    });
    const stored = await repository.read(gameId);
    expect(stored.game.status).toBe(GameStatus.InvitationAvailable);
    expect(stored.game.taskBagLockedAt).toBeNull();
    expect(stored.participants).toHaveLength(0);
    expect(stored.memberships).toHaveLength(0);
    expect(stored.playerProfiles).toHaveLength(0);
    expect(stored.grids).toHaveLength(0);
    expect(stored.squares).toHaveLength(0);
  });

  it('rolls back all rows when session binding fails after grid creation', async () => {
    const repository = new InMemoryMembershipRepository({ states: [makeState()] });
    const service = new MembershipService(
      repository,
      new GridService({
        withGridState: () => Promise.reject(new Error('unexpected standalone grid transaction')),
      }),
      {
        now: () => now,
        sessionIssuer: {
          createResumableCredential: () => ({
            credential: 'credential',
            hash: new Uint8Array([1, 2, 3]),
          }),
          createMembershipSession: () => Promise.reject(new Error('session store unavailable')),
          bindMembershipSession: () => Promise.reject(new Error('session store unavailable')),
        },
      },
    );

    await expect(service.onboard(command('browser-one', 'join-one'))).rejects.toMatchObject({
      code: DomainErrorCode.OnboardingRetryable,
      retryable: true,
    });
    const stored = await repository.read(gameId);
    expect(stored.participants).toHaveLength(0);
    expect(stored.memberships).toHaveLength(0);
    expect(stored.playerProfiles).toHaveLength(0);
    expect(stored.grids).toHaveLength(0);
    expect(stored.squares).toHaveLength(0);
  });
});
