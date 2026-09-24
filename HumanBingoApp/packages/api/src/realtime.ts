import type {
  GameId,
  GamePatchDto,
  OutboxEventId,
  ParticipantId,
  PatchChanges,
  RealtimeEvent,
  SnapshotRequiredEvent,
  StateVersion,
} from '@human-bingo/domain';
import type { OutboxEventRecord } from '@human-bingo/persistence';
import type {
  AuthorizationPrincipal,
  WebSocketSubscriptionPolicy,
} from './access/authorization.js';
import { recordEventDelivery } from './observability.js';
import type { Observability } from './observability.js';

export const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

export class RealtimePayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RealtimePayloadError';
  }
}

const SECRET_KEY =
  /(authorization|cookie|credential|password|push|secret|session|subscription|token)/i;

const assertSafePayload = (value: unknown, key?: string): void => {
  if (key !== undefined && SECRET_KEY.test(key))
    throw new RealtimePayloadError('Realtime payload contains a secret field');
  if (Array.isArray(value)) {
    for (const item of value) assertSafePayload(item);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, childValue] of Object.entries(value))
      assertSafePayload(childValue, childKey);
  }
};

export const encodeBoundedRealtimeEvent = (
  event: RealtimeEvent,
  maxBytes = DEFAULT_MAX_EVENT_BYTES,
): string => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError('Maximum event size must be positive');
  assertSafePayload(event);
  const encoded = JSON.stringify(event);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new RealtimePayloadError('Realtime event exceeds the maximum payload size');
  }
  return encoded;
};

export interface ReconnectBackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const defaultReconnectBackoff: ReconnectBackoffOptions = {
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};

export const reconnectDelay = (
  attempt: number,
  options: ReconnectBackoffOptions = defaultReconnectBackoff,
  random: () => number = Math.random,
): number => {
  if (!Number.isInteger(attempt) || attempt < 0)
    throw new RangeError('Reconnect attempt must be non-negative');
  if (
    options.baseDelayMs <= 0 ||
    options.maxDelayMs < options.baseDelayMs ||
    options.jitterRatio < 0 ||
    options.jitterRatio > 1
  ) {
    throw new RangeError('Invalid reconnect backoff options');
  }
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  const jitter = exponential * options.jitterRatio * (random() * 2 - 1);
  return Math.round(Math.max(0, Math.min(options.maxDelayMs, exponential + jitter)));
};

export interface HeartbeatOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly maxMissedPongs: number;
}

export type HeartbeatStatus = 'healthy' | 'stale';

export class HeartbeatMonitor {
  readonly #options: HeartbeatOptions;
  #lastPongAt: number;
  #missedPongs = 0;

  public constructor(options: HeartbeatOptions, startedAt = Date.now()) {
    if (options.intervalMs <= 0 || options.timeoutMs <= 0 || options.maxMissedPongs < 1) {
      throw new RangeError('Heartbeat options must be positive');
    }
    this.#options = options;
    this.#lastPongAt = startedAt;
  }

  public receivePong(at = Date.now()): void {
    this.#lastPongAt = at;
    this.#missedPongs = 0;
  }

  public check(at = Date.now()): HeartbeatStatus {
    const elapsed = at - this.#lastPongAt;
    if (elapsed <= this.#options.intervalMs + this.#options.timeoutMs) {
      return 'healthy';
    }
    this.#missedPongs = Math.max(
      0,
      Math.floor((elapsed - this.#options.timeoutMs) / this.#options.intervalMs),
    );
    return this.#missedPongs >= this.#options.maxMissedPongs ? 'stale' : 'healthy';
  }

  public get missedPongs(): number {
    return this.#missedPongs;
  }
}

export interface RealtimeSocket {
  readonly send: (data: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly onMessage: (listener: (data: string | Uint8Array | ArrayBuffer) => void) => void;
  readonly onClose: (listener: () => void) => void;
}

/**
 * The adapter authenticates the credential from the WebSocket handshake. It
 * must not receive credentials from a URL or from client-published events.
 */
export interface RealtimeSessionAuthenticator {
  readonly authenticate: (sessionCredential: string) => Promise<AuthorizationPrincipal>;
}

export interface RealtimeConnectionRequest {
  readonly gameId: GameId;
  readonly sessionCredential: string;
  readonly lastKnownStateVersion?: StateVersion;
}

export interface RealtimeGatewayOptions {
  readonly maxEventBytes?: number;
  readonly retainedEvents?: number;
  readonly heartbeat?: HeartbeatOptions;
  readonly observability?: Observability;
  readonly now?: () => number;
  /**
   * Highest state version already published for a game, used to seed a new
   * in-memory channel so reconnecting clients are not re-synchronized into an
   * acknowledgement loop after an API restart wiped the channel state.
   */
  readonly seedVersion?: (gameId: GameId) => Promise<StateVersion>;
}

export interface RealtimeConnection {
  readonly gameId: GameId;
  readonly participantId: ParticipantId | undefined;
  /** Mark the connection usable again after an authoritative HTTP snapshot. */
  readonly markSynchronized: (stateVersion: StateVersion) => void;
  /** Request a fresh authoritative snapshot without publishing a client event. */
  readonly requestSnapshot: (reason?: SnapshotRequiredEvent['reason']) => void;
  readonly close: (code?: number, reason?: string) => void;
}

export class RealtimeProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RealtimeProtocolError';
  }
}

export class RealtimeOrderingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RealtimeOrderingError';
  }
}

interface RetainedPatch {
  readonly version: number;
  readonly eventId: OutboxEventId;
  readonly encoded: string;
  readonly event: GamePatchDto;
}

interface GatewayChannel {
  readonly gameId: GameId;
  currentVersion: number;
  readonly patches: Map<number, RetainedPatch>;
  readonly seenEventIds: Set<string>;
  readonly clients: Set<GatewayClient>;
}

interface GatewayClient {
  readonly channel: GatewayChannel;
  readonly socket: RealtimeSocket;
  readonly monitor: HeartbeatMonitor;
  readonly sentEventIds: Set<string>;
  readonly participantId: ParticipantId | undefined;
  lastStateVersion: number | null;
  synchronizing: boolean;
  closed: boolean;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

const DEFAULT_GATEWAY_HEARTBEAT: HeartbeatOptions = {
  intervalMs: 15_000,
  timeoutMs: 5_000,
  maxMissedPongs: 2,
};

const PATCH_CHANGE_KEYS = new Set([
  'game',
  'tasks',
  'squares',
  'verificationRequests',
  'notifications',
  'completions',
  'leaderboards',
]);

const safeStateVersion = (value: number | bigint, label: string): number => {
  const numberValue = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new RealtimeOrderingError(`${label} must be a non-negative safe integer`);
  }
  return numberValue;
};

const stateVersionValue = (value: number): StateVersion => value as StateVersion;

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RealtimePayloadError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};

const changesFromOutboxPayload = (payload: Record<string, unknown>): PatchChanges => {
  assertSafePayload(payload);
  const candidate = payload.changes === undefined ? payload : payload.changes;
  const changes = asObject(candidate, 'Outbox changes');
  for (const key of Object.keys(changes)) {
    if (!PATCH_CHANGE_KEYS.has(key)) {
      throw new RealtimePayloadError(`Unsupported realtime change field: ${key}`);
    }
  }
  return changes as PatchChanges;
};

const encodeControlMessage = (message: Record<string, unknown>, maxBytes: number): string => {
  assertSafePayload(message);
  const encoded = JSON.stringify(message);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new RealtimePayloadError('Realtime control message exceeds the maximum payload size');
  }
  return encoded;
};

const decodeIncomingMessage = (
  data: string | Uint8Array | ArrayBuffer,
  maxBytes: number,
): Record<string, unknown> => {
  const bytes =
    typeof data === 'string'
      ? Buffer.byteLength(data, 'utf8')
      : data instanceof ArrayBuffer
        ? data.byteLength
        : data.byteLength;
  if (bytes > maxBytes)
    throw new RealtimeProtocolError('Incoming realtime message exceeds the maximum payload size');
  const text =
    typeof data === 'string'
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RealtimeProtocolError('Incoming realtime message is not valid JSON');
  }
  return asObject(parsed, 'Incoming realtime message');
};

/**
 * Authenticated, server-published game channel gateway. The gateway only
 * accepts heartbeat acknowledgements and authoritative snapshot acknowledgements
 * from clients; game patches are always published from an authoritative outbox
 * event by the server.
 */
export class RealtimeGateway {
  readonly #authorization: WebSocketSubscriptionPolicy;
  readonly #authenticator: RealtimeSessionAuthenticator;
  readonly #maxEventBytes: number;
  readonly #retainedEvents: number;
  readonly #heartbeat: HeartbeatOptions;
  readonly #observability: Observability | undefined;
  readonly #now: () => number;
  readonly #seedVersion: ((gameId: GameId) => Promise<StateVersion>) | undefined;
  readonly #channels = new Map<GameId, GatewayChannel>();

  public constructor(
    authorization: WebSocketSubscriptionPolicy,
    authenticator: RealtimeSessionAuthenticator,
    options: RealtimeGatewayOptions = {},
  ) {
    this.#authorization = authorization;
    this.#authenticator = authenticator;
    this.#maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.#retainedEvents = options.retainedEvents ?? 256;
    this.#heartbeat = options.heartbeat ?? DEFAULT_GATEWAY_HEARTBEAT;
    this.#observability = options.observability;
    this.#now = options.now ?? (() => Date.now());
    this.#seedVersion = options.seedVersion;
    if (!Number.isInteger(this.#maxEventBytes) || this.#maxEventBytes <= 0) {
      throw new RangeError('Maximum event size must be positive');
    }
    if (!Number.isInteger(this.#retainedEvents) || this.#retainedEvents < 1) {
      throw new RangeError('Retained event count must be positive');
    }
  }

  /** Authenticate and authorize the game channel before registering handlers. */
  public async accept(
    socket: RealtimeSocket,
    request: RealtimeConnectionRequest,
  ): Promise<RealtimeConnection> {
    if (request.sessionCredential.trim().length === 0) {
      throw new RealtimeProtocolError('A session credential is required');
    }
    const principal = await this.#authenticator.authenticate(request.sessionCredential);
    const authorization = await this.#authorization.authorize({
      gameId: request.gameId,
      principal,
    });
    const channel = await this.#channel(request.gameId);
    const participantId: ParticipantId | undefined =
      'participantId' in authorization ? authorization.participantId : undefined;
    const client: GatewayClient = {
      channel,
      socket,
      monitor: new HeartbeatMonitor(this.#heartbeat, this.#now()),
      sentEventIds: new Set<string>(),
      participantId,
      lastStateVersion:
        request.lastKnownStateVersion === undefined
          ? null
          : safeStateVersion(request.lastKnownStateVersion, 'Last known state version'),
      synchronizing: false,
      closed: false,
      heartbeatTimer: setInterval(() => this.#heartbeatTick(client), this.#heartbeat.intervalMs),
    };
    channel.clients.add(client);
    socket.onMessage((data) => this.#handleMessage(client, data));
    socket.onClose(() => this.#removeClient(client));
    this.#synchronizeOnConnect(client);
    return {
      gameId: request.gameId,
      participantId,
      markSynchronized: (stateVersion) => this.#markSynchronized(client, stateVersion),
      requestSnapshot: (reason = 'reconnect') => this.#requireSnapshot(client, reason),
      close: (code, reason) => this.#closeClient(client, code, reason),
    };
  }

  /** Publish one committed outbox mutation to every authorized subscriber. */
  public async publish(event: OutboxEventRecord): Promise<boolean> {
    const channel = await this.#channel(event.gameId);
    const eventId = String(event.id);
    if (channel.seenEventIds.has(eventId)) return false;

    const version = safeStateVersion(event.stateVersion, 'Outbox state version');
    if (version <= channel.currentVersion) {
      throw new RealtimeOrderingError(`Outbox event ${eventId} is older than the channel version`);
    }
    const patch: GamePatchDto = {
      type: 'game.patch',
      gameId: event.gameId,
      stateVersion: stateVersionValue(version),
      previousStateVersion: stateVersionValue(Math.max(0, version - 1)),
      eventId: event.id,
      changes: changesFromOutboxPayload(event.payload),
    };
    const encoded = encodeBoundedRealtimeEvent(patch, this.#maxEventBytes);
    const retained: RetainedPatch = { version, eventId: event.id, encoded, event: patch };
    const isGap = version > channel.currentVersion + 1;
    channel.currentVersion = version;
    channel.patches.set(version, retained);
    channel.seenEventIds.add(eventId);
    this.#trimHistory(channel);

    for (const client of [...channel.clients]) {
      if (client.closed || client.synchronizing) continue;
      if (client.lastStateVersion !== version - 1) {
        this.#requireSnapshot(client, isGap ? 'retention_miss' : 'version_gap');
        continue;
      }
      this.#sendPatch(client, retained);
    }
    return true;
  }

  /** Force all members to rebuild after authorization or broker state changes. */
  public async requireSnapshot(
    gameId: GameId,
    reason: SnapshotRequiredEvent['reason'] = 'authorization_changed',
  ): Promise<void> {
    const channel = await this.#channel(gameId);
    for (const client of [...channel.clients]) this.#requireSnapshot(client, reason);
  }

  async #channel(gameId: GameId): Promise<GatewayChannel> {
    const existing = this.#channels.get(gameId);
    if (existing !== undefined) return existing;
    const seededVersion =
      this.#seedVersion === undefined ? 0 : await this.#seedVersion(gameId);
    const created: GatewayChannel = {
      gameId,
      currentVersion: safeStateVersion(seededVersion, 'Seeded state version'),
      patches: new Map(),
      seenEventIds: new Set(),
      clients: new Set(),
    };
    this.#channels.set(gameId, created);
    return created;
  }

  #synchronizeOnConnect(client: GatewayClient): void {
    if (client.lastStateVersion === null) {
      this.#requireSnapshot(client, 'reconnect');
      return;
    }
    if (client.lastStateVersion > client.channel.currentVersion) {
      this.#requireSnapshot(client, 'retention_miss');
      return;
    }
    if (client.lastStateVersion === client.channel.currentVersion) return;
    this.#replayFrom(client, client.lastStateVersion);
  }

  #replayFrom(client: GatewayClient, version: number): void {
    for (let next = version + 1; next <= client.channel.currentVersion; next += 1) {
      const retained = client.channel.patches.get(next);
      if (retained === undefined) {
        this.#requireSnapshot(client, 'retention_miss');
        return;
      }
      this.#sendPatch(client, retained);
      if (client.closed) return;
    }
    client.synchronizing = false;
  }

  #sendPatch(client: GatewayClient, retained: RetainedPatch): void {
    if (client.sentEventIds.has(String(retained.eventId))) return;
    if (!this.#send(client, retained.encoded, retained.event.gameId, String(retained.eventId)))
      return;
    client.sentEventIds.add(String(retained.eventId));
    client.lastStateVersion = retained.version;
  }

  #requireSnapshot(client: GatewayClient, reason: SnapshotRequiredEvent['reason']): void {
    if (client.closed || client.synchronizing) return;
    client.synchronizing = true;
    const event: SnapshotRequiredEvent = {
      type: 'snapshot_required',
      gameId: client.channel.gameId,
      expectedStateVersion: stateVersionValue(client.channel.currentVersion),
      reason,
    };
    const encoded = encodeBoundedRealtimeEvent(event, this.#maxEventBytes);
    this.#send(client, encoded, client.channel.gameId, `snapshot:${client.channel.currentVersion}`);
  }

  #markSynchronized(client: GatewayClient, stateVersion: StateVersion): void {
    if (client.closed) return;
    const version = safeStateVersion(stateVersion, 'Synchronized state version');
    if (version > client.channel.currentVersion) {
      // The client fetched an authoritative HTTP snapshot newer than the
      // channel's in-memory version (for example after an API restart that
      // wiped channel state). Raise the channel instead of requiring another
      // snapshot, otherwise a client acknowledging its own version loops
      // forever between snapshot_required and synchronized.
      client.channel.currentVersion = version;
    }
    client.lastStateVersion = version;
    client.synchronizing = false;
    if (version < client.channel.currentVersion) this.#replayFrom(client, version);
  }

  #handleMessage(client: GatewayClient, data: string | Uint8Array | ArrayBuffer): void {
    if (client.closed) return;
    try {
      const message = decodeIncomingMessage(data, this.#maxEventBytes);
      if (message.type === 'pong') {
        client.monitor.receivePong(this.#now());
        return;
      }
      if (message.type === 'synchronized') {
        if (typeof message.stateVersion !== 'number')
          throw new RealtimeProtocolError('Synchronized state version must be a number');
        this.#markSynchronized(
          client,
          stateVersionValue(safeStateVersion(message.stateVersion, 'Synchronized state version')),
        );
        return;
      }
      throw new RealtimeProtocolError(
        'Client messages may only acknowledge heartbeats or snapshots',
      );
    } catch {
      this.#closeClient(client, 1008, 'Invalid realtime message');
    }
  }

  #heartbeatTick(client: GatewayClient): void {
    if (client.closed) return;
    if (client.monitor.check(this.#now()) === 'stale') {
      this.#closeClient(client, 4000, 'Heartbeat timeout');
      return;
    }
    const ping = encodeControlMessage({ type: 'ping' }, this.#maxEventBytes);
    this.#send(client, ping, client.channel.gameId, `ping:${this.#now()}`);
  }

  #send(client: GatewayClient, encoded: string, gameId: GameId, eventId: string): boolean {
    const startedAt = this.#now();
    try {
      client.socket.send(encoded);
      recordEventDelivery(this.#observability, {
        gameId: String(gameId),
        eventId,
        durationMs: Math.max(0, this.#now() - startedAt),
        outcome: 'delivered',
      });
      return true;
    } catch {
      recordEventDelivery(this.#observability, {
        gameId: String(gameId),
        eventId,
        durationMs: Math.max(0, this.#now() - startedAt),
        outcome: 'failed',
      });
      this.#closeClient(client, 1011, 'Realtime delivery failed');
      return false;
    }
  }

  #closeClient(client: GatewayClient, code?: number, reason?: string): void {
    if (client.closed) return;
    this.#removeClient(client);
    try {
      client.socket.close(code, reason);
    } catch {
      // A transport may already be closed; cleanup above is authoritative.
    }
  }

  #removeClient(client: GatewayClient): void {
    if (client.closed) return;
    client.closed = true;
    clearInterval(client.heartbeatTimer);
    client.channel.clients.delete(client);
  }

  #trimHistory(channel: GatewayChannel): void {
    while (channel.patches.size > this.#retainedEvents) {
      const oldest = channel.patches.keys().next().value;
      if (oldest === undefined) return;
      const removed = channel.patches.get(oldest);
      channel.patches.delete(oldest);
      if (removed !== undefined) channel.seenEventIds.delete(String(removed.eventId));
    }
  }
}
