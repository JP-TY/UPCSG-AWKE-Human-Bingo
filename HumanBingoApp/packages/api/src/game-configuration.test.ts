import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  type AddTaskEntryCommand,
  type AddTaskEntriesCommand,
  type CorrelationId,
  type CreateGameCommand,
  type GameId,
  type IdempotencyKey,
  type OpenGameCommand,
  type StateVersion,
} from '@human-bingo/domain';
import { InMemoryGameConfigurationRepository } from '@human-bingo/persistence';

import { GameConfigurationService } from './game-configuration.js';

const correlationId = 'test-correlation' as CorrelationId;
const idempotencyKey = 'test-command' as IdempotencyKey;

const createService = (): {
  readonly service: GameConfigurationService;
  readonly clock: { now: () => Date; advance: (milliseconds: number) => void };
} => {
  let current = new Date('2025-01-01T00:00:00.000Z');
  const clock = {
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current = new Date(current.valueOf() + milliseconds);
    },
  };
  const repository = new InMemoryGameConfigurationRepository({ now: clock.now });
  return {
    clock,
    service: new GameConfigurationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `task-${++sequence}`;
      })(),
    }),
  };
};

const createGame = async (service: GameConfigurationService): Promise<GameId> => {
  const command: CreateGameCommand = {
    name: '  Team Bingo  ',
    correlationId,
    idempotencyKey,
  };
  const result = await service.createGame(command, 'host-1');
  expect(result.game.name).toBe('Team Bingo');
  expect(result.game.status).toBe(GameStatus.Draft);
  return result.game.id;
};

const addTask = async (
  service: GameConfigurationService,
  gameId: GameId,
  version: StateVersion,
  text: string,
): Promise<StateVersion> => {
  const command: AddTaskEntryCommand = {
    gameId,
    text,
    correlationId,
    idempotencyKey: `${String(idempotencyKey)}-${text}` as IdempotencyKey,
    knownStateVersion: version,
  };
  const result = await service.addTaskEntry(command);
  return result.stateVersion;
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

describe('GameConfigurationService', () => {
  it('creates drafts and atomically normalizes, edits, removes, and re-adds tasks', async () => {
    const { service } = createService();
    const gameId = await createGame(service);

    let version = 0 as StateVersion;
    version = await addTask(service, gameId, version, '  Find a musician  ');
    expect(version).toBe(1);

    const editResult = await service.editTaskEntry({
      gameId,
      taskEntryId: 'task-1' as never,
      text: '  Find an Artist  ',
      correlationId,
      idempotencyKey: 'edit-1' as IdempotencyKey,
      knownStateVersion: version,
    });
    expect(editResult.tasks[0]?.text).toBe('Find an Artist');

    const removeResult = await service.removeTaskEntry({
      gameId,
      taskEntryId: 'task-1' as never,
      correlationId,
      idempotencyKey: 'remove-1' as IdempotencyKey,
      knownStateVersion: editResult.stateVersion,
    });
    expect(removeResult.tasks).toHaveLength(0);

    const reAddResult = await service.addTaskEntry({
      gameId,
      text: ' find an artist ',
      correlationId,
      idempotencyKey: 're-add-1' as IdempotencyKey,
      knownStateVersion: removeResult.stateVersion,
    });
    expect(reAddResult.tasks[0]?.text).toBe('find an artist');
  });

  it('adds a task bag in one state transition', async () => {
    const { service } = createService();
    const gameId = await createGame(service);
    const command: AddTaskEntriesCommand = {
      gameId,
      texts: ['  First task  ', 'Second task'],
      correlationId,
      idempotencyKey: 'bulk-add' as IdempotencyKey,
      knownStateVersion: 0 as StateVersion,
    };

    const result = await service.addTaskEntries(command);

    expect(result.stateVersion).toBe(1);
    expect(result.tasks.map((task) => task.text)).toEqual(['First task', 'Second task']);
  });

  it('rejects empty and duplicate task mutations without changing the prior bag', async () => {
    const { service } = createService();
    const gameId = await createGame(service);
    const version = await addTask(service, gameId, 0 as StateVersion, 'Original task');

    const emptyError = await expectDomainError(
      () =>
        service.addTaskEntry({
          gameId,
          text: '\u2003 \t',
          correlationId,
          idempotencyKey: 'empty' as IdempotencyKey,
          knownStateVersion: version,
        }),
      DomainErrorCode.TaskRequired,
    );
    expect(emptyError.fieldErrors?.[0]?.field).toBe('text');

    const duplicateError = await expectDomainError(
      () =>
        service.addTaskEntry({
          gameId,
          text: ' original TASK ',
          correlationId,
          idempotencyKey: 'duplicate' as IdempotencyKey,
          knownStateVersion: version,
        }),
      DomainErrorCode.DuplicateTask,
    );
    expect(duplicateError.fieldErrors?.[0]?.field).toBe('text');

    const unchanged = await service.renameGame({
      gameId,
      name: 'Still Draft',
      correlationId,
      idempotencyKey: 'rename' as IdempotencyKey,
      knownStateVersion: version,
    });
    expect(unchanged.tasks).toHaveLength(1);
    expect(unchanged.tasks[0]?.text).toBe('Original task');
  });

  it('requires 25 distinct tasks to open and keeps repeated open idempotent', async () => {
    const { service } = createService();
    const gameId = await createGame(service);
    const insufficient = await expectDomainError(
      () => service.openGame(openCommand(gameId, 0 as StateVersion)),
      DomainErrorCode.InsufficientTasks,
    );
    expect(insufficient.metadata).toEqual({ distinctTaskCount: 0, requiredTaskCount: 25 });

    let version = 0 as StateVersion;
    for (let index = 0; index < 25; index += 1) {
      version = await addTask(service, gameId, version, `Task ${index + 1}`);
    }
    const opened = await service.openGame(openCommand(gameId, version));
    expect(opened.game.status).toBe(GameStatus.InvitationAvailable);
    expect(opened.game.distinctTaskCount).toBe(25);

    const reopened = await service.openGame(openCommand(gameId, opened.stateVersion));
    expect(reopened.game.status).toBe(GameStatus.InvitationAvailable);
    expect(reopened.stateVersion).toBe(opened.stateVersion);
  });

  it('locks the bag on first join and rejects later task changes atomically', async () => {
    const { service, clock } = createService();
    const gameId = await createGame(service);
    let version = 0 as StateVersion;
    for (let index = 0; index < 25; index += 1) {
      version = await addTask(service, gameId, version, `Task ${index + 1}`);
    }
    const opened = await service.openGame(openCommand(gameId, version));
    clock.advance(1000);

    const locked = await service.lockTaskBag({
      gameId,
      correlationId,
      idempotencyKey: 'lock' as IdempotencyKey,
      knownStateVersion: opened.stateVersion,
    });
    expect(locked.game.status).toBe(GameStatus.Active);
    expect(locked.game.taskBagLocked).toBe(true);
    expect(locked.tasks).toHaveLength(25);

    await expectDomainError(
      () =>
        service.removeTaskEntry({
          gameId,
          taskEntryId: locked.tasks[0]?.id as never,
          correlationId,
          idempotencyKey: 'remove-locked' as IdempotencyKey,
          knownStateVersion: locked.stateVersion,
        }),
      DomainErrorCode.InvalidCommand,
    );
    await expectDomainError(
      () =>
        service.addTaskEntry({
          gameId,
          text: '\\u2003 \\t',
          correlationId,
          idempotencyKey: 'add-invalid-locked' as IdempotencyKey,
          knownStateVersion: locked.stateVersion,
        }),
      DomainErrorCode.InvalidCommand,
    );
    await expectDomainError(
      () =>
        service.editTaskEntry({
          gameId,
          taskEntryId: locked.tasks[0]?.id as never,
          text: '',
          correlationId,
          idempotencyKey: 'edit-invalid-locked' as IdempotencyKey,
          knownStateVersion: locked.stateVersion,
        }),
      DomainErrorCode.InvalidCommand,
    );
    const stillLocked = await service.renameGame({
      gameId,
      name: 'Renamed Active Game',
      correlationId,
      idempotencyKey: 'rename-active' as IdempotencyKey,
      knownStateVersion: locked.stateVersion,
    });
    expect(stillLocked.tasks).toHaveLength(25);
    expect(stillLocked.game.taskBagLocked).toBe(true);
  });

  it('closes games terminally and rejects stale or post-close mutations', async () => {
    const { service } = createService();
    const gameId = await createGame(service);
    const currentVersion = 0 as StateVersion;
    const stale = await expectDomainError(
      () =>
        service.renameGame({
          gameId,
          name: 'Stale write',
          correlationId,
          idempotencyKey: 'stale' as IdempotencyKey,
          knownStateVersion: 99 as StateVersion,
        }),
      DomainErrorCode.StaleState,
    );
    expect(stale.metadata).toEqual({ currentStateVersion: 0 });

    const closed = await service.closeGame({
      gameId,
      correlationId,
      idempotencyKey: 'close' as IdempotencyKey,
      knownStateVersion: currentVersion,
    });
    expect(closed.game.status).toBe(GameStatus.Closed);
    expect(closed.game.closedAt).toBe('2025-01-01T00:00:00.000Z');

    await expectDomainError(
      () =>
        service.addTaskEntry({
          gameId,
          text: 'No mutation',
          correlationId,
          idempotencyKey: 'post-close' as IdempotencyKey,
          knownStateVersion: closed.stateVersion,
        }),
      DomainErrorCode.GameClosed,
    );
    await expectDomainError(
      () =>
        service.renameGame({
          gameId,
          name: '',
          correlationId,
          idempotencyKey: 'post-close-invalid-name' as IdempotencyKey,
          knownStateVersion: closed.stateVersion,
        }),
      DomainErrorCode.GameClosed,
    );
    await expectDomainError(
      () =>
        service.editTaskEntry({
          gameId,
          taskEntryId: 'missing-task' as never,
          text: '',
          correlationId,
          idempotencyKey: 'post-close-invalid-task' as IdempotencyKey,
          knownStateVersion: closed.stateVersion,
        }),
      DomainErrorCode.GameClosed,
    );
  });
});
