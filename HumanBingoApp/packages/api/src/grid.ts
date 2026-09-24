import { randomBytes, randomUUID } from 'node:crypto';
import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  SquareStatus,
  type CorrelationId,
  type GameId,
  type ParticipantId,
} from '@human-bingo/domain';
import type {
  GridCreationRepository,
  GridState,
  GridRecord,
  SquareRecord,
  TaskEntryRecord,
} from '@human-bingo/persistence';

export interface GenerateGridCommand {
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly correlationId: CorrelationId;
}

export interface GridGenerationResult {
  readonly grid: GridRecord;
  readonly squares: readonly SquareRecord[];
  readonly resumed: boolean;
}

export interface GridServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Injectable only for deterministic tests; production uses node:crypto. */
  readonly randomBytes?: (size: number) => Uint8Array;
}

const GRID_SIZE = 25;
const MAX_RANDOM_RETRIES = 1024;

/**
 * Creates one durable grid for a participant, or returns the already persisted
 * grid on resume. Generation and persistence happen inside the repository's
 * transaction callback, so errors cannot publish a partially populated grid.
 */
export class GridService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly randomBytes: (size: number) => Uint8Array;

  public constructor(
    private readonly repository: GridCreationRepository,
    options: GridServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.randomBytes = options.randomBytes ?? ((size) => randomBytes(size));
  }

  public generateOrResume(command: GenerateGridCommand): Promise<GridGenerationResult> {
    return this.execute(command);
  }

  public generate(command: GenerateGridCommand): Promise<GridGenerationResult> {
    return this.execute(command);
  }

  public generateOrResumeInState(
    state: GridState,
    command: GenerateGridCommand,
  ): GridGenerationResult {
    return this.createOrResume(state, command);
  }

  private async execute(command: GenerateGridCommand): Promise<GridGenerationResult> {
    try {
      return await this.repository.withGridState(command.gameId, command.participantId, (state) =>
        this.createOrResume(state, command),
      );
    } catch (error: unknown) {
      if (error instanceof HumanBingoError) throw error;
      throw new HumanBingoError({
        code: DomainErrorCode.GridGenerationFailed,
        message: 'The grid could not be generated or persisted. Please retry onboarding.',
        correlationId: command.correlationId,
        retryable: true,
        httpStatus: 503,
      });
    }
  }

  private createOrResume(state: GridState, command: GenerateGridCommand): GridGenerationResult {
    const existing = state.grids.filter(
      (grid) => grid.gameId === command.gameId && grid.participantId === command.participantId,
    );
    if (existing.length > 1) {
      throw gridError(
        command.correlationId,
        'More than one grid exists for this participant and game.',
        false,
      );
    }
    const existingGrid = existing[0];
    if (existingGrid !== undefined) {
      const squares = state.squares.filter((square) => square.gridId === existingGrid.id);
      assertPersistedGrid(existingGrid, squares, command.correlationId);
      return { grid: existingGrid, squares: squares.slice(), resumed: true };
    }

    if (state.game.status === GameStatus.Closed) {
      throw new HumanBingoError({
        code: DomainErrorCode.GameClosed,
        message: 'The game is closed.',
        correlationId: command.correlationId,
        retryable: false,
        httpStatus: 409,
      });
    }

    if (state.game.taskBagLockedAt === null) {
      throw gridError(
        command.correlationId,
        'The task bag must be locked before a grid can be generated.',
        false,
      );
    }

    const tasks = distinctActiveTasks(state.tasks);
    if (tasks.length < GRID_SIZE) {
      throw new HumanBingoError({
        code: DomainErrorCode.InsufficientTasks,
        message: 'At least 25 distinct task entries are required to generate a grid.',
        correlationId: command.correlationId,
        retryable: false,
        httpStatus: 409,
        metadata: {
          distinctTaskCount: tasks.length,
          requiredTaskCount: GRID_SIZE,
        },
      });
    }

    const selectedTasks = this.shuffle(tasks).slice(0, GRID_SIZE);
    const createdAt = new Date(this.now());
    const grid: GridRecord = {
      id: this.idFactory() as GridRecord['id'],
      gameId: command.gameId,
      participantId: command.participantId,
      taskBagVersion: 1n,
      stateVersion: state.game.stateVersion,
      createdAt,
    };
    const squares: SquareRecord[] = selectedTasks.map((task, squareIndex) => ({
      gridId: grid.id,
      gameId: command.gameId,
      squareIndex,
      taskEntryId: task.id,
      status: SquareStatus.Unverified,
      updatedAt: new Date(createdAt),
    }));

    state.grids.push(grid);
    state.squares.push(...squares);
    return { grid, squares: squares.slice(), resumed: false };
  }

  private shuffle(tasks: readonly TaskEntryRecord[]): TaskEntryRecord[] {
    const shuffled = [...tasks];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = this.randomIndex(index + 1);
      const current = shuffled[index];
      const replacement = shuffled[swapIndex];
      if (current === undefined || replacement === undefined) {
        throw new Error('The shuffle selected an invalid task position');
      }
      shuffled[index] = replacement;
      shuffled[swapIndex] = current;
    }

    // A sequential arrangement is not a valid generated grid, even if a
    // random source happens to produce that exact permutation.
    const firstTwentyFive = shuffled.slice(0, GRID_SIZE);
    const sequential = firstTwentyFive.every((task, index) => task.id === tasks[index]?.id);
    if (sequential && firstTwentyFive.length > 1) {
      const first = shuffled[0];
      const second = shuffled[1];
      if (first !== undefined && second !== undefined) {
        shuffled[0] = second;
        shuffled[1] = first;
      }
    }
    return shuffled;
  }

  private randomIndex(bound: number): number {
    const range = 0x1_0000_000;
    const limit = Math.floor(range / bound) * bound;
    for (let attempt = 0; attempt < MAX_RANDOM_RETRIES; attempt += 1) {
      const bytes = this.randomBytes(4);
      if (bytes.byteLength < 4) throw new Error('The random source returned too few bytes');
      const value =
        (bytes[0] ?? 0) * 0x1_0000_00 +
        (bytes[1] ?? 0) * 0x1_0000 +
        (bytes[2] ?? 0) * 0x100 +
        (bytes[3] ?? 0);
      if (value < limit) return value % bound;
    }
    throw new Error('The cryptographic random source did not produce an acceptable value');
  }
}

export function distinctActiveTasks(tasks: readonly TaskEntryRecord[]): TaskEntryRecord[] {
  const seen = new Set<string>();
  const result: TaskEntryRecord[] = [];
  for (const task of tasks) {
    if (task.removedAt !== null || seen.has(task.normalizedText)) continue;
    seen.add(task.normalizedText);
    result.push(task);
  }
  return result;
}

function assertPersistedGrid(
  grid: GridRecord,
  squares: readonly SquareRecord[],
  correlationId: CorrelationId,
): void {
  const indexes = new Set<number>();
  const taskIds = new Set<string>();
  for (const square of squares) {
    if (
      square.gridId !== grid.id ||
      square.gameId !== grid.gameId ||
      square.squareIndex < 0 ||
      square.squareIndex >= GRID_SIZE ||
      indexes.has(square.squareIndex) ||
      taskIds.has(square.taskEntryId)
    ) {
      throw gridError(correlationId, 'The persisted grid is incomplete or inconsistent.', false);
    }
    indexes.add(square.squareIndex);
    taskIds.add(square.taskEntryId);
  }
  if (squares.length !== GRID_SIZE || indexes.size !== GRID_SIZE || taskIds.size !== GRID_SIZE) {
    throw gridError(correlationId, 'The persisted grid is incomplete or inconsistent.', false);
  }
}

function gridError(
  correlationId: CorrelationId,
  message: string,
  retryable: boolean,
): HumanBingoError {
  return new HumanBingoError({
    code: DomainErrorCode.GridGenerationFailed,
    message,
    correlationId,
    retryable,
    httpStatus: retryable ? 503 : 409,
  });
}
