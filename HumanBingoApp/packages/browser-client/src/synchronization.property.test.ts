import fc from 'fast-check';
import {
  CompletionCategory,
  DomainErrorCode,
  GameStatus,
  NotificationStatus,
  SquareStatus,
  type GamePatchDto,
  type GameSnapshotDto,
  type RealtimeEvent,
  type StateVersion,
} from '@human-bingo/domain';
import { readPropertyTestOptions } from '@human-bingo/test-utils';
import { describe, expect, it } from 'vitest';
import { NormalizedGameCache } from './state.js';
import {
  GameSyncController,
  GameTransportError,
  SynchronizationRequiredError,
} from './transport.js';

type ChangeKind = 'tasks' | 'squares' | 'notifications' | 'leaderboards';
type RecoveryKind = 'snapshot_required' | 'gap';

interface SynchronizationScenario {
  readonly baseVersion: number;
  readonly changeKind: ChangeKind;
  readonly squareStatus: SquareStatus;
  readonly recoveryKind: RecoveryKind;
}

const scenarioArbitrary: fc.Arbitrary<SynchronizationScenario> = fc.record({
  baseVersion: fc.integer({ min: 1, max: 10_000 }),
  changeKind: fc.constantFrom<ChangeKind>('tasks', 'squares', 'notifications', 'leaderboards'),
  squareStatus: fc.constantFrom(SquareStatus.Pending, SquareStatus.Rejected, SquareStatus.Verified),
  recoveryKind: fc.constantFrom<RecoveryKind>('snapshot_required', 'gap'),
});

const gameId = 'property-game' as GameSnapshotDto['game']['id'];
const gridId = 'property-grid' as GameSnapshotDto['grid']['id'];
const taskId = 'property-task' as GameSnapshotDto['tasks'][number]['id'];
const participantId = 'property-participant' as GameSnapshotDto['participant']['id'];
const timestamp = '2025-01-01T00:00:00.000Z' as GameSnapshotDto['game']['createdAt'];

function snapshot(
  version: number,
  squareStatus: SquareStatus = SquareStatus.Unverified,
  notificationStatus: NotificationStatus = NotificationStatus.Pending,
): GameSnapshotDto {
  const stateVersion = version as StateVersion;
  const taskText = `Task at version ${version}`;
  const task = {
    id: taskId,
    text: taskText,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const notification = {
    id: 'property-notification' as GameSnapshotDto['notifications'][number]['id'],
    gameId,
    recipientParticipantId: participantId,
    verificationRequestId:
      'property-request' as GameSnapshotDto['verificationRequests'][number]['id'],
    kind: 'verification_request' as const,
    status: notificationStatus,
    gameName: 'Property game',
    requestingParticipant: {
      participantId,
      displayName: 'Property player',
      playerCode: 'PRP123' as GameSnapshotDto['profile']['playerCode'],
    },
    taskText,
    createdAt: timestamp,
    ...(notificationStatus === NotificationStatus.Resolved
      ? { resolvedAt: '2025-01-01T00:00:01.000Z' as GameSnapshotDto['game']['createdAt'] }
      : {}),
  };
  const square = {
    gridId,
    squareIndex: 0,
    row: 1 as const,
    column: 1 as const,
    taskEntryId: taskId,
    taskText,
    status: squareStatus,
    updatedAt: timestamp,
  };

  return {
    game: {
      id: gameId,
      name: 'Property game',
      status: GameStatus.Active,
      distinctTaskCount: 25,
      taskBagLocked: true,
      stateVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    tasks: [task],
    membership: {
      id: 'property-membership' as GameSnapshotDto['membership']['id'],
      gameId,
      participantId,
      createdAt: timestamp,
      lastSeenAt: timestamp,
    },
    participant: { id: participantId, displayName: 'Property player', joinedAt: timestamp },
    profile: {
      id: 'property-profile' as GameSnapshotDto['profile']['id'],
      participantId,
      displayName: 'Property player',
      playerCode: 'PRP123' as GameSnapshotDto['profile']['playerCode'],
      createdAt: timestamp,
    },
    grid: {
      id: gridId,
      gameId,
      participantId,
      squares: [square],
      taskBagVersion: stateVersion,
      stateVersion,
      createdAt: timestamp,
    },
    verificationRequests: [],
    notifications: [notification],
    leaderboards: {
      blackout: { category: CompletionCategory.Blackout, totalCompletions: 0, entries: [] },
      line: { category: CompletionCategory.Line, entries: [] },
      hashtag: { category: CompletionCategory.Hashtag, totalCompletions: 0, entries: [] },
    },
    stateVersion,
  };
}

function patchFor(
  scenario: SynchronizationScenario,
  stateVersion: number,
  previousStateVersion: number,
  eventId: string,
): GamePatchDto {
  const next = snapshot(stateVersion, scenario.squareStatus, NotificationStatus.Resolved);
  const changes: GamePatchDto['changes'] =
    scenario.changeKind === 'tasks'
      ? { tasks: next.tasks }
      : scenario.changeKind === 'squares'
        ? { squares: next.grid.squares }
        : scenario.changeKind === 'notifications'
          ? { notifications: next.notifications }
          : {
              leaderboards: {
                blackout: {
                  ...next.leaderboards.blackout,
                  totalCompletions: 1,
                },
              },
            };
  return {
    type: 'game.patch',
    gameId,
    stateVersion: stateVersion as StateVersion,
    previousStateVersion: previousStateVersion as StateVersion,
    eventId: eventId as GamePatchDto['eventId'],
    changes,
  };
}

describe('Property 8: versioned patch and stale-command safety', () => {
  it('keeps partial patches selective and blocks stale, duplicate, out-of-order, reconnect, and failed-sync state', async () => {
    // Feature: human-bingo, Property 8: Versioned patch and stale-command safety
    // **Validates: Requirements 7.2-7.4, 7.6, 11.2**
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const initialSnapshot = snapshot(scenario.baseVersion);
        const cache = new NormalizedGameCache(gameId);
        const initial = cache.replaceSnapshot(initialSnapshot);
        const sequentialPatch = patchFor(
          scenario,
          scenario.baseVersion + 1,
          scenario.baseVersion,
          'property-sequential',
        );
        const applied = cache.applyPatch(sequentialPatch);

        expect(applied.status).toBe('applied');
        expect(applied.view.stateVersion).toBe(scenario.baseVersion + 1);
        if (scenario.changeKind === 'tasks') {
          expect(applied.view.tasks.get(taskId)?.text).toBe(
            `Task at version ${scenario.baseVersion + 1}`,
          );
          expect(applied.view.squares).toBe(initial.squares);
          expect(applied.view.notifications).toBe(initial.notifications);
          expect(applied.view.leaderboards).toBe(initial.leaderboards);
        } else if (scenario.changeKind === 'squares') {
          expect(applied.view.squares.get(`${gridId}:0`)?.status).toBe(scenario.squareStatus);
          expect(applied.view.tasks).toBe(initial.tasks);
          expect(applied.view.notifications).toBe(initial.notifications);
          expect(applied.view.leaderboards).toBe(initial.leaderboards);
        } else if (scenario.changeKind === 'notifications') {
          expect(
            applied.view.notifications.get(
              'property-notification' as GameSnapshotDto['notifications'][number]['id'],
            )?.status,
          ).toBe(NotificationStatus.Resolved);
          expect(applied.view.tasks).toBe(initial.tasks);
          expect(applied.view.squares).toBe(initial.squares);
          expect(applied.view.leaderboards).toBe(initial.leaderboards);
        } else {
          expect(applied.view.leaderboards.blackout.totalCompletions).toBe(1);
          expect(applied.view.tasks).toBe(initial.tasks);
          expect(applied.view.squares).toBe(initial.squares);
          expect(applied.view.notifications).toBe(initial.notifications);
        }

        const duplicate = cache.applyPatch(sequentialPatch);
        expect(duplicate.status).toBe('duplicate');
        expect(duplicate.view.stateVersion).toBe(scenario.baseVersion + 1);

        const beforeOutOfOrder = cache.current;
        if (beforeOutOfOrder === null) throw new Error('Expected a normalized snapshot.');
        const outOfOrder = cache.applyPatch(
          patchFor(
            scenario,
            scenario.baseVersion + 3,
            scenario.baseVersion + 2,
            'property-out-of-order',
          ),
        );
        expect(outOfOrder.status).toBe('gap');
        expect(outOfOrder.view.stateVersion).toBe(scenario.baseVersion + 1);
        expect(outOfOrder.view.squares).toBe(beforeOutOfOrder.squares);
        expect(outOfOrder.view.tasks).toBe(beforeOutOfOrder.tasks);
        expect(outOfOrder.view.notifications).toBe(beforeOutOfOrder.notifications);
        expect(outOfOrder.view.leaderboards).toBe(beforeOutOfOrder.leaderboards);
        expect(outOfOrder.view.sync).toEqual({
          status: 'unsynchronized',
          stateVersion: scenario.baseVersion + 1,
          error: DomainErrorCode.SyncRequired,
        });

        const recovered = cache.replaceSnapshot(snapshot(scenario.baseVersion + 3));
        expect(recovered.sync).toEqual({
          status: 'synchronized',
          stateVersion: scenario.baseVersion + 3,
        });

        let successfulLoads = 0;
        const loadedSince: Array<number | undefined> = [];
        const controller = new GameSyncController({
          gameId,
          loader: {
            loadSnapshot: (_id, sinceVersion) => {
              loadedSince.push(sinceVersion === undefined ? undefined : Number(sinceVersion));
              const versions = [
                scenario.baseVersion,
                scenario.baseVersion + 2,
                scenario.baseVersion + 3,
                scenario.baseVersion + 4,
              ];
              const loadedVersion = versions[successfulLoads] ?? scenario.baseVersion + 4;
              successfulLoads += 1;
              return Promise.resolve(snapshot(loadedVersion));
            },
          },
        });

        await expect(controller.loadInitialSnapshot()).resolves.toBe(true);
        expect(controller.controls.canSubmitStateDependentActions).toBe(true);

        const recoveryEvent: RealtimeEvent =
          scenario.recoveryKind === 'snapshot_required'
            ? {
                type: 'snapshot_required',
                gameId,
                expectedStateVersion: (scenario.baseVersion + 1) as StateVersion,
                reason: 'version_gap',
              }
            : patchFor(
                scenario,
                scenario.baseVersion + 2,
                scenario.baseVersion + 1,
                'property-controller-gap',
              );
        const recoveryResult = await controller.handleRealtimeEvent(recoveryEvent);
        expect(recoveryResult).toEqual({
          status: scenario.recoveryKind,
          synchronized: true,
        });
        expect(controller.view?.stateVersion).toBe(scenario.baseVersion + 2);
        expect(controller.controls.canSubmitStateDependentActions).toBe(true);
        expect(loadedSince.slice(0, 2)).toEqual([undefined, scenario.baseVersion]);

        controller.handleRealtimeDisconnect();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        controller.stopPolling();
        expect(controller.controls.canSubmitStateDependentActions).toBe(true);
        expect(controller.view?.stateVersion).toBe(scenario.baseVersion + 3);

        const commandVersion = controller.view?.stateVersion;
        await expect(
          controller.runStateDependent(() => {
            throw Object.assign(new Error('authoritative state changed'), {
              code: DomainErrorCode.StaleState,
            });
          }),
        ).rejects.toMatchObject({ code: DomainErrorCode.StaleState });
        expect(commandVersion).toBe(scenario.baseVersion + 3);
        expect(controller.view?.stateVersion).toBe(scenario.baseVersion + 4);
        expect(controller.controls).toEqual({
          synchronized: true,
          canSubmitStateDependentActions: true,
          message: 'The game changed. Your state was refreshed; retry the action.',
        });
        expect(loadedSince).toContain(scenario.baseVersion + 3);

        let shouldFail = true;
        const failureController = new GameSyncController({
          gameId,
          pollIntervalMs: 60_000,
          loader: {
            loadSnapshot: () =>
              shouldFail
                ? Promise.reject(new GameTransportError('offline', 'SYNC_FAILED', true))
                : Promise.resolve(snapshot(scenario.baseVersion + 5)),
          },
        });
        await expect(failureController.loadInitialSnapshot()).resolves.toBe(false);
        expect(failureController.controls.canSubmitStateDependentActions).toBe(false);
        expect(failureController.controls.message).toContain('Synchronization failed');
        await expect(
          failureController.runStateDependent(() => Promise.resolve('must-not-run')),
        ).rejects.toBeInstanceOf(SynchronizationRequiredError);
        failureController.stopPolling();
        shouldFail = false;
        await expect(failureController.reconnect()).resolves.toBe(true);
        expect(failureController.controls).toEqual({
          synchronized: true,
          canSubmitStateDependentActions: true,
        });
      }),
      readPropertyTestOptions(),
    );
  });
});
