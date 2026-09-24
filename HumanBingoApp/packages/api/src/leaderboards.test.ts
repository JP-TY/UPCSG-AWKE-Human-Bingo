import { describe, expect, it } from 'vitest';
import {
  CompletionCategory,
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  SquareStatus,
  type CorrelationId,
  type CompletionId,
  type GameId,
  type ParticipantId,
} from '@human-bingo/domain';
import {
  emptyVerificationState,
  InMemoryVerificationRepository,
  type CompletionRecord,
  type GameRecord,
  type MembershipRecord,
  type ParticipantRecord,
  type PlayerProfileRecord,
} from '@human-bingo/persistence';
import {
  LeaderboardQueryService,
  projectLeaderboards,
  projectProgressLeaderboard,
} from './leaderboards.js';

const gameId = 'game-leaderboards' as GameId;
const firstParticipant = 'participant-z' as ParticipantId;
const secondParticipant = 'participant-a' as ParticipantId;
const createdAt = new Date('2025-01-01T00:00:00.000Z');

const game: GameRecord = {
  id: gameId,
  hostAccountId: 'host-1',
  name: 'Leaderboard game',
  status: GameStatus.Active,
  taskBagLockedAt: createdAt,
  closedAt: null,
  stateVersion: 9n,
  createdAt,
  updatedAt: createdAt,
};

const participants: ParticipantRecord[] = [
  { id: firstParticipant, gameId, createdAt, leftAt: null },
  { id: secondParticipant, gameId, createdAt, leftAt: null },
];

const memberships: MembershipRecord[] = participants.map((participant, index) => ({
  id: `membership-${index}` as MembershipRecord['id'],
  gameId,
  participantId: participant.id,
  browserSessionId: null,
  resumableCredentialHash: new Uint8Array([index + 1]),
  createdAt,
  lastSeenAt: createdAt,
}));

const profiles: PlayerProfileRecord[] = [
  {
    id: 'profile-z' as PlayerProfileRecord['id'],
    gameId,
    participantId: firstParticipant,
    displayName: 'Zed',
    playerCode: 'ZETA',
    createdAt,
  },
  {
    id: 'profile-a' as PlayerProfileRecord['id'],
    gameId,
    participantId: secondParticipant,
    displayName: 'Ada',
    playerCode: 'ALPHA',
    createdAt,
  },
];

function completion(
  id: string,
  participantId: ParticipantId,
  category: CompletionCategory,
  completionKey: CompletionRecord['completionKey'],
  completedAt: string,
): CompletionRecord {
  return {
    id: id as CompletionId,
    gameId,
    participantId,
    category,
    completionKey,
    completedAt: new Date(completedAt),
    createdAt: new Date(completedAt),
  };
}

describe('leaderboard projection', () => {
  it('keeps categories isolated, counts distinct keys, and applies deterministic ordering', () => {
    const state = emptyVerificationState({
      game,
      participants,
      memberships,
      profiles,
      completions: [
        completion(
          'line-z-late',
          firstParticipant,
          CompletionCategory.Line,
          'row:1',
          '2025-01-01T00:00:10.000Z',
        ),
        completion(
          'line-z-early',
          firstParticipant,
          CompletionCategory.Line,
          'row:1',
          '2025-01-01T00:00:05.000Z',
        ),
        completion(
          'line-z-second',
          firstParticipant,
          CompletionCategory.Line,
          'column:1',
          '2025-01-01T00:00:20.000Z',
        ),
        completion(
          'line-a',
          secondParticipant,
          CompletionCategory.Line,
          'row:1',
          '2025-01-01T00:00:05.000Z',
        ),
        completion(
          'blackout-z',
          firstParticipant,
          CompletionCategory.Blackout,
          'blackout',
          '2025-01-01T00:00:30.000Z',
        ),
        completion(
          'blackout-a',
          secondParticipant,
          CompletionCategory.Blackout,
          'blackout',
          '2025-01-01T00:00:20.000Z',
        ),
        completion(
          'hashtag-z',
          firstParticipant,
          CompletionCategory.Hashtag,
          'hashtag',
          '2025-01-01T00:00:40.000Z',
        ),
        completion(
          'hashtag-a',
          secondParticipant,
          CompletionCategory.Hashtag,
          'hashtag',
          '2025-01-01T00:00:35.000Z',
        ),
      ],
    });

    const leaderboards = projectLeaderboards(state);

    expect(leaderboards.blackout.totalCompletions).toBe(2);
    expect(leaderboards.blackout.entries.map((entry) => entry.participant.playerCode)).toEqual([
      'ALPHA',
      'ZETA',
    ]);
    expect(
      leaderboards.blackout.entries.every((entry) =>
        entry.completions.every((record) => record.category === CompletionCategory.Blackout),
      ),
    ).toBe(true);

    expect(leaderboards.line.entries.map((entry) => entry.participant.playerCode)).toEqual([
      'ZETA',
      'ALPHA',
    ]);
    expect(leaderboards.line.entries[0]?.completionCount).toBe(2);
    expect(leaderboards.line.entries[0]?.earliestCompletionAt).toBe('2025-01-01T00:00:05.000Z');
    expect(leaderboards.line.entries[0]?.completions).toHaveLength(2);
    expect(
      leaderboards.line.entries.every((entry) =>
        entry.completions.every((record) => record.category === CompletionCategory.Line),
      ),
    ).toBe(true);

    expect(leaderboards.hashtag.totalCompletions).toBe(2);
    expect(leaderboards.hashtag.entries.map((entry) => entry.participant.playerCode)).toEqual([
      'ALPHA',
      'ZETA',
    ]);
    expect(
      leaderboards.hashtag.entries.every((entry) =>
        entry.completions.every((record) => record.category === CompletionCategory.Hashtag),
      ),
    ).toBe(true);
  });

  it('returns explicit empty states for all categories', () => {
    const leaderboards = projectLeaderboards(
      emptyVerificationState({ game, participants, profiles }),
    );

    expect(leaderboards).toEqual({
      blackout: { category: CompletionCategory.Blackout, totalCompletions: 0, entries: [] },
      line: { category: CompletionCategory.Line, entries: [] },
      hashtag: { category: CompletionCategory.Hashtag, totalCompletions: 0, entries: [] },
    });
  });

  it('ranks active players by progress before any completion exists', () => {
    const statuses = Array.from({ length: 25 }, () => SquareStatus.Unverified);
    for (const squareIndex of [0, 1, 2, 3, 4]) statuses[squareIndex] = SquareStatus.Verified;
    const progress = projectProgressLeaderboard(
      emptyVerificationState({
        game,
        participants,
        memberships,
        profiles,
        grids: [{ id: 'grid-z', gameId, participantId: firstParticipant } as never],
        squares: statuses.map((status, squareIndex) =>
          ({ gridId: 'grid-z', squareIndex, status }) as never,
        ),
      }),
    );

    expect(progress.entries).toHaveLength(2);
    expect(progress.entries[0]).toMatchObject({
      participant: { playerCode: 'ZETA' },
      verifiedSquares: 5,
      qualifiedLines: 1,
      bestLine: 5,
    });
    expect(progress.entries[1]).toMatchObject({
      participant: { playerCode: 'ALPHA' },
      verifiedSquares: 0,
      bestLine: 0,
    });
  });
});

describe('LeaderboardQueryService', () => {
  it('returns the authoritative version for a member and rejects nonmembers without disclosure', async () => {
    const repository = new InMemoryVerificationRepository({
      states: [emptyVerificationState({ game, participants, memberships, profiles })],
    });
    const service = new LeaderboardQueryService(repository);
    const result = await service.getLeaderboards(
      {
        gameId,
        correlationId: 'correlation-1' as CorrelationId,
      },
      firstParticipant,
    );

    expect(result.stateVersion).toBe(9);
    expect(result.leaderboards.blackout.entries).toEqual([]);

    await expect(
      service.getLeaderboards(
        {
          gameId,
          correlationId: 'correlation-2' as CorrelationId,
        },
        'nonmember' as ParticipantId,
      ),
    ).rejects.toMatchObject({ code: DomainErrorCode.Forbidden });
    await expect(
      service.getLeaderboards(
        {
          gameId,
          correlationId: 'correlation-3' as CorrelationId,
        },
        'nonmember' as ParticipantId,
      ),
    ).rejects.toBeInstanceOf(HumanBingoError);
  });
});
