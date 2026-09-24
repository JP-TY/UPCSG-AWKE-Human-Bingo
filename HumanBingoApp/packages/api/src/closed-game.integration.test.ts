import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CompletionCategory,
  DomainErrorCode,
  GameStatus,
  NotificationStatus,
  SquareStatus,
  VerificationRequestStatus,
  type AddTaskEntryCommand,
  type CloseGameCommand,
  type CorrelationId,
  type CreateGameCommand,
  type EditTaskEntryCommand,
  type GameId,
  type IdempotencyKey,
  type PlayerCode,
  type RemoveTaskEntryCommand,
  type RequestVerificationCommand,
  type RespondToVerificationCommand,
  type StateVersion,
} from '@human-bingo/domain';
import {
  emptyVerificationState,
  InMemoryGameConfigurationRepository,
  InMemoryGridRepository,
  InMemoryVerificationRepository,
  type CompletionRecord,
  type GameRecord,
  type GridRecord,
  type MembershipRecord,
  type NotificationRecord,
  type ParticipantRecord,
  type PlayerProfileRecord,
  type SquareRecord,
  type TaskEntryRecord,
  type VerificationState,
} from '@human-bingo/persistence';
import { readPropertyTestOptions } from '@human-bingo/test-utils';

import { GameConfigurationService } from './game-configuration.js';
import { GridService } from './grid.js';
import { VerificationCompletionService } from './verification.js';

const NOW = new Date('2025-01-01T00:00:00.000Z');
const CORRELATION_ID = 'property-13' as CorrelationId;
const HOST_ACCOUNT = 'property-13-host';
const REQUESTER_ID = 'property-13-requester' as VerificationState['participants'][number]['id'];
const IDENTIFIED_ID = 'property-13-identified' as VerificationState['participants'][number]['id'];
const REQUESTER_CODE = 'REQUESTER' as PlayerCode;
const IDENTIFIED_CODE = 'IDENTIFIED' as PlayerCode;
const GRID_ID = 'property-13-grid' as GridRecord['id'];
const PENDING_REQUEST_ID =
  'property-13-pending-request' as VerificationState['verificationRequests'][number]['id'];
const PENDING_NOTIFICATION_ID = 'property-13-pending-notification' as NotificationRecord['id'];

interface ClosedGameScenario {
  readonly taskCount: number;
  readonly pendingSquareIndex: number;
  readonly mutationOrder: readonly number[];
}

const scenarioArbitrary: fc.Arbitrary<ClosedGameScenario> = fc.record({
  taskCount: fc.integer({ min: 25, max: 40 }),
  pendingSquareIndex: fc.integer({ min: 0, max: 24 }),
  mutationOrder: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 6, maxLength: 18 }),
});

const metadata = (suffix: string, version: StateVersion) => ({
  correlationId: `${CORRELATION_ID}-${suffix}` as CorrelationId,
  idempotencyKey: `property-13-${suffix}` as IdempotencyKey,
  knownStateVersion: version,
});

const expectClosed = async (operation: () => Promise<unknown>): Promise<void> => {
  await expect(operation()).rejects.toMatchObject({ code: DomainErrorCode.GameClosed });
};

const fingerprint = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === 'bigint') return `bigint:${nested.toString()}`;
    if (nested instanceof Date) return `date:${nested.toISOString()}`;
    if (nested instanceof Uint8Array) return [...nested];
    return nested;
  });

const configurationFingerprint = async (
  repository: InMemoryGameConfigurationRepository,
  gameId: GameId,
): Promise<string> => repository.withGameConfiguration(gameId, (state) => fingerprint(state));

const createClosedConfiguration = async (
  scenario: ClosedGameScenario,
): Promise<{
  readonly repository: InMemoryGameConfigurationRepository;
  readonly service: GameConfigurationService;
  readonly gameId: GameId;
  readonly taskRecords: readonly TaskEntryRecord[];
  readonly closedVersion: StateVersion;
}> => {
  let taskSequence = 0;
  const repository = new InMemoryGameConfigurationRepository({
    now: () => NOW,
    idFactory: () => `property-13-game-${scenario.taskCount}-${scenario.pendingSquareIndex}`,
  });
  const service = new GameConfigurationService(repository, {
    now: () => NOW,
    idFactory: () => `property-13-task-${++taskSequence}`,
  });
  const created = await service.createGame(
    {
      name: `Property 13 game ${scenario.taskCount}`,
      ...metadata('create', 0 as StateVersion),
    } satisfies CreateGameCommand,
    HOST_ACCOUNT,
  );
  const gameId = created.game.id;
  let version = created.game.stateVersion;
  for (let index = 0; index < scenario.taskCount; index += 1) {
    const result = await service.addTaskEntry({
      gameId,
      text: `Property 13 task ${index}`,
      ...metadata(`add-${index}`, version),
    } satisfies AddTaskEntryCommand);
    version = result.stateVersion;
  }
  const opened = await service.openGame({
    gameId,
    ...metadata('open', version),
  });
  version = opened.stateVersion;
  const active = await service.lockTaskBag({
    gameId,
    ...metadata('lock', version),
  });
  version = active.stateVersion;
  const closed = await service.closeGame({
    gameId,
    ...metadata('close', version),
  } satisfies CloseGameCommand);

  const taskRecords = opened.tasks.map(
    (task) =>
      ({
        id: task.id,
        gameId,
        displayText: task.text,
        normalizedText: task.text.normalize('NFKC').toLocaleLowerCase('en-US'),
        createdAt: NOW,
        updatedAt: NOW,
        removedAt: null,
      }) satisfies TaskEntryRecord,
  );

  return {
    repository,
    service,
    gameId,
    taskRecords,
    closedVersion: closed.stateVersion,
  };
};

const makeClosedVerificationState = (
  gameId: GameId,
  taskRecords: readonly TaskEntryRecord[],
  stateVersion: StateVersion,
  pendingSquareIndex: number,
): VerificationState => {
  const game: GameRecord = {
    id: gameId,
    hostAccountId: HOST_ACCOUNT,
    name: 'Property 13 populated game',
    status: GameStatus.Closed,
    taskBagLockedAt: NOW,
    closedAt: NOW,
    stateVersion: BigInt(stateVersion),
    createdAt: NOW,
    updatedAt: NOW,
  };
  const participants: ParticipantRecord[] = [
    { id: REQUESTER_ID, gameId, createdAt: NOW, leftAt: null },
    { id: IDENTIFIED_ID, gameId, createdAt: NOW, leftAt: null },
  ];
  const memberships: MembershipRecord[] = participants.map((participant, index) => ({
    id: `property-13-membership-${index}` as MembershipRecord['id'],
    gameId,
    participantId: participant.id,
    browserSessionId: null,
    resumableCredentialHash: new Uint8Array([index + 1]),
    createdAt: NOW,
    lastSeenAt: NOW,
  }));
  const profiles: PlayerProfileRecord[] = [
    {
      id: 'property-13-requester-profile' as PlayerProfileRecord['id'],
      gameId,
      participantId: REQUESTER_ID,
      displayName: 'Requester',
      playerCode: REQUESTER_CODE,
      createdAt: NOW,
    },
    {
      id: 'property-13-identified-profile' as PlayerProfileRecord['id'],
      gameId,
      participantId: IDENTIFIED_ID,
      displayName: 'Identified',
      playerCode: IDENTIFIED_CODE,
      createdAt: NOW,
    },
  ];
  const grid: GridRecord = {
    id: GRID_ID,
    gameId,
    participantId: REQUESTER_ID,
    taskBagVersion: 1n,
    stateVersion: BigInt(stateVersion),
    createdAt: NOW,
  };
  const squares: SquareRecord[] = taskRecords.slice(0, 25).map((task, squareIndex) => ({
    gridId: GRID_ID,
    gameId,
    squareIndex,
    taskEntryId: task.id,
    status: squareIndex === pendingSquareIndex ? SquareStatus.Pending : SquareStatus.Verified,
    updatedAt: NOW,
  }));
  const verificationRequests: VerificationState['verificationRequests'] = [
    {
      id: PENDING_REQUEST_ID,
      gameId,
      gridId: GRID_ID,
      squareIndex: pendingSquareIndex,
      requestingParticipantId: REQUESTER_ID,
      identifiedParticipantId: IDENTIFIED_ID,
      status: VerificationRequestStatus.Pending,
      createdAt: NOW,
      resolvedAt: null,
      outcomeActorId: null,
      clientCommandId: 'property-13-existing-request',
    },
  ];
  const notifications: NotificationRecord[] = [
    {
      id: PENDING_NOTIFICATION_ID,
      gameId,
      recipientParticipantId: IDENTIFIED_ID,
      verificationRequestId: PENDING_REQUEST_ID,
      kind: 'verification_request',
      status: NotificationStatus.Pending,
      createdAt: NOW,
      resolvedAt: null,
    },
  ];
  const completions: CompletionRecord[] = [
    {
      id: 'property-13-existing-completion' as CompletionRecord['id'],
      gameId,
      participantId: REQUESTER_ID,
      category: CompletionCategory.Line,
      completionKey: 'row:1',
      completedAt: NOW,
      createdAt: NOW,
    },
  ];
  return emptyVerificationState({
    game,
    tasks: taskRecords,
    memberships,
    participants,
    profiles,
    grids: [grid],
    squares,
    verificationRequests,
    notifications,
    completions,
  });
};

const requestCommand = (
  gameId: GameId,
  gridId: GridRecord['id'],
  squareIndex: number,
  version: StateVersion,
  suffix: string,
): RequestVerificationCommand => ({
  gameId,
  gridId,
  squareIndex,
  identifiedPlayerCode: IDENTIFIED_CODE,
  ...metadata(`request-${suffix}`, version),
});

const responseCommand = (
  gameId: GameId,
  requestId: VerificationState['verificationRequests'][number]['id'],
  version: StateVersion,
  decision: 'confirm' | 'reject',
  suffix: string,
): RespondToVerificationCommand => ({
  gameId,
  verificationRequestId: requestId,
  decision,
  ...metadata(`${decision}-${suffix}`, version),
});

const assertConfigurationCommandsAreTerminal = async (
  service: GameConfigurationService,
  gameId: GameId,
  taskId: TaskEntryRecord['id'],
  version: StateVersion,
  mutationOrder: readonly number[],
): Promise<void> => {
  for (const [index, mutation] of mutationOrder.entries()) {
    switch (mutation) {
      case 0:
        await expectClosed(() =>
          service.renameGame({
            gameId,
            name: `Changed after close ${index}`,
            ...metadata(`rename-${index}`, version),
          }),
        );
        break;
      case 1:
        await expectClosed(() =>
          service.addTaskEntry({
            gameId,
            text: `Added after close ${index}`,
            ...metadata(`add-after-close-${index}`, version),
          }),
        );
        break;
      case 2:
        await expectClosed(() =>
          service.editTaskEntry({
            gameId,
            taskEntryId: taskId,
            text: `Edited after close ${index}`,
            ...metadata(`edit-after-close-${index}`, version),
          } satisfies EditTaskEntryCommand),
        );
        break;
      case 3:
        await expectClosed(() =>
          service.removeTaskEntry({
            gameId,
            taskEntryId: taskId,
            ...metadata(`remove-after-close-${index}`, version),
          } satisfies RemoveTaskEntryCommand),
        );
        break;
      case 4:
        await expectClosed(() =>
          service.openGame({
            gameId,
            ...metadata(`open-after-close-${index}`, version),
          }),
        );
        break;
      default:
        await expectClosed(() =>
          service.lockTaskBag({
            gameId,
            ...metadata(`lock-after-close-${index}`, version),
          }),
        );
    }
  }
};

describe('Property 13: closed-game terminal immutability', () => {
  it('rejects post-close writes and preserves populated historical state', async () => {
    // Feature: human-bingo, Property 13: Closed-game terminal immutability
    // **Validates: Requirements 1.9, 2.7, 2.8, 3.6, 5.9, 11.6**
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const configuration = await createClosedConfiguration(scenario);
        const configurationBefore = await configurationFingerprint(
          configuration.repository,
          configuration.gameId,
        );
        const taskId = configuration.taskRecords[0]?.id;
        expect(taskId).toBeDefined();
        if (taskId === undefined) return;

        await assertConfigurationCommandsAreTerminal(
          configuration.service,
          configuration.gameId,
          taskId,
          configuration.closedVersion,
          scenario.mutationOrder,
        );
        expect(await configurationFingerprint(configuration.repository, configuration.gameId)).toBe(
          configurationBefore,
        );

        const verificationState = makeClosedVerificationState(
          configuration.gameId,
          configuration.taskRecords,
          configuration.closedVersion,
          scenario.pendingSquareIndex,
        );
        const verificationRepository = new InMemoryVerificationRepository({
          states: [verificationState],
        });
        const verificationService = new VerificationCompletionService(verificationRepository, {
          now: () => NOW,
          idFactory: () => 'property-13-generated-id',
        });
        const verificationBefore = fingerprint(
          await verificationRepository.read(configuration.gameId),
        );
        const requestSquare = scenario.pendingSquareIndex === 0 ? 1 : 0;

        await expectClosed(() =>
          verificationService.request(
            requestCommand(
              configuration.gameId,
              GRID_ID,
              requestSquare,
              configuration.closedVersion,
              'new-request',
            ),
            REQUESTER_ID,
          ),
        );
        await expectClosed(() =>
          verificationService.confirm(
            responseCommand(
              configuration.gameId,
              PENDING_REQUEST_ID,
              configuration.closedVersion,
              'confirm',
              'existing-request',
            ),
            IDENTIFIED_ID,
          ),
        );
        await expectClosed(() =>
          verificationService.reject(
            responseCommand(
              configuration.gameId,
              PENDING_REQUEST_ID,
              configuration.closedVersion,
              'reject',
              'existing-request',
            ),
            IDENTIFIED_ID,
          ),
        );
        expect(fingerprint(await verificationRepository.read(configuration.gameId))).toBe(
          verificationBefore,
        );

        const gridRepository = new InMemoryGridRepository({
          states: [
            {
              game: (await verificationRepository.read(configuration.gameId)).game,
              tasks: [...configuration.taskRecords],
              grids: [],
              squares: [],
            },
          ],
        });
        const gridService = new GridService(gridRepository, {
          now: () => NOW,
          idFactory: () => 'property-13-new-grid',
          randomBytes: () => new Uint8Array([0, 0, 0, 1]),
        });
        const gridBefore = fingerprint(await gridRepository.read(configuration.gameId));
        await expectClosed(() =>
          gridService.generateOrResume({
            gameId: configuration.gameId,
            participantId: 'property-13-new-participant' as typeof REQUESTER_ID,
            correlationId: `${CORRELATION_ID}-onboarding` as CorrelationId,
          }),
        );
        expect(fingerprint(await gridRepository.read(configuration.gameId))).toBe(gridBefore);
      }),
      readPropertyTestOptions(),
    );
  });
});
