import type { GameId, RealtimeEvent, StateVersion } from '@human-bingo/domain';

/**
 * Minimal WebSocket surface used by the realtime client. The browser
 * `WebSocket` implementation is structurally compatible.
 */
export interface RealtimeSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RealtimeSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface RealtimeBackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const defaultRealtimeBackoff: RealtimeBackoffOptions = {
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

export interface RealtimeClientOptions {
  readonly wsUrl: string;
  readonly gameId: GameId;
  readonly initialStateVersion?: StateVersion;
  readonly onEvent: (event: RealtimeEvent) => void;
  readonly onStatusChange?: (status: RealtimeSocketStatus) => void;
  readonly socketFactory?: (url: string) => RealtimeSocketLike;
  readonly backoff?: RealtimeBackoffOptions;
  readonly random?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const PONG = JSON.stringify({ type: 'pong' });

/**
 * Browser realtime subscription for one game channel. The server session
 * cookie authenticates the handshake, so no credential is placed in the URL.
 * The server publishes `game.patch` and `snapshot_required` events and expects
 * a `pong` reply for heartbeats; every event delegates to the caller, which
 * refreshes its authoritative HTTP view without a manual reload.
 */
export class RealtimeGameSocket {
  readonly #options: RealtimeClientOptions;
  #socket: RealtimeSocketLike | null = null;
  #status: RealtimeSocketStatus = 'closed';
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closedByCaller = false;
  #lastKnownStateVersion: number;
  #lastHealthyAt = 0;

  public constructor(options: RealtimeClientOptions) {
    this.#options = options;
    this.#lastKnownStateVersion = Number(options.initialStateVersion ?? 0);
    if (!Number.isFinite(options.backoff?.baseDelayMs ?? 1)) {
      throw new RangeError('Realtime backoff options must be finite');
    }
  }

  public get status(): RealtimeSocketStatus {
    return this.#status;
  }

  public get isHealthy(): boolean {
    return this.#status === 'connected' && Date.now() - this.#lastHealthyAt < 35_000;
  }

  public connect(): void {
    if (this.#socket !== null) return;
    this.#closedByCaller = false;
    this.#open();
  }

  public close(): void {
    this.#closedByCaller = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'Subscription closed');
      } catch {
        // A transport may already be gone; the closed state is authoritative.
      }
    }
    this.#setStatus('closed');
  }

  /** Acknowledge the authoritative HTTP snapshot that follows a gap event. */
  public acknowledgeStateVersion(stateVersion: StateVersion): void {
    this.#lastKnownStateVersion = Number(stateVersion);
    this.#sendAcknowledgement();
  }

  #sendAcknowledgement(): void {
    try {
      this.#socket?.send(
        JSON.stringify({ type: 'synchronized', stateVersion: this.#lastKnownStateVersion }),
      );
    } catch {
      // The reconnect path will advertise the latest known version again.
    }
  }

  #open(): void {
    const separator = this.#options.wsUrl.includes('?') ? '&' : '?';
    const url = `${this.#options.wsUrl}${separator}gameId=${encodeURIComponent(String(this.#options.gameId))}&lastKnownStateVersion=${this.#lastKnownStateVersion}`;
    this.#lastHealthyAt = 0;
    this.#setStatus(
      this.#status === 'connected' || this.#status === 'reconnecting'
        ? 'reconnecting'
        : 'connecting',
    );
    let socket: RealtimeSocketLike;
    try {
      socket = this.#options.socketFactory === undefined ? nativeSocket(url) : this.#options.socketFactory(url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#setStatus('connected');
      this.#sendAcknowledgement();
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket) this.#handleMessage(event.data);
    };
    socket.onclose = (event) => {
      if (this.#socket === socket) this.#handleClose(event);
    };
    socket.onerror = () => {
      // The close event carries the failure result; nothing else to do here.
    };
  }

  #handleMessage(data: unknown): void {
    let payload: unknown = data;
    if (typeof data === 'string') {
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        return;
      }
    }
    if (!isRecord(payload)) return;
    if (payload.type === 'ping') {
      this.#lastHealthyAt = Date.now();
      this.#reconnectAttempt = 0;
      try {
        this.#socket?.send(PONG);
      } catch {
        // A failing transport is recovered by the close/reconnect cycle.
      }
      return;
    }
    if (payload.type === 'pong') return;
    if (
      payload.type === 'game.patch' ||
      payload.type === 'snapshot_required' ||
      payload.type === 'snapshot.required'
    ) {
      this.#lastHealthyAt = Date.now();
      if (
        payload.type === 'game.patch' &&
        typeof payload.stateVersion === 'number' &&
        Number.isSafeInteger(payload.stateVersion) &&
        payload.stateVersion >= 0
      ) {
        this.#lastKnownStateVersion = payload.stateVersion;
      }
      this.#reconnectAttempt = 0;
      this.#options.onEvent(payload as unknown as RealtimeEvent);
    }
  }

  #handleClose(event: unknown): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    if (this.#closedByCaller) return;
    if (isRecord(event) && event.code === 1008) {
      this.#setStatus('closed');
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closedByCaller) return;
    if (this.#reconnectTimer !== null) return;
    this.#setStatus('reconnecting');
    const backoff = this.#options.backoff ?? defaultRealtimeBackoff;
    const random = this.#options.random ?? Math.random;
    const exponential = Math.min(
      backoff.maxDelayMs,
      backoff.baseDelayMs * 2 ** this.#reconnectAttempt,
    );
    const jitter = exponential * backoff.jitterRatio * (random() * 2 - 1);
    const delay = Math.round(Math.max(0, Math.min(backoff.maxDelayMs, exponential + jitter)));
    this.#reconnectAttempt = Math.min(this.#reconnectAttempt + 1, 16);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
  }

  #setStatus(status: RealtimeSocketStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatusChange?.(status);
  }
}

const nativeSocket = (url: string): RealtimeSocketLike => {
  if (typeof WebSocket === 'undefined') throw new Error('WebSocket is not available');
  return new WebSocket(url) as unknown as RealtimeSocketLike;
};
