import { describe, expect, it } from 'vitest';
import { SquareStatus, type GameId } from '@human-bingo/domain';
import { overviewForHost } from './host-overview.js';

const gameId = 'game-a' as GameId;
const participantId = 'participant-a';
const now = new Date('2025-01-01T00:00:00.000Z');

describe('overviewForHost', () => {
  it('projects joined participants, progress, and standings from one game state', () => {
    const statuses = Array.from({ length: 25 }, () => SquareStatus.Unverified);
    for (const squareIndex of [0, 1, 2, 3, 4]) statuses[squareIndex] = SquareStatus.Verified;
    const state = {
      game: { id: gameId, stateVersion: 4n },
      participants: [
        { id: participantId, gameId, leftAt: null, createdAt: now },
      ],
      memberships: [
        { gameId, participantId, lastSeenAt: now },
      ],
      profiles: [
        { participantId, displayName: 'Ada', playerCode: 'ADA1' },
      ],
      grids: [{ id: 'grid-a', gameId, participantId }],
      squares: statuses.map((status, squareIndex) => ({
        gridId: 'grid-a',
        squareIndex,
        status,
      })),
      completions: [],
    } as never;

    const overview = overviewForHost(state);

    expect(overview.gameId).toBe(gameId);
    expect(overview.stateVersion).toBe(4);
    expect(overview.participants).toHaveLength(1);
    expect(overview.participants[0]).toMatchObject({
      participant: { displayName: 'Ada', playerCode: 'ADA1' },
      verifiedSquares: 5,
      qualifiedLines: 1,
      hashtagSquares: 2,
      bestLine: 5,
    });
    expect(overview.leaderboards.progress?.entries[0]).toMatchObject({
      participant: { displayName: 'Ada' },
      verifiedSquares: 5,
      qualifiedLines: 1,
      hashtagSquares: 2,
      bestLine: 5,
    });
    expect(overview.leaderboards.blackout.entries).toHaveLength(0);
  });

  it('does not include participants who have left the game', () => {
    const state = {
      game: { id: gameId, stateVersion: 1n },
      participants: [{ id: participantId, gameId, leftAt: now, createdAt: now }],
      memberships: [{ gameId, participantId, lastSeenAt: now }],
      profiles: [{ participantId, displayName: 'Ada', playerCode: 'ADA1' }],
      grids: [],
      squares: [],
      completions: [],
    } as never;

    expect(overviewForHost(state).participants).toEqual([]);
  });
});
