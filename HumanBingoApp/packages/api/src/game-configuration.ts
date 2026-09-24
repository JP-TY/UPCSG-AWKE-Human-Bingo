import { randomUUID } from 'node:crypto';

import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  type AddTaskEntryCommand,
  type AddTaskEntriesCommand,
  type CorrelationId,
  type CreateGameCommand,
  type CreateGameResult,
  type EditTaskEntryCommand,
  type GameDto,
  type GameConfigurationCommand,
  type GameMutationResult,
  type CloseGameCommand,
  type OpenGameCommand,
  type RemoveTaskEntryCommand,
  type RenameGameCommand,
  type StateVersion,
  type TaskEntryDto,
  type Timestamp,
} from '@human-bingo/domain';
import {
  createTaskEntryRecord,
  GameConfigurationNotFoundError,
  type GameConfigurationRepository,
  type GameConfigurationState,
} from '@human-bingo/persistence';
import type { GameRecord, TaskEntryRecord } from '@human-bingo/persistence';
import { observeCommand } from './observability.js';
import type { Observability } from './observability.js';

const MINIMUM_TASK_COUNT = 25;

export interface GameConfigurationServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly observability?: Observability;
}

export interface LockTaskBagCommand {
  readonly gameId: RenameGameCommand['gameId'];
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: RenameGameCommand['idempotencyKey'];
  readonly knownStateVersion: StateVersion;
}

/**
 * Application service for the host-controlled game lifecycle and task bag.
 * Every mutation is staged inside the repository transaction, so validation
 * failures leave both the game row and task rows unchanged.
 */
export class GameConfigurationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly observability: Observability | undefined;

  public constructor(
    private readonly repository: GameConfigurationRepository,
    options: GameConfigurationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.observability = options.observability;
  }

  public async createGame(
    command: CreateGameCommand,
    hostAccountId: string,
  ): Promise<CreateGameResult> {
    return observeCommand(
      this.observability,
      { correlationId: command.correlationId, command: 'create_game' },
      async () => {
        const name = normalizeName(command.name, command.correlationId);
        if (hostAccountId.trim().length === 0) {
          throw validationError(
            command.correlationId,
            'A host account is required.',
            'hostAccountId',
          );
        }

        const game = await this.repository.createGame({
          hostAccountId,
          name,
          now: this.now(),
        });
        return { game: toGameDto(game, []) };
      },
    );
  }

  public execute(
    command: GameConfigurationCommand,
    operation?: 'open' | 'close',
  ): Promise<GameMutationResult> {
    if (operation === 'open') return this.openGame(command as OpenGameCommand);
    if (operation === 'close') return this.closeGame(command as CloseGameCommand);
    if ('texts' in command) return this.addTaskEntries(command);
    if ('name' in command) return this.renameGame(command);
    if ('text' in command && 'taskEntryId' in command) return this.editTaskEntry(command);
    if ('text' in command) return this.addTaskEntry(command);
    if ('taskEntryId' in command) return this.removeTaskEntry(command);
    throw new Error('OpenGameCommand and CloseGameCommand require an operation selector.');
  }

  public async read(query: {
    readonly gameId: RenameGameCommand['gameId'];
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly game: GameDto; readonly tasks: readonly TaskEntryDto[] }> {
    try {
      const state =
        this.repository.read === undefined
          ? await this.repository.withGameConfiguration(query.gameId, (state) => state)
          : await this.repository.read(query.gameId);
      return { game: toGameDto(state.game, state.tasks), tasks: toTaskDtos(state.tasks) };
    } catch (error: unknown) {
      if (error instanceof GameConfigurationNotFoundError) {
        throw new HumanBingoError({
          code: DomainErrorCode.NotFound,
          message: 'The requested game was not found.',
          correlationId: query.correlationId,
          retryable: false,
          httpStatus: 404,
        });
      }
      throw error;
    }
  }

  public renameGame(command: RenameGameCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state, now) => {
        const name = normalizeName(command.name, command.correlationId);
        if (state.game.name === name) return false;
        state.game = { ...state.game, name, updatedAt: now };
        return true;
      },
      'rename_game',
    );
  }

  public addTaskEntry(command: AddTaskEntryCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state, now) => {
        assertTaskBagMutable(state, command.correlationId);
        const task = normalizeTaskText(command.text, command.correlationId);
        assertUniqueTask(state, task.normalizedText, undefined, command.correlationId);
        state.tasks.push(
          createTaskEntryRecord({
            gameId: state.game.id,
            displayText: task.displayText,
            normalizedText: task.normalizedText,
            now,
            idFactory: this.idFactory,
          }),
        );
        return true;
      },
      'add_task',
    );
  }

  public addTaskEntries(command: AddTaskEntriesCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state, now) => {
        assertTaskBagMutable(state, command.correlationId);
        if (command.texts.length === 0)
          throw validationError(command.correlationId, 'At least one task is required.', 'texts');
        for (const text of command.texts) {
          const task = normalizeTaskText(text, command.correlationId);
          assertUniqueTask(state, task.normalizedText, undefined, command.correlationId);
          state.tasks.push(
            createTaskEntryRecord({
              gameId: state.game.id,
              displayText: task.displayText,
              normalizedText: task.normalizedText,
              now,
              idFactory: this.idFactory,
            }),
          );
        }
        return true;
      },
      'add_tasks',
    );
  }

  public editTaskEntry(command: EditTaskEntryCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state, now) => {
        assertTaskBagMutable(state, command.correlationId);
        const task = normalizeTaskText(command.text, command.correlationId);
        const existing = state.tasks.find(
          (entry) => entry.id === command.taskEntryId && entry.removedAt === null,
        );
        if (existing === undefined) {
          throw validationError(
            command.correlationId,
            'The task entry does not exist in this game.',
            'taskEntryId',
          );
        }
        assertUniqueTask(state, task.normalizedText, command.taskEntryId, command.correlationId);
        const index = state.tasks.indexOf(existing);
        state.tasks[index] = {
          ...existing,
          displayText: task.displayText,
          normalizedText: task.normalizedText,
          updatedAt: now,
        };
        return true;
      },
      'edit_task',
    );
  }

  public removeTaskEntry(command: RemoveTaskEntryCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state, now) => {
        assertTaskBagMutable(state, command.correlationId);
        const index = state.tasks.findIndex(
          (entry) => entry.id === command.taskEntryId && entry.removedAt === null,
        );
        if (index < 0) {
          throw validationError(
            command.correlationId,
            'The task entry does not exist in this game.',
            'taskEntryId',
          );
        }
        const existing = state.tasks[index];
        if (existing === undefined) {
          throw validationError(
            command.correlationId,
            'The task entry does not exist in this game.',
            'taskEntryId',
          );
        }
        state.tasks[index] = { ...existing, removedAt: now, updatedAt: now };
        return true;
      },
      'remove_task',
    );
  }

  public openGame(command: OpenGameCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state) => {
        if (state.game.status === GameStatus.Draft) {
          const distinctTaskCount = countDistinctTasks(state.tasks);
          if (distinctTaskCount < MINIMUM_TASK_COUNT) {
            throw new HumanBingoError({
              code: DomainErrorCode.InsufficientTasks,
              message: `At least ${MINIMUM_TASK_COUNT} distinct task entries are required to open the game.`,
              correlationId: command.correlationId,
              retryable: false,
              httpStatus: 409,
              metadata: {
                distinctTaskCount,
                requiredTaskCount: MINIMUM_TASK_COUNT,
              },
            });
          }
          state.game = { ...state.game, status: GameStatus.InvitationAvailable };
          return true;
        }
        if (state.game.status === GameStatus.InvitationAvailable) return false;
        if (state.game.status === GameStatus.Active) return false;
        throw gameClosedError(command.correlationId);
      },
      'open_game',
    );
  }

  public closeGame(command: CloseGameCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state, now) => {
        if (state.game.status === GameStatus.Closed) {
          throw gameClosedError(command.correlationId);
        }
        state.game = {
          ...state.game,
          status: GameStatus.Closed,
          closedAt: now,
          updatedAt: now,
        };
        return true;
      },
      'close_game',
    );
  }

  /** Called by onboarding after the first participant is committed successfully. */
  public lockTaskBag(command: LockTaskBagCommand): Promise<GameMutationResult> {
    return this.mutate(
      command,
      (state, now) => {
        if (state.game.taskBagLockedAt !== null) return false;
        if (
          state.game.status !== GameStatus.InvitationAvailable &&
          state.game.status !== GameStatus.Active
        ) {
          if (state.game.status === GameStatus.Closed) throw gameClosedError(command.correlationId);
          throw new HumanBingoError({
            code: DomainErrorCode.InvalidCommand,
            message: 'The game must be open before its task bag can be locked.',
            correlationId: command.correlationId,
            retryable: false,
            httpStatus: 409,
          });
        }
        if (countDistinctTasks(state.tasks) < MINIMUM_TASK_COUNT) {
          throw new HumanBingoError({
            code: DomainErrorCode.InsufficientTasks,
            message: `At least ${MINIMUM_TASK_COUNT} distinct task entries are required before the first participant joins.`,
            correlationId: command.correlationId,
            retryable: false,
            httpStatus: 409,
            metadata: {
              distinctTaskCount: countDistinctTasks(state.tasks),
              requiredTaskCount: MINIMUM_TASK_COUNT,
            },
          });
        }
        state.game = {
          ...state.game,
          status: GameStatus.Active,
          taskBagLockedAt: now,
          updatedAt: now,
        };
        return true;
      },
      'lock_task_bag',
    );
  }

  private async mutate(
    command:
      | RenameGameCommand
      | AddTaskEntryCommand
      | EditTaskEntryCommand
      | RemoveTaskEntryCommand
      | OpenGameCommand
      | CloseGameCommand
      | LockTaskBagCommand,
    mutation: (state: GameConfigurationState, now: Date) => boolean,
    commandNameValue: string,
  ): Promise<GameMutationResult> {
    return observeCommand(
      this.observability,
      {
        correlationId: command.correlationId,
        command: commandNameValue,
        gameId: String(command.gameId),
      },
      async () => {
        try {
          return await this.repository.withGameConfiguration(command.gameId, (state) => {
            if (state.game.status === GameStatus.Closed) {
              throw gameClosedError(command.correlationId);
            }
            assertCurrentVersion(state.game, command.knownStateVersion, command.correlationId);
            const now = new Date(this.now());
            const changed = mutation(state, now);
            if (changed) {
              state.game = {
                ...state.game,
                stateVersion: state.game.stateVersion + 1n,
                updatedAt: now,
              };
            }
            return toMutationResult(state);
          });
        } catch (error: unknown) {
          if (error instanceof GameConfigurationNotFoundError) {
            throw new HumanBingoError({
              code: DomainErrorCode.NotFound,
              message: 'The requested game was not found.',
              correlationId: command.correlationId,
              retryable: false,
              httpStatus: 404,
            });
          }
          throw error;
        }
      },
    );
  }
}

const assertCurrentVersion = (
  game: GameRecord,
  knownStateVersion: StateVersion,
  correlationId: CorrelationId,
): void => {
  if (game.stateVersion !== BigInt(knownStateVersion)) {
    throw new HumanBingoError({
      code: DomainErrorCode.StaleState,
      message: 'The game state has changed; refresh and retry.',
      correlationId,
      retryable: true,
      httpStatus: 409,
      metadata: { currentStateVersion: Number(game.stateVersion) },
    });
  }
};

const assertTaskBagMutable = (
  state: GameConfigurationState,
  correlationId: CorrelationId,
): void => {
  if (state.game.taskBagLockedAt !== null) {
    throw new HumanBingoError({
      code: DomainErrorCode.InvalidCommand,
      message: 'The task bag is locked and requires a new game.',
      correlationId,
      retryable: false,
      httpStatus: 409,
      metadata: { taskBagLocked: true },
    });
  }
};

const assertUniqueTask = (
  state: GameConfigurationState,
  normalizedText: string,
  editedTaskId: TaskEntryRecord['id'] | undefined,
  correlationId: CorrelationId,
): void => {
  const duplicate = state.tasks.some(
    (entry) =>
      entry.removedAt === null &&
      entry.id !== editedTaskId &&
      entry.normalizedText === normalizedText,
  );
  if (duplicate) {
    throw new HumanBingoError({
      code: DomainErrorCode.DuplicateTask,
      message: 'The task is a duplicate after trimming and case-insensitive normalization.',
      correlationId,
      retryable: false,
      httpStatus: 409,
      fieldErrors: [{ field: 'text', message: 'Task text must be unique.' }],
    });
  }
};

const countDistinctTasks = (tasks: readonly TaskEntryRecord[]): number =>
  new Set(tasks.filter((task) => task.removedAt === null).map((task) => task.normalizedText)).size;

const normalizeName = (name: string, correlationId: CorrelationId): string => {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw validationError(correlationId, 'Game name is required.', 'name');
  }
  return normalized;
};

const normalizeTaskText = (
  text: string,
  correlationId: CorrelationId,
): { readonly displayText: string; readonly normalizedText: string } => {
  const displayText = text.trim();
  const normalizedText = displayText.normalize('NFKC').toLocaleLowerCase('en-US');
  if (normalizedText.length === 0) {
    throw new HumanBingoError({
      code: DomainErrorCode.TaskRequired,
      message: 'Task text is required.',
      correlationId,
      retryable: false,
      httpStatus: 422,
      fieldErrors: [{ field: 'text', message: 'Task text is required.' }],
    });
  }
  return { displayText, normalizedText };
};

const validationError = (
  correlationId: CorrelationId,
  message: string,
  field: string,
): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.ValidationError,
    message,
    correlationId,
    retryable: false,
    httpStatus: 422,
    fieldErrors: [{ field, message }],
  });

const gameClosedError = (correlationId: CorrelationId): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.GameClosed,
    message: 'The game is closed.',
    correlationId,
    retryable: false,
    httpStatus: 409,
  });

const toMutationResult = (state: GameConfigurationState): GameMutationResult => ({
  game: toGameDto(state.game, state.tasks),
  tasks: toTaskDtos(state.tasks),
  stateVersion: Number(state.game.stateVersion) as StateVersion,
});

const toGameDto = (game: GameRecord, tasks: readonly TaskEntryRecord[]): GameDto => ({
  id: game.id,
  name: game.name,
  status: game.status,
  distinctTaskCount: countDistinctTasks(tasks),
  taskBagLocked: game.taskBagLockedAt !== null,
  stateVersion: Number(game.stateVersion) as StateVersion,
  createdAt: timestamp(game.createdAt),
  updatedAt: timestamp(game.updatedAt),
  ...(game.closedAt === null ? {} : { closedAt: timestamp(game.closedAt) }),
});

const toTaskDtos = (tasks: readonly TaskEntryRecord[]): TaskEntryDto[] =>
  tasks
    .filter((task) => task.removedAt === null)
    .map((task) => ({
      id: task.id,
      text: task.displayText,
      createdAt: timestamp(task.createdAt),
      updatedAt: timestamp(task.updatedAt),
    }));

const timestamp = (date: Date): Timestamp => date.toISOString() as Timestamp;
