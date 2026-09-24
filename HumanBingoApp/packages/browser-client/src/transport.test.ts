import {
  CompletionCategory,
  GameStatus,
  SquareStatus,
  type GameSnapshotDto,
  type OutboxEventId,
  type StateVersion,
} from '@human-bingo/domain';
import { describe, expect, it } from 'vitest';
import {
  GameSyncController,
  GameTransportError,
  HttpGameTransport,
  SynchronizationRequiredError,
} from './transport.js';

const gameId = 'game-transport' as GameSnapshotDto['game']['id'];
const timestamp = '2025-01-01T00:00:00.000Z' as GameSnapshotDto['game']['createdAt'];

function snapshot(version: number): GameSnapshotDto {
  const stateVersion = version as StateVersion;
  return {
    game: {
      id: gameId,
      name: 'Transport game',
      status: GameStatus.Active,
      distinctTaskCount: 25,
      taskBagLocked: true,
      stateVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    tasks: [],
    membership: {
      id: 'membership-transport' as GameSnapshotDto['membership']['id'],
      gameId,
      participantId: 'participant-transport' as GameSnapshotDto['participant']['id'],
      createdAt: timestamp,
      lastSeenAt: timestamp,
    },
    participant: {
      id: 'participant-transport' as GameSnapshotDto['participant']['id'],
      displayName: 'Transport player',
      joinedAt: timestamp,
    },
    profile: {
      id: 'profile-transport' as GameSnapshotDto['profile']['id'],
      participantId: 'participant-transport' as GameSnapshotDto['participant']['id'],
      displayName: 'Transport player',
      playerCode: 'TRN123' as GameSnapshotDto['profile']['playerCode'],
      createdAt: timestamp,
    },
    grid: {
      id: 'grid-transport' as GameSnapshotDto['grid']['id'],
      gameId,
      participantId: 'participant-transport' as GameSnapshotDto['participant']['id'],
      squares: [
        {
          gridId: 'grid-transport' as GameSnapshotDto['grid']['id'],
          squareIndex: 0,
          row: 1,
          column: 1,
          taskEntryId: 'task-transport' as GameSnapshotDto['tasks'][number]['id'],
          taskText: 'A task',
          status: SquareStatus.Unverified,
          updatedAt: timestamp,
        },
      ],
      taskBagVersion: stateVersion,
      stateVersion,
      createdAt: timestamp,
    },
    verificationRequests: [],
    notifications: [],
    leaderboards: {
      blackout: { category: CompletionCategory.Blackout, totalCompletions: 0, entries: [] },
      line: { category: CompletionCategory.Line, entries: [] },
      hashtag: { category: CompletionCategory.Hashtag, totalCompletions: 0, entries: [] },
    },
    stateVersion,
  };
}

describe('HttpGameTransport', () => {
  it('loads a wrapped snapshot with the current version query', async () => {
    let requestUrl = '';
    const transport = new HttpGameTransport((input) => {
      requestUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(Response.json({ snapshot: snapshot(4) }));
    });

    const result = await transport.loadSnapshot(gameId, 3 as StateVersion);

    expect(requestUrl).toBe('/api/games/game-transport/snapshot?since_version=3');
    expect(result.stateVersion).toBe(4);
  });

  it('maps typed API failures without leaking response details', async () => {
    const transport = new HttpGameTransport(() =>
      Promise.resolve(
        Response.json(
          { error: { code: 'SYNC_FAILED', message: 'Temporary failure', retryable: true } },
          { status: 503 },
        ),
      ),
    );

    await expect(transport.loadSnapshot(gameId)).rejects.toMatchObject({
      code: 'SYNC_FAILED',
      retryable: true,
      httpStatus: 503,
    });
  });
});

describe('GameSyncController', () => {
  it('loads the initial snapshot and refreshes after a version gap', async () => {
    const loadedVersions: Array<number | undefined> = [];
    const controller = new GameSyncController({
      gameId,
      loader: {
        loadSnapshot: (_id, sinceVersion) => {
          loadedVersions.push(sinceVersion === undefined ? undefined : Number(sinceVersion));
          return Promise.resolve(snapshot(sinceVersion === undefined ? 1 : 3));
        },
      },
    });

    await expect(controller.loadInitialSnapshot()).resolves.toBe(true);
    const result = await controller.handleRealtimeEvent({
      type: 'game.patch',
      gameId,
      stateVersion: 4 as StateVersion,
      previousStateVersion: 2 as StateVersion,
      eventId: 'event-gap' as OutboxEventId,
      changes: {},
    });

    expect(result).toEqual({ status: 'gap', synchronized: true });
    expect(loadedVersions).toEqual([undefined, 1]);
    expect(controller.view?.stateVersion).toBe(3);
    expect(controller.controls.canSubmitStateDependentActions).toBe(true);
  });

  it('refreshes after a stale command and tells the participant to retry', async () => {
    let nextVersion = 1;
    const controller = new GameSyncController({
      gameId,
      loader: { loadSnapshot: () => Promise.resolve(snapshot(nextVersion++)) },
    });
    await controller.loadInitialSnapshot();

    await expect(
      controller.runStateDependent(() =>
        Promise.reject(Object.assign(new Error('stale'), { code: 'STALE_STATE' })),
      ),
    ).rejects.toMatchObject({ code: 'STALE_STATE' });

    expect(controller.view?.stateVersion).toBe(2);
    expect(controller.controls).toEqual({
      synchronized: true,
      canSubmitStateDependentActions: true,
      message: 'The game changed. Your state was refreshed; retry the action.',
    });
  });

  it('disables state-dependent actions and starts polling after synchronization fails', async () => {
    const controller = new GameSyncController({
      gameId,
      pollIntervalMs: 60_000,
      loader: {
        loadSnapshot: () => Promise.reject(new GameTransportError('offline', 'SYNC_FAILED', true)),
      },
    });

    await expect(controller.loadInitialSnapshot()).resolves.toBe(false);
    expect(controller.isPolling).toBe(true);
    expect(controller.controls.canSubmitStateDependentActions).toBe(false);
    expect(controller.controls.message).toContain('Synchronization failed');
    controller.stopPolling();
  });

  it('rejects state-dependent commands before an initial snapshot', async () => {
    const controller = new GameSyncController({
      gameId,
      loader: { loadSnapshot: () => Promise.resolve(snapshot(1)) },
    });

    await expect(
      controller.runStateDependent(() => Promise.resolve('not allowed')),
    ).rejects.toBeInstanceOf(SynchronizationRequiredError);
  });
});
