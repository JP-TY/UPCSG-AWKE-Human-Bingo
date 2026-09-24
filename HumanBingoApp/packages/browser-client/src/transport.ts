import {
  DomainErrorCode,
  type GameId,
  type GameSnapshotDto,
  type RealtimeEvent,
  type SnapshotRequiredEvent,
  type StateVersion,
} from '@human-bingo/domain';
import { NormalizedGameCache, type NormalizedGameView, type PatchApplyResult } from './state.js';

export type BrowserFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class GameTransportError extends Error {
  public constructor(
    message: string,
    readonly code?: string,
    readonly retryable = false,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'GameTransportError';
  }
}

export interface SnapshotLoader {
  loadSnapshot(gameId: GameId, sinceVersion?: StateVersion): Promise<GameSnapshotDto>;
}

interface ErrorPayload {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly retryable?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** HTTP snapshot transport used by the browser sync controller. */
export class HttpGameTransport implements SnapshotLoader {
  public constructor(
    private readonly fetcher: BrowserFetcher = fetch,
    private readonly apiPrefix = '/api',
  ) {}

  public async loadSnapshot(gameId: GameId, sinceVersion?: StateVersion): Promise<GameSnapshotDto> {
    const query = sinceVersion === undefined ? '' : `?since_version=${String(sinceVersion)}`;
    const response = await this.fetcher(
      `${this.apiPrefix}/games/${encodeURIComponent(String(gameId))}/snapshot${query}`,
      { credentials: 'include', headers: { Accept: 'application/json' } },
    );
    const payload = await readPayload(response);
    if (!response.ok) throw transportError(response, payload);
    if (!isRecord(payload)) throw new GameTransportError('The game snapshot was invalid.');
    const candidate = 'snapshot' in payload ? payload.snapshot : payload;
    if (!isRecord(candidate) || !isRecord(candidate.game))
      throw new GameTransportError('The game snapshot was invalid.');
    return candidate as unknown as GameSnapshotDto;
  }
}

export interface SyncControlState {
  readonly synchronized: boolean;
  readonly canSubmitStateDependentActions: boolean;
  readonly message?: string;
}

export interface SyncControllerOptions {
  readonly gameId: GameId;
  readonly loader: SnapshotLoader;
  readonly pollIntervalMs?: number;
}

export class SynchronizationRequiredError extends Error {
  public readonly code = DomainErrorCode.SyncRequired;
  public readonly retryable = true;

  public constructor(message = 'Synchronize the game before retrying this action.') {
    super(message);
    this.name = 'SynchronizationRequiredError';
  }
}

export type RealtimeEventResult =
  | {
      readonly status: 'applied' | 'duplicate' | 'stale' | 'ignored' | 'blocked' | 'gap';
      readonly synchronized: boolean;
    }
  | { readonly status: 'snapshot_required'; readonly synchronized: boolean };

function eventIsSnapshotRequired(event: RealtimeEvent): event is SnapshotRequiredEvent {
  return event.type === 'snapshot_required';
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function transportError(response: Response, payload: unknown): GameTransportError {
  const candidate =
    isRecord(payload) && isRecord(payload.error) ? (payload.error as ErrorPayload) : undefined;
  return new GameTransportError(
    typeof candidate?.message === 'string'
      ? candidate.message
      : 'The game request could not be completed.',
    typeof candidate?.code === 'string' ? candidate.code : undefined,
    candidate?.retryable === true,
    response.status,
  );
}

/**
 * Coordinates the normalized cache with snapshots, realtime events, reconnects,
 * stale-command recovery, and a polling fallback when realtime is unavailable.
 */
export class GameSyncController {
  public readonly cache: NormalizedGameCache;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pollInFlight = false;
  private syncInFlight: Promise<boolean> | undefined;
  private retryMessage: string | undefined;

  public constructor(private readonly options: SyncControllerOptions) {
    this.cache = new NormalizedGameCache(options.gameId);
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0)
      throw new RangeError('The polling interval must be positive.');
  }

  public get view(): NormalizedGameView | null {
    return this.cache.current;
  }

  public get isPolling(): boolean {
    return this.pollTimer !== undefined;
  }

  public get controls(): SyncControlState {
    const sync = this.cache.synchronization;
    if (sync.status === 'synchronized') {
      return {
        synchronized: true,
        canSubmitStateDependentActions: true,
        ...(this.retryMessage === undefined ? {} : { message: this.retryMessage }),
      };
    }
    return {
      synchronized: false,
      canSubmitStateDependentActions: false,
      message:
        sync.status === 'synchronizing'
          ? 'Synchronizing the game state…'
          : sync.error === DomainErrorCode.StaleState
            ? 'The game changed. Your state was refreshed; retry the action.'
            : sync.error === DomainErrorCode.SyncFailed
              ? 'Synchronization failed. State-dependent actions are disabled until synchronization succeeds.'
              : 'Synchronize the game before using state-dependent actions.',
    };
  }

  public subscribe(listener: (view: NormalizedGameView | null) => void): () => void {
    return this.cache.subscribe(listener);
  }

  public async loadInitialSnapshot(): Promise<boolean> {
    return this.synchronize(true);
  }

  public async reconnect(): Promise<boolean> {
    this.stopPolling();
    return this.synchronize(true);
  }

  public async handleRealtimeEvent(event: RealtimeEvent): Promise<RealtimeEventResult> {
    if (eventIsSnapshotRequired(event)) {
      this.cache.markSynchronizing();
      const synchronized = await this.synchronize(true);
      return { status: 'snapshot_required', synchronized };
    }

    const result: PatchApplyResult = this.cache.applyPatch(event);
    if (result.status === 'gap') {
      const synchronized = await this.synchronize(true);
      return { status: 'gap', synchronized };
    }
    return {
      status: result.status,
      synchronized: this.cache.synchronization.status === 'synchronized',
    };
  }

  public handleRealtimeDisconnect(): void {
    this.cache.markUnsynchronized(DomainErrorCode.SyncRequired);
    this.startPolling();
  }

  public startPolling(): void {
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      void this.synchronize(false).finally(() => {
        this.pollInFlight = false;
      });
    }, this.pollIntervalMs);
    void this.synchronize(false);
  }

  public stopPolling(): void {
    if (this.pollTimer === undefined) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  public clearRetryMessage(): void {
    this.retryMessage = undefined;
  }

  /** Runs a command only while the cached state is authoritative and current. */
  public async runStateDependent<T>(action: (view: NormalizedGameView) => Promise<T>): Promise<T> {
    const view = this.cache.current;
    if (view === null || this.cache.synchronization.status !== 'synchronized')
      throw new SynchronizationRequiredError();
    try {
      const result = await action(view);
      this.retryMessage = undefined;
      return result;
    } catch (error: unknown) {
      if (errorCode(error) !== DomainErrorCode.StaleState) throw error;
      this.retryMessage = 'The game changed. Your state was refreshed; retry the action.';
      this.cache.markUnsynchronized(DomainErrorCode.StaleState);
      await this.synchronize(true);
      throw error;
    }
  }

  private async synchronize(startFallback: boolean): Promise<boolean> {
    if (this.syncInFlight !== undefined) return this.syncInFlight;
    this.cache.markSynchronizing();
    this.syncInFlight = this.options.loader
      .loadSnapshot(this.options.gameId, this.cache.currentVersion)
      .then((snapshot) => {
        this.cache.replaceSnapshot(snapshot);
        return true;
      })
      .catch(() => {
        this.cache.markUnsynchronized(DomainErrorCode.SyncFailed);
        if (startFallback) this.startPolling();
        return false;
      })
      .finally(() => {
        this.syncInFlight = undefined;
      });
    return this.syncInFlight;
  }
}
