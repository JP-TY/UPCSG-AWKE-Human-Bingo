import type {
  CompletionDto,
  GameId,
  GamePatchDto,
  GameSnapshotDto,
  GridDto,
  GridSquareDto,
  LeaderboardsDto,
  NotificationDto,
  OutboxEventId,
  StateVersion,
  SyncState,
  TaskEntryDto,
  VerificationRequestDto,
} from '@human-bingo/domain';
import { DomainErrorCode } from '@human-bingo/domain';

export type NormalizedGridView = Omit<GridDto, 'squares'>;

/**
 * The member-scoped game view held by the browser. Entity collections are
 * normalized so a patch can replace only the records named by the server.
 */
export interface NormalizedGameView {
  readonly gameId: GameId;
  readonly game: GameSnapshotDto['game'];
  readonly tasks: ReadonlyMap<TaskEntryDto['id'], TaskEntryDto>;
  readonly membership: GameSnapshotDto['membership'];
  readonly participant: GameSnapshotDto['participant'];
  readonly profile: GameSnapshotDto['profile'];
  readonly grid: NormalizedGridView;
  readonly squares: ReadonlyMap<string, GridSquareDto>;
  readonly verificationRequests: ReadonlyMap<VerificationRequestDto['id'], VerificationRequestDto>;
  readonly notifications: ReadonlyMap<NotificationDto['id'], NotificationDto>;
  readonly completions: ReadonlyMap<CompletionDto['id'], CompletionDto>;
  readonly leaderboards: LeaderboardsDto;
  readonly stateVersion: StateVersion;
  readonly sync: SyncState;
  readonly lastEventId?: OutboxEventId;
}

export type PatchApplyResult =
  | { readonly status: 'applied'; readonly view: NormalizedGameView }
  | { readonly status: 'duplicate'; readonly view: NormalizedGameView }
  | { readonly status: 'stale'; readonly view: NormalizedGameView }
  | { readonly status: 'gap'; readonly view: NormalizedGameView }
  | { readonly status: 'blocked'; readonly view: NormalizedGameView }
  | { readonly status: 'ignored'; readonly view: NormalizedGameView };

export type GameViewListener = (view: NormalizedGameView | null) => void;

function squareKey(gridId: string, squareIndex: number): string {
  return `${gridId}:${squareIndex}`;
}

function mapValues<Value extends { readonly id: string }>(
  values: readonly Value[],
): Map<Value['id'], Value> {
  return new Map(values.map((value) => [value.id, value]));
}

function mapSquares(values: readonly GridSquareDto[]): Map<string, GridSquareDto> {
  return new Map(
    values.map((value) => [squareKey(String(value.gridId), value.squareIndex), value]),
  );
}

function mergeRecords<Value extends { readonly id: string }>(
  current: ReadonlyMap<Value['id'], Value>,
  changes: readonly Value[],
): Map<Value['id'], Value> {
  const next = new Map(current);
  for (const record of changes) next.set(record.id, record);
  return next;
}

function mergeSquares(
  current: ReadonlyMap<string, GridSquareDto>,
  changes: readonly GridSquareDto[],
  gridId: string,
): Map<string, GridSquareDto> {
  const next = new Map(current);
  for (const square of changes) {
    if (String(square.gridId) === gridId) next.set(squareKey(gridId, square.squareIndex), square);
  }
  return next;
}

function normalizeSnapshot(snapshot: GameSnapshotDto): NormalizedGameView {
  const grid: NormalizedGridView = {
    id: snapshot.grid.id,
    gameId: snapshot.grid.gameId,
    participantId: snapshot.grid.participantId,
    taskBagVersion: snapshot.grid.taskBagVersion,
    stateVersion: snapshot.grid.stateVersion,
    createdAt: snapshot.grid.createdAt,
  };
  return {
    gameId: snapshot.game.id,
    game: snapshot.game,
    tasks: mapValues(snapshot.tasks),
    membership: snapshot.membership,
    participant: snapshot.participant,
    profile: snapshot.profile,
    grid,
    squares: mapSquares(snapshot.grid.squares),
    verificationRequests: mapValues(snapshot.verificationRequests),
    notifications: mapValues(snapshot.notifications),
    completions: new Map(
      [
        ...snapshot.leaderboards.blackout.entries,
        ...snapshot.leaderboards.line.entries,
        ...snapshot.leaderboards.hashtag.entries,
      ]
        .flatMap((entry) => entry.completions)
        .map((completion) => [completion.id, completion]),
    ),
    leaderboards: snapshot.leaderboards,
    stateVersion: snapshot.stateVersion,
    sync: { status: 'synchronized', stateVersion: snapshot.stateVersion },
  };
}

/** A normalized, immutable-on-read cache for one authorized game's snapshot. */
export class NormalizedGameCache {
  private view: NormalizedGameView | null = null;
  private sync: SyncState = { status: 'unsynchronized', error: DomainErrorCode.SyncRequired };
  private readonly eventIds = new Set<string>();
  private readonly listeners = new Set<GameViewListener>();

  public constructor(private readonly gameId: GameId) {}

  public get current(): NormalizedGameView | null {
    return this.view;
  }

  public get currentVersion(): StateVersion | undefined {
    return this.view?.stateVersion;
  }

  public get synchronization(): SyncState {
    return this.view?.sync ?? this.sync;
  }

  public subscribe(listener: GameViewListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public replaceSnapshot(snapshot: GameSnapshotDto): NormalizedGameView {
    if (String(snapshot.game.id) !== String(this.gameId))
      throw new Error('The snapshot belongs to a different game.');
    this.eventIds.clear();
    this.view = normalizeSnapshot(snapshot);
    this.sync = this.view.sync;
    this.emit();
    return this.view;
  }

  public markSynchronizing(): void {
    this.setSync({
      status: 'synchronizing',
      ...(this.currentVersion === undefined ? {} : { stateVersion: this.currentVersion }),
    });
  }

  public markUnsynchronized(error: DomainErrorCode = DomainErrorCode.SyncRequired): void {
    this.setSync({
      status: 'unsynchronized',
      error,
      ...(this.currentVersion === undefined ? {} : { stateVersion: this.currentVersion }),
    });
  }

  public applyPatch(patch: GamePatchDto): PatchApplyResult {
    if (this.view === null) throw new Error('A snapshot is required before applying a patch.');
    if (String(patch.gameId) !== String(this.gameId)) return { status: 'ignored', view: this.view };
    if (this.eventIds.has(String(patch.eventId))) return { status: 'duplicate', view: this.view };
    if (this.view.sync.status !== 'synchronized') return { status: 'blocked', view: this.view };

    const currentVersion = Number(this.view.stateVersion);
    const previousVersion = Number(patch.previousStateVersion);
    const nextVersion = Number(patch.stateVersion);
    if (previousVersion === currentVersion - 1 && nextVersion === currentVersion) {
      return { status: 'stale', view: this.view };
    }
    if (previousVersion !== currentVersion || nextVersion !== currentVersion + 1) {
      this.markUnsynchronized(DomainErrorCode.SyncRequired);
      return { status: 'gap', view: this.view };
    }

    const changes = patch.changes;
    const next: NormalizedGameView = {
      ...this.view,
      ...(changes.game === undefined ? {} : { game: changes.game }),
      ...(changes.tasks === undefined
        ? {}
        : { tasks: mergeRecords(this.view.tasks, changes.tasks) }),
      ...(changes.squares === undefined
        ? {}
        : { squares: mergeSquares(this.view.squares, changes.squares, String(this.view.grid.id)) }),
      ...(changes.verificationRequests === undefined
        ? {}
        : {
            verificationRequests: mergeRecords(
              this.view.verificationRequests,
              changes.verificationRequests,
            ),
          }),
      ...(changes.notifications === undefined
        ? {}
        : { notifications: mergeRecords(this.view.notifications, changes.notifications) }),
      ...(changes.completions === undefined
        ? {}
        : { completions: mergeRecords(this.view.completions, changes.completions) }),
      ...(changes.leaderboards === undefined
        ? {}
        : { leaderboards: { ...this.view.leaderboards, ...changes.leaderboards } }),
      stateVersion: patch.stateVersion,
      sync: { status: 'synchronized', stateVersion: patch.stateVersion },
      lastEventId: patch.eventId,
    };
    this.eventIds.add(String(patch.eventId));
    this.view = next;
    this.sync = next.sync;
    this.emit();
    return { status: 'applied', view: next };
  }

  public toSnapshot(): GameSnapshotDto | null {
    if (this.view === null) return null;
    return {
      game: this.view.game,
      tasks: [...this.view.tasks.values()],
      membership: this.view.membership,
      participant: this.view.participant,
      profile: this.view.profile,
      grid: {
        ...this.view.grid,
        squares: [...this.view.squares.values()].sort(
          (left, right) => left.squareIndex - right.squareIndex,
        ),
      },
      verificationRequests: [...this.view.verificationRequests.values()],
      notifications: [...this.view.notifications.values()],
      leaderboards: this.view.leaderboards,
      stateVersion: this.view.stateVersion,
    };
  }

  private setSync(sync: SyncState): void {
    this.sync = sync;
    if (this.view !== null) {
      this.view = { ...this.view, sync };
      this.emit();
    } else {
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.view);
  }
}
