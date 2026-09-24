import {
  CompletionCategory,
  GameStatus,
  NotificationStatus,
  SquareStatus,
  type GamePatchDto,
  type GameSnapshotDto,
} from '@human-bingo/domain';
import { describe, expect, it } from 'vitest';
import { NormalizedGameCache } from './state.js';

const gameId = 'game-1' as GameSnapshotDto['game']['id'];
const gridId = 'grid-1' as GameSnapshotDto['grid']['id'];
const taskId = 'task-1' as GameSnapshotDto['tasks'][number]['id'];
const participantId = 'participant-1' as GameSnapshotDto['participant']['id'];
const timestamp = '2025-01-01T00:00:00.000Z' as GameSnapshotDto['game']['createdAt'];

function snapshot(stateVersion = 1): GameSnapshotDto {
  const task = {
    id: taskId,
    text: 'Find someone who likes tea',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const square = {
    gridId,
    squareIndex: 0,
    row: 1 as const,
    column: 1 as const,
    taskEntryId: taskId,
    taskText: task.text,
    status: SquareStatus.Unverified,
    updatedAt: timestamp,
  };
  return {
    game: {
      id: gameId,
      name: 'Test game',
      status: GameStatus.Active,
      distinctTaskCount: 25,
      taskBagLocked: true,
      stateVersion: stateVersion as GameSnapshotDto['game']['stateVersion'],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    tasks: [task],
    membership: {
      id: 'membership-1' as GameSnapshotDto['membership']['id'],
      gameId,
      participantId,
      createdAt: timestamp,
      lastSeenAt: timestamp,
    },
    participant: { id: participantId, displayName: 'Player One', joinedAt: timestamp },
    profile: {
      id: 'profile-1' as GameSnapshotDto['profile']['id'],
      participantId,
      displayName: 'Player One',
      playerCode: 'ABC123' as GameSnapshotDto['profile']['playerCode'],
      createdAt: timestamp,
    },
    grid: {
      id: gridId,
      gameId,
      participantId,
      squares: [square],
      taskBagVersion: stateVersion as GameSnapshotDto['grid']['taskBagVersion'],
      stateVersion: stateVersion as GameSnapshotDto['grid']['stateVersion'],
      createdAt: timestamp,
    },
    verificationRequests: [],
    notifications: [],
    leaderboards: {
      blackout: { category: CompletionCategory.Blackout, totalCompletions: 0, entries: [] },
      line: { category: CompletionCategory.Line, entries: [] },
      hashtag: { category: CompletionCategory.Hashtag, totalCompletions: 0, entries: [] },
    },
    stateVersion: stateVersion as GameSnapshotDto['stateVersion'],
  };
}

function patch(stateVersion: number, previousStateVersion: number, eventId: string): GamePatchDto {
  return {
    type: 'game.patch',
    gameId,
    stateVersion: stateVersion as GamePatchDto['stateVersion'],
    previousStateVersion: previousStateVersion as GamePatchDto['previousStateVersion'],
    eventId: eventId as GamePatchDto['eventId'],
    changes: {
      squares: [
        {
          ...snapshot().grid.squares[0]!,
          status: SquareStatus.Verified,
          updatedAt: '2025-01-01T00:00:01.000Z' as GameSnapshotDto['game']['updatedAt'],
        },
      ],
      notifications: [
        {
          id: 'notification-1' as GameSnapshotDto['notifications'][number]['id'],
          gameId,
          recipientParticipantId: participantId,
          verificationRequestId:
            'request-1' as GameSnapshotDto['verificationRequests'][number]['id'],
          kind: 'verification_request',
          status: NotificationStatus.Pending,
          gameName: 'Test game',
          requestingParticipant: {
            participantId,
            displayName: 'Player One',
            playerCode: 'ABC123' as GameSnapshotDto['profile']['playerCode'],
          },
          taskText: 'Find someone who likes tea',
          createdAt: timestamp,
        },
      ],
    },
  };
}

describe('NormalizedGameCache', () => {
  it('replaces only records named by a sequential patch', () => {
    const cache = new NormalizedGameCache(gameId);
    const initial = cache.replaceSnapshot(snapshot());

    const result = cache.applyPatch(patch(2, 1, 'event-1'));

    expect(result.status).toBe('applied');
    expect(result.view.stateVersion).toBe(2);
    expect(result.view.tasks).toBe(initial.tasks);
    expect(result.view.verificationRequests).toBe(initial.verificationRequests);
    expect(result.view.squares.get(`${gridId}:0`)?.status).toBe(SquareStatus.Verified);
    expect(
      result.view.notifications.has(
        'notification-1' as GameSnapshotDto['notifications'][number]['id'],
      ),
    ).toBe(true);
    expect(result.view.lastEventId).toBe('event-1');
  });

  it('deduplicates events and marks a version gap unsynchronized without mutating records', () => {
    const cache = new NormalizedGameCache(gameId);
    cache.replaceSnapshot(snapshot());
    const duplicate = cache.applyPatch(patch(2, 1, 'event-1'));
    const repeated = cache.applyPatch(patch(2, 1, 'event-1'));
    const gap = cache.applyPatch(patch(4, 3, 'event-4'));

    expect(duplicate.status).toBe('applied');
    expect(repeated.status).toBe('duplicate');
    expect(gap.status).toBe('gap');
    expect(cache.current?.stateVersion).toBe(2);
    expect(cache.synchronization).toEqual({
      status: 'unsynchronized',
      stateVersion: 2,
      error: 'SYNC_REQUIRED',
    });
    expect(cache.current?.squares.get(`${gridId}:0`)?.status).toBe(SquareStatus.Verified);
  });

  it('replaces the normalized cache with a complete authoritative snapshot', () => {
    const cache = new NormalizedGameCache(gameId);
    cache.replaceSnapshot(snapshot());
    cache.applyPatch(patch(2, 1, 'event-1'));

    const restored = cache.replaceSnapshot(snapshot(7));

    expect(restored.stateVersion).toBe(7);
    expect(restored.squares.get(`${gridId}:0`)?.status).toBe(SquareStatus.Unverified);
    expect(restored.notifications.size).toBe(0);
    expect(cache.toSnapshot()?.grid.squares).toHaveLength(1);
  });

  it('does not apply a patch for another game', () => {
    const cache = new NormalizedGameCache(gameId);
    cache.replaceSnapshot(snapshot());
    const foreign = { ...patch(2, 1, 'event-foreign'), gameId: 'other-game' } as GamePatchDto;

    expect(cache.applyPatch(foreign).status).toBe('ignored');
    expect(cache.current?.stateVersion).toBe(1);
  });
});
