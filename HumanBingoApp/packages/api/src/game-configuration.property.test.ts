import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  type AddTaskEntryCommand,
  type CorrelationId,
  type CreateGameCommand,
  type EditTaskEntryCommand,
  type GameId,
  type GameMutationResult,
  type IdempotencyKey,
  type OpenGameCommand,
  type RemoveTaskEntryCommand,
  type StateVersion,
  type TaskEntryId,
} from '@human-bingo/domain';
import { InMemoryGameConfigurationRepository } from '@human-bingo/persistence';
import { readPropertyTestOptions } from '@human-bingo/test-utils';

import { GameConfigurationService } from './game-configuration.js';

const correlationId = 'property-2-correlation' as CorrelationId;
const idempotencyKey = 'property-2-command' as IdempotencyKey;

interface TaskBagCounts {
  readonly belowThreshold: number;
  readonly atOrAboveThreshold: number;
}

const taskBagCountsArbitrary = fc.record({
  belowThreshold: fc.integer({ min: 0, max: 24 }),
  atOrAboveThreshold: fc.integer({ min: 25, max: 50 }),
});

const createService = (): GameConfigurationService => {
  let taskSequence = 0;
  const repository = new InMemoryGameConfigurationRepository({
    idFactory: (() => {
      let gameSequence = 0;
      return () => `property-2-game-${++gameSequence}`;
    })(),
  });

  return new GameConfigurationService(repository, {
    idFactory: () => `property-2-task-${++taskSequence}`,
  });
};

const createGame = async (service: GameConfigurationService): Promise<GameId> => {
  const command: CreateGameCommand = {
    name: 'Property 2 game',
    correlationId,
    idempotencyKey,
  };
  const result = await service.createGame(command, 'property-2-host');
  return result.game.id;
};

const addTasks = async (
  service: GameConfigurationService,
  gameId: GameId,
  count: number,
): Promise<StateVersion> => {
  let version = 0 as StateVersion;
  for (let index = 0; index < count; index += 1) {
    const command: AddTaskEntryCommand = {
      gameId,
      text: `Property 2 task ${index + 1}`,
      correlationId,
      idempotencyKey: `property-2-add-${index + 1}` as IdempotencyKey,
      knownStateVersion: version,
    };
    const result = await service.addTaskEntry(command);
    version = result.stateVersion;
  }
  return version;
};

const openCommand = (gameId: GameId, version: StateVersion): OpenGameCommand => ({
  gameId,
  correlationId,
  idempotencyKey,
  knownStateVersion: version,
});

const expectDomainError = async (
  action: () => Promise<unknown>,
  code: DomainErrorCode,
): Promise<HumanBingoError> => {
  let error: unknown;
  try {
    await action();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HumanBingoError);
  expect((error as HumanBingoError).code).toBe(code);
  return error as HumanBingoError;
};

const assertDraftRemainsUnopened = async (
  service: GameConfigurationService,
  gameId: GameId,
  taskCount: number,
  version: StateVersion,
): Promise<void> => {
  const insufficient = await expectDomainError(
    () => service.openGame(openCommand(gameId, version)),
    DomainErrorCode.InsufficientTasks,
  );
  expect(insufficient.metadata).toEqual({
    distinctTaskCount: taskCount,
    requiredTaskCount: 25,
  });

  const unchanged = await service.renameGame({
    gameId,
    name: 'Still a draft',
    correlationId,
    idempotencyKey: 'property-2-draft-check' as IdempotencyKey,
    knownStateVersion: version,
  });
  expect(unchanged.game.status).toBe(GameStatus.Draft);
  expect(unchanged.game.taskBagLocked).toBe(false);
  expect(unchanged.tasks).toHaveLength(taskCount);
};

const assertOpenAndFirstJoinLifecycle = async (taskCount: number): Promise<void> => {
  const service = createService();
  const gameId = await createGame(service);
  const version = await addTasks(service, gameId, taskCount);

  if (taskCount < 25) {
    await assertDraftRemainsUnopened(service, gameId, taskCount, version);
    return;
  }

  const opened = await service.openGame(openCommand(gameId, version));
  expect(opened.game.status).toBe(GameStatus.InvitationAvailable);
  expect(opened.game.distinctTaskCount).toBe(taskCount);
  expect(opened.game.taskBagLocked).toBe(false);
  expect(opened.tasks).toHaveLength(taskCount);

  const reopened = await service.openGame(openCommand(gameId, opened.stateVersion));
  expect(reopened.game.status).toBe(GameStatus.InvitationAvailable);
  expect(reopened.game.stateVersion).toBe(opened.game.stateVersion);
  expect(reopened.tasks).toEqual(opened.tasks);

  const lockAttempts = await Promise.allSettled([
    service.lockTaskBag({
      gameId,
      correlationId,
      idempotencyKey: 'property-2-first-join-a' as IdempotencyKey,
      knownStateVersion: opened.stateVersion,
    }),
    service.lockTaskBag({
      gameId,
      correlationId,
      idempotencyKey: 'property-2-first-join-b' as IdempotencyKey,
      knownStateVersion: opened.stateVersion,
    }),
  ]);
  const successfulLocks = lockAttempts.filter(
    (
      attempt,
    ): attempt is PromiseFulfilledResult<
      Awaited<ReturnType<GameConfigurationService['lockTaskBag']>>
    > => attempt.status === 'fulfilled',
  );
  const rejectedLocks = lockAttempts.filter((attempt) => attempt.status === 'rejected');

  expect(successfulLocks).toHaveLength(1);
  expect(rejectedLocks).toHaveLength(1);
  const rejectedReason = (rejectedLocks[0] as PromiseRejectedResult).reason as unknown;
  expect(rejectedReason).toBeInstanceOf(HumanBingoError);
  if (!(rejectedReason instanceof HumanBingoError)) return;
  expect(rejectedReason.code).toBe(DomainErrorCode.StaleState);

  const locked = successfulLocks[0]?.value;
  expect(locked).toBeDefined();
  if (locked === undefined) return;
  expect(locked.game.status).toBe(GameStatus.Active);
  expect(locked.game.taskBagLocked).toBe(true);
  expect(locked.tasks).toEqual(opened.tasks);

  const repeatedLock = await service.lockTaskBag({
    gameId,
    correlationId,
    idempotencyKey: 'property-2-repeat-join' as IdempotencyKey,
    knownStateVersion: locked.stateVersion,
  });
  expect(repeatedLock.game.status).toBe(GameStatus.Active);
  expect(repeatedLock.game.taskBagLocked).toBe(true);
  expect(repeatedLock.stateVersion).toBe(locked.stateVersion);
  expect(repeatedLock.tasks).toEqual(locked.tasks);

  const reopenedAfterJoin = await service.openGame(openCommand(gameId, locked.stateVersion));
  expect(reopenedAfterJoin.game.status).toBe(GameStatus.Active);
  expect(reopenedAfterJoin.game.taskBagLocked).toBe(true);
  expect(reopenedAfterJoin.stateVersion).toBe(locked.stateVersion);
  expect(reopenedAfterJoin.tasks).toEqual(locked.tasks);

  const firstTaskId = locked.tasks[0]?.id;
  expect(firstTaskId).toBeDefined();
  if (firstTaskId === undefined) return;

  await expectDomainError(
    () =>
      service.addTaskEntry({
        gameId,
        text: 'A task after first join',
        correlationId,
        idempotencyKey: 'property-2-add-after-join' as IdempotencyKey,
        knownStateVersion: locked.stateVersion,
      }),
    DomainErrorCode.InvalidCommand,
  );
  await expectDomainError(
    () =>
      service.editTaskEntry({
        gameId,
        taskEntryId: firstTaskId,
        text: 'Edited after first join',
        correlationId,
        idempotencyKey: 'property-2-edit-after-join' as IdempotencyKey,
        knownStateVersion: locked.stateVersion,
      }),
    DomainErrorCode.InvalidCommand,
  );
  await expectDomainError(
    () =>
      service.removeTaskEntry({
        gameId,
        taskEntryId: firstTaskId,
        correlationId,
        idempotencyKey: 'property-2-remove-after-join' as IdempotencyKey,
        knownStateVersion: locked.stateVersion,
      }),
    DomainErrorCode.InvalidCommand,
  );

  const stillLocked = await service.renameGame({
    gameId,
    name: 'Renamed after first join',
    correlationId,
    idempotencyKey: 'property-2-rename-after-join' as IdempotencyKey,
    knownStateVersion: locked.stateVersion,
  });
  expect(stillLocked.game.status).toBe(GameStatus.Active);
  expect(stillLocked.game.taskBagLocked).toBe(true);
  expect(stillLocked.tasks).toEqual(locked.tasks);
};

describe('Property 2: opening and first-join lifecycle invariant', () => {
  it('preserves draft/open thresholds and atomically locks the task bag on first join', async () => {
    // Feature: human-bingo, Property 2
    // **Validates: Requirements 1.6, 1.7, 1.8, 2.1**
    const options = readPropertyTestOptions();
    await fc.assert(
      fc.asyncProperty(taskBagCountsArbitrary as fc.Arbitrary<TaskBagCounts>, async (counts) => {
        // Each generated case exercises both sides of the 25-task threshold.
        await assertOpenAndFirstJoinLifecycle(counts.belowThreshold);
        await assertOpenAndFirstJoinLifecycle(counts.atOrAboveThreshold);
      }),
      options,
    );
  });
});

type PropertyOneMutationKind =
  | 'add-valid'
  | 'add-whitespace'
  | 'add-unicode-whitespace'
  | 'add-case-variant'
  | 'edit-valid'
  | 'edit-whitespace'
  | 'edit-case-variant'
  | 'remove';

interface PropertyOneMutation {
  readonly kind: PropertyOneMutationKind;
  readonly value: number;
}

interface StoredTask {
  readonly id: TaskEntryId;
  readonly displayText: string;
  readonly normalizedText: string;
  readonly removedAt: string | null;
}

interface TaskBagSnapshot {
  readonly stateVersion: StateVersion;
  readonly tasks: readonly StoredTask[];
}

const propertyOneCorrelationId = 'property-1-correlation' as CorrelationId;
const unicodeWhitespace = [
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
] as const;

const propertyOneMutationArbitrary: fc.Arbitrary<PropertyOneMutation> = fc.record({
  kind: fc.constantFrom<PropertyOneMutationKind>(
    'add-valid',
    'add-whitespace',
    'add-unicode-whitespace',
    'add-case-variant',
    'edit-valid',
    'edit-whitespace',
    'edit-case-variant',
    'remove',
  ),
  value: fc.integer(),
});

const propertyOneSequenceArbitrary = fc.record({
  seed: fc.integer(),
  mutations: fc.array(propertyOneMutationArbitrary, { maxLength: 30 }),
});

const createPropertyOneContext = (): {
  readonly repository: InMemoryGameConfigurationRepository;
  readonly service: GameConfigurationService;
} => {
  let gameSequence = 0;
  let taskSequence = 0;
  const repository = new InMemoryGameConfigurationRepository({
    idFactory: () => `property-1-game-${++gameSequence}`,
  });
  return {
    repository,
    service: new GameConfigurationService(repository, {
      idFactory: () => `property-1-task-${++taskSequence}`,
    }),
  };
};

const createPropertyOneGame = async (service: GameConfigurationService): Promise<GameId> => {
  const result = await service.createGame(
    {
      name: 'Property 1 game',
      correlationId: propertyOneCorrelationId,
      idempotencyKey: 'property-1-create' as IdempotencyKey,
    },
    'property-1-host',
  );
  return result.game.id;
};

const readTaskBag = async (
  repository: InMemoryGameConfigurationRepository,
  gameId: GameId,
): Promise<TaskBagSnapshot> =>
  repository.withGameConfiguration(gameId, (state) => ({
    stateVersion: Number(state.game.stateVersion) as StateVersion,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      displayText: task.displayText,
      normalizedText: task.normalizedText,
      removedAt: task.removedAt?.toISOString() ?? null,
    })),
  }));

const activeTasks = (snapshot: TaskBagSnapshot): readonly StoredTask[] =>
  snapshot.tasks.filter((task) => task.removedAt === null);

const indexFor = (value: number, length: number): number => {
  const remainder = value % length;
  return remainder < 0 ? remainder + length : remainder;
};

const whitespaceOnlyText = (value: number): string => {
  const count = indexFor(value, 4) + 1;
  return `${' '.repeat(count)}${'\t\n'.repeat(count)}`;
};

const unicodeWhitespaceOnlyText = (value: number): string => {
  const first = unicodeWhitespace[indexFor(value, unicodeWhitespace.length)];
  const second = unicodeWhitespace[indexFor(value + 1, unicodeWhitespace.length)];
  return `${first}${second}${first}`;
};

const expectedNormalizedText = (text: string): string =>
  text.trim().normalize('NFKC').toLocaleLowerCase('en-US');

const assertNormalizedStorage = (snapshot: TaskBagSnapshot): void => {
  for (const task of snapshot.tasks) {
    expect(task.displayText).toBe(task.displayText.trim());
    expect(task.displayText.length).toBeGreaterThan(0);
    expect(task.normalizedText).toBe(expectedNormalizedText(task.displayText));
    expect(task.normalizedText.length).toBeGreaterThan(0);
  }

  const activeNormalizedTexts = activeTasks(snapshot).map((task) => task.normalizedText);
  expect(new Set(activeNormalizedTexts).size).toBe(activeNormalizedTexts.length);
};

const taskAt = (snapshot: TaskBagSnapshot, value: number): StoredTask | undefined => {
  const tasks = activeTasks(snapshot);
  return tasks.length === 0 ? undefined : tasks[indexFor(value, tasks.length)];
};

const mutationText = (
  mutation: PropertyOneMutation,
  snapshot: TaskBagSnapshot,
  step: number,
): { readonly text: string; readonly targetId?: TaskEntryId; readonly shouldAccept: boolean } => {
  const target = taskAt(snapshot, mutation.value);
  switch (mutation.kind) {
    case 'add-valid':
      return { text: `  Valid task ${mutation.value}-${step}  `, shouldAccept: true };
    case 'add-whitespace':
      return { text: whitespaceOnlyText(mutation.value), shouldAccept: false };
    case 'add-unicode-whitespace':
      return { text: unicodeWhitespaceOnlyText(mutation.value), shouldAccept: false };
    case 'add-case-variant':
      return {
        text:
          target === undefined
            ? whitespaceOnlyText(mutation.value)
            : ` ${target.displayText.toUpperCase()} `,
        shouldAccept: false,
      };
    case 'edit-valid':
      return {
        text: `  Edited task ${mutation.value}-${step}  `,
        ...(target === undefined ? {} : { targetId: target.id }),
        shouldAccept: target !== undefined,
      };
    case 'edit-whitespace':
      return {
        text: whitespaceOnlyText(mutation.value),
        ...(target === undefined ? {} : { targetId: target.id }),
        shouldAccept: false,
      };
    case 'edit-case-variant': {
      const tasks = activeTasks(snapshot);
      const duplicate =
        tasks.length < 2
          ? undefined
          : tasks[(indexFor(mutation.value, tasks.length) + 1) % tasks.length];
      return {
        text:
          duplicate === undefined
            ? whitespaceOnlyText(mutation.value)
            : ` ${duplicate.displayText.toUpperCase()} `,
        ...(target === undefined ? {} : { targetId: target.id }),
        shouldAccept: false,
      };
    }
    case 'remove':
      return {
        text: '',
        ...(target === undefined ? {} : { targetId: target.id }),
        shouldAccept: target !== undefined,
      };
  }
};

const executePropertyOneMutation = async (
  service: GameConfigurationService,
  repository: InMemoryGameConfigurationRepository,
  gameId: GameId,
  mutation: PropertyOneMutation,
  step: number,
): Promise<void> => {
  const before = await readTaskBag(repository, gameId);
  const { text, targetId, shouldAccept } = mutationText(mutation, before, step);
  const idempotencyKey = `property-1-mutation-${step}` as IdempotencyKey;
  let result: GameMutationResult | undefined;
  let error: unknown;

  try {
    if (mutation.kind === 'remove') {
      const command: RemoveTaskEntryCommand = {
        gameId,
        taskEntryId: targetId ?? (`property-1-missing-${step}` as TaskEntryId),
        correlationId: propertyOneCorrelationId,
        idempotencyKey,
        knownStateVersion: before.stateVersion,
      };
      result = await service.removeTaskEntry(command);
    } else if (
      mutation.kind === 'edit-valid' ||
      mutation.kind === 'edit-whitespace' ||
      mutation.kind === 'edit-case-variant'
    ) {
      const command: EditTaskEntryCommand = {
        gameId,
        taskEntryId: targetId ?? (`property-1-missing-${step}` as TaskEntryId),
        text,
        correlationId: propertyOneCorrelationId,
        idempotencyKey,
        knownStateVersion: before.stateVersion,
      };
      result = await service.editTaskEntry(command);
    } else {
      const command: AddTaskEntryCommand = {
        gameId,
        text,
        correlationId: propertyOneCorrelationId,
        idempotencyKey,
        knownStateVersion: before.stateVersion,
      };
      result = await service.addTaskEntry(command);
    }
  } catch (caught: unknown) {
    error = caught;
  }

  const after = await readTaskBag(repository, gameId);
  if (shouldAccept) {
    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    expect(after.stateVersion).toBe((Number(before.stateVersion) + 1) as StateVersion);
  } else {
    expect(error).toBeInstanceOf(HumanBingoError);
    expect([
      DomainErrorCode.TaskRequired,
      DomainErrorCode.DuplicateTask,
      DomainErrorCode.ValidationError,
    ]).toContain((error as HumanBingoError).code);
    expect(after).toEqual(before);
  }
  assertNormalizedStorage(after);
};

const mandatoryPropertyOneMutations = (seed: number): readonly PropertyOneMutation[] => [
  { kind: 'add-valid', value: seed },
  { kind: 'add-valid', value: seed + 1 },
  { kind: 'edit-valid', value: seed },
  { kind: 'add-case-variant', value: seed },
  { kind: 'add-whitespace', value: seed },
  { kind: 'add-unicode-whitespace', value: seed },
  { kind: 'edit-valid', value: seed + 1 },
  { kind: 'edit-case-variant', value: seed + 1 },
  { kind: 'edit-whitespace', value: seed + 1 },
  { kind: 'remove', value: seed },
];

describe('Property 1: normalized draft task-bag invariant', () => {
  it('normalizes accepted mutations and preserves the bag after rejected mutations', async () => {
    // Feature: human-bingo, Property 1
    // **Validates: Requirements 1.2, 1.3, 1.4, 1.5**
    const options = readPropertyTestOptions();
    await fc.assert(
      fc.asyncProperty(propertyOneSequenceArbitrary, async ({ seed, mutations }) => {
        const { repository, service } = createPropertyOneContext();
        const gameId = await createPropertyOneGame(service);
        const sequence = [...mandatoryPropertyOneMutations(seed), ...mutations];

        let step = 0;
        for (const mutation of sequence) {
          await executePropertyOneMutation(service, repository, gameId, mutation, step);
          step += 1;
        }
      }),
      options,
    );
  });
});
