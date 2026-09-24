import type {
  CompletionRecord,
  GameId,
  GameRecord,
  GridRecord,
  MembershipRecord,
  NotificationRecord,
  ParticipantRecord,
  PlayerProfileRecord,
  SquareRecord,
  TaskEntryRecord,
  VerificationRequestRecord,
} from './models.js';

/**
 * Transaction-scoped aggregate used by verification commands. A PostgreSQL
 * implementation can map this callback to a serializable transaction which
 * locks the game and target square rows. The in-memory implementation mirrors
 * the same commit-on-success semantics for service and integration tests.
 */
export interface VerificationState {
  game: GameRecord;
  tasks: TaskEntryRecord[];
  memberships: MembershipRecord[];
  participants: ParticipantRecord[];
  profiles: PlayerProfileRecord[];
  grids: GridRecord[];
  squares: SquareRecord[];
  verificationRequests: VerificationRequestRecord[];
  notifications: NotificationRecord[];
  completions: CompletionRecord[];
  /** Values are opaque to persistence and owned by the application service. */
  idempotency: Map<string, unknown>;
}

export interface VerificationRepository {
  read?(gameId: GameId): Promise<VerificationState>;
  withVerificationState<Result>(
    gameId: GameId,
    mutation: (state: VerificationState) => Promise<Result> | Result,
  ): Promise<Result>;
}

export interface InMemoryVerificationRepositoryOptions {
  readonly states?: readonly VerificationState[];
}

export class VerificationGameNotFoundError extends Error {
  public constructor(gameId: GameId) {
    super(`Verification game ${gameId} was not found`);
    this.name = 'VerificationGameNotFoundError';
  }
}

/**
 * Transactional repository for verification tests and the local runtime. Each
 * game has a FIFO lock, and failed callbacks never publish their staged rows.
 */
export class InMemoryVerificationRepository implements VerificationRepository {
  private readonly games = new Map<GameId, VerificationState>();
  private readonly locks = new Map<GameId, Promise<void>>();

  public constructor(options: InMemoryVerificationRepositoryOptions = {}) {
    for (const state of options.states ?? []) this.games.set(state.game.id, cloneState(state));
  }

  public seed(state: VerificationState): void {
    if (this.games.has(state.game.id)) throw new Error(`Game ${state.game.id} already exists`);
    this.games.set(state.game.id, cloneState(state));
  }

  public read(gameId: GameId): Promise<VerificationState> {
    const state = this.games.get(gameId);
    if (state === undefined) throw new VerificationGameNotFoundError(gameId);
    return Promise.resolve(cloneState(state));
  }

  public async withVerificationState<Result>(
    gameId: GameId,
    mutation: (state: VerificationState) => Promise<Result> | Result,
  ): Promise<Result> {
    const previous = this.locks.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(gameId, current);
    await previous;

    try {
      const stored = this.games.get(gameId);
      if (stored === undefined) throw new VerificationGameNotFoundError(gameId);
      const staged = cloneState(stored);
      const result = await mutation(staged);
      this.games.set(gameId, cloneState(staged));
      return result;
    } finally {
      release();
      if (this.locks.get(gameId) === current) this.locks.delete(gameId);
    }
  }
}

export function emptyVerificationState(input: {
  readonly game: GameRecord;
  readonly tasks?: readonly TaskEntryRecord[];
  readonly memberships?: readonly MembershipRecord[];
  readonly participants?: readonly ParticipantRecord[];
  readonly profiles?: readonly PlayerProfileRecord[];
  readonly grids?: readonly GridRecord[];
  readonly squares?: readonly SquareRecord[];
  readonly verificationRequests?: readonly VerificationRequestRecord[];
  readonly notifications?: readonly NotificationRecord[];
  readonly completions?: readonly CompletionRecord[];
}): VerificationState {
  return {
    game: cloneGame(input.game),
    tasks: (input.tasks ?? []).map(cloneTask),
    memberships: (input.memberships ?? []).map(cloneMembership),
    participants: (input.participants ?? []).map(cloneParticipant),
    profiles: (input.profiles ?? []).map(cloneProfile),
    grids: (input.grids ?? []).map(cloneGrid),
    squares: (input.squares ?? []).map(cloneSquare),
    verificationRequests: (input.verificationRequests ?? []).map(cloneRequest),
    notifications: (input.notifications ?? []).map(cloneNotification),
    completions: (input.completions ?? []).map(cloneCompletion),
    idempotency: new Map(),
  };
}

const cloneState = (state: VerificationState): VerificationState => ({
  game: cloneGame(state.game),
  tasks: state.tasks.map(cloneTask),
  memberships: state.memberships.map(cloneMembership),
  participants: state.participants.map(cloneParticipant),
  profiles: state.profiles.map(cloneProfile),
  grids: state.grids.map(cloneGrid),
  squares: state.squares.map(cloneSquare),
  verificationRequests: state.verificationRequests.map(cloneRequest),
  notifications: state.notifications.map(cloneNotification),
  completions: state.completions.map(cloneCompletion),
  idempotency: new Map(state.idempotency),
});

const cloneGame = (record: GameRecord): GameRecord => ({
  ...record,
  taskBagLockedAt: record.taskBagLockedAt === null ? null : new Date(record.taskBagLockedAt),
  closedAt: record.closedAt === null ? null : new Date(record.closedAt),
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

const cloneTask = (record: TaskEntryRecord): TaskEntryRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  removedAt: record.removedAt === null ? null : new Date(record.removedAt),
});

const cloneMembership = (record: MembershipRecord): MembershipRecord => ({
  ...record,
  resumableCredentialHash: new Uint8Array(record.resumableCredentialHash),
  createdAt: new Date(record.createdAt),
  lastSeenAt: new Date(record.lastSeenAt),
});

const cloneParticipant = (record: ParticipantRecord): ParticipantRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  leftAt: record.leftAt === null ? null : new Date(record.leftAt),
});

const cloneProfile = (record: PlayerProfileRecord): PlayerProfileRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
});

const cloneGrid = (record: GridRecord): GridRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
});

const cloneSquare = (record: SquareRecord): SquareRecord => ({
  ...record,
  updatedAt: new Date(record.updatedAt),
});

const cloneRequest = (record: VerificationRequestRecord): VerificationRequestRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  resolvedAt: record.resolvedAt === null ? null : new Date(record.resolvedAt),
});

const cloneNotification = (record: NotificationRecord): NotificationRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  resolvedAt: record.resolvedAt === null ? null : new Date(record.resolvedAt),
});

const cloneCompletion = (record: CompletionRecord): CompletionRecord => ({
  ...record,
  completedAt: new Date(record.completedAt),
  createdAt: new Date(record.createdAt),
});
