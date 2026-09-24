import {
  assertSafeOutboxPayload,
  type GameId,
  type NotificationWorkPayload,
  type OutboxWorkPayload,
  type ParticipantId,
  type PushWorkPayload,
  type SnapshotFallbackWorkPayload,
  type StateVersion,
} from '@human-bingo/domain';

export interface PublishableEvent {
  readonly id: string;
  readonly gameId?: string;
  readonly stateVersion?: number | bigint;
  readonly eventType?: string;
  readonly payload?: unknown;
  readonly nextAttemptAt?: Date | null;
}

export interface OutboxStore<Event extends PublishableEvent> {
  /** Implementations must claim rows in game/state-version order. */
  readonly claimPending: (now: Date, limit: number) => Promise<readonly Event[]>;
  readonly markPublished: (eventId: string, publishedAt: Date) => Promise<void>;
  readonly markFailed: (eventId: string, failedAt: Date, error: string) => Promise<void>;
}

export interface EventBroker<Event> {
  readonly publish: (event: Event) => Promise<void>;
}

export interface OutboxPublishReport {
  readonly attempted: number;
  readonly published: number;
  readonly failed: number;
}

class OrderedDeliveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OrderedDeliveryError';
  }
}

function compareEvents(left: PublishableEvent, right: PublishableEvent): number {
  if (left.gameId !== undefined && right.gameId !== undefined && left.gameId !== right.gameId) {
    return left.gameId.localeCompare(right.gameId);
  }
  if (left.gameId !== right.gameId) return left.gameId === undefined ? 1 : -1;
  const leftVersion =
    typeof left.stateVersion === 'bigint' ? Number(left.stateVersion) : left.stateVersion;
  const rightVersion =
    typeof right.stateVersion === 'bigint' ? Number(right.stateVersion) : right.stateVersion;
  if (leftVersion !== undefined && rightVersion !== undefined && leftVersion !== rightVersion) {
    return leftVersion - rightVersion;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Publishes committed outbox rows best-effort. Rows for the same game are
 * published in state-version order; a failed version blocks later versions
 * for that game until the next poll. Other games can continue independently.
 */
export class OutboxPublisher<Event extends PublishableEvent> {
  public constructor(
    private readonly store: OutboxStore<Event>,
    private readonly broker: EventBroker<Event>,
    private readonly maxErrorLength = 256,
  ) {}

  public async publishPending(now = new Date(), limit = 100): Promise<OutboxPublishReport> {
    if (!Number.isInteger(limit) || limit <= 0)
      throw new RangeError('Outbox batch size must be positive');
    const events = [...(await this.store.claimPending(now, limit))].sort(compareEvents);
    const blockedGames = new Set<string>();
    const lastVersionByGame = new Map<string, number>();
    let published = 0;
    let failed = 0;

    for (const event of events) {
      const gameKey = event.gameId;
      if (gameKey !== undefined && blockedGames.has(gameKey)) continue;
      if (event.gameId !== undefined && event.payload !== undefined) {
        if (
          typeof event.payload !== 'object' ||
          event.payload === null ||
          Array.isArray(event.payload)
        ) {
          throw new Error('Outbox payload must be a JSON object');
        }
        assertSafeOutboxPayload(event.gameId as GameId, event.payload as Record<string, unknown>);
      }
      if (gameKey !== undefined && event.stateVersion !== undefined) {
        const version = safeVersion(event.stateVersion);
        const previous = lastVersionByGame.get(gameKey);
        if (previous !== undefined && version <= previous) {
          failed += 1;
          blockedGames.add(gameKey);
          await this.store.markFailed(
            event.id,
            now,
            'Outbox state versions are not strictly increasing',
          );
          continue;
        }
      }

      try {
        await this.broker.publish(event);
        await this.store.markPublished(event.id, now);
        published += 1;
        if (gameKey !== undefined && event.stateVersion !== undefined) {
          lastVersionByGame.set(gameKey, safeVersion(event.stateVersion));
        }
      } catch (error: unknown) {
        failed += 1;
        if (gameKey !== undefined) blockedGames.add(gameKey);
        const message = error instanceof Error ? error.message : 'Broker publish failed';
        await this.store.markFailed(event.id, now, message.slice(0, this.maxErrorLength));
      }
    }
    return { attempted: events.length, published, failed };
  }
}

function safeVersion(value: number | bigint): number {
  const version = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new OrderedDeliveryError('Outbox state version must be a positive safe integer');
  }
  return version;
}

export interface EventConsumerStore {
  readonly hasProcessed: (eventId: string) => Promise<boolean>;
  readonly markProcessed: (eventId: string) => Promise<void>;
  /** Optional atomic cross-worker claim. False means another consumer owns it. */
  readonly tryClaim?: (eventId: string) => Promise<boolean>;
  /** Releases a claim when handling failed so the broker can retry it. */
  readonly releaseClaim?: (eventId: string) => Promise<void>;
}

/** Consumer-side idempotency prevents duplicate broker deliveries from replaying work. */
export class IdempotentEventConsumer<Event extends { readonly id: string }> {
  private readonly inFlight = new Map<string, Promise<boolean>>();

  public constructor(
    private readonly store: EventConsumerStore,
    private readonly handle: (event: Event) => Promise<void>,
  ) {}

  public consume(event: Event): Promise<boolean> {
    const existing = this.inFlight.get(event.id);
    if (existing !== undefined) return existing;
    const operation = this.consumeOnce(event).finally(() => {
      if (this.inFlight.get(event.id) === operation) this.inFlight.delete(event.id);
    });
    this.inFlight.set(event.id, operation);
    return operation;
  }

  private async consumeOnce(event: Event): Promise<boolean> {
    if (await this.store.hasProcessed(event.id)) return false;
    const claimed = this.store.tryClaim === undefined || (await this.store.tryClaim(event.id));
    if (!claimed) return false;
    try {
      await this.handle(event);
      await this.store.markProcessed(event.id);
      return true;
    } catch (error: unknown) {
      if (this.store.releaseClaim !== undefined) await this.store.releaseClaim(event.id);
      throw error;
    }
  }
}

export interface OutboxWorkEvent extends PublishableEvent {
  readonly id: string;
  readonly gameId: GameId;
  readonly stateVersion: StateVersion;
  readonly eventType: string;
  readonly payload: OutboxWorkPayload | { readonly changes: Record<string, unknown> };
}

export interface OutboxWorkHandlers {
  readonly gamePatch: (
    event: OutboxWorkEvent & { readonly payload: { readonly changes: Record<string, unknown> } },
  ) => Promise<void>;
  readonly notification?: (
    event: OutboxWorkEvent & { readonly payload: NotificationWorkPayload },
  ) => Promise<void>;
  readonly push?: (event: OutboxWorkEvent & { readonly payload: PushWorkPayload }) => Promise<void>;
  readonly snapshotRequired?: (
    event: OutboxWorkEvent & { readonly payload: SnapshotFallbackWorkPayload },
  ) => Promise<void>;
}

/**
 * Routes the four supported worker jobs through the idempotent consumer. A
 * snapshot-required event is a control signal: its handler should rebuild from
 * authoritative storage rather than trying to replay missing patches.
 */
export class OutboxWorkConsumer extends IdempotentEventConsumer<OutboxWorkEvent> {
  public constructor(store: EventConsumerStore, handlers: OutboxWorkHandlers) {
    super(store, async (event) => dispatchWork(event, handlers));
  }
}

async function dispatchWork(event: OutboxWorkEvent, handlers: OutboxWorkHandlers): Promise<void> {
  assertSafeOutboxPayload(event.gameId, event.payload as Record<string, unknown>);
  const kind = 'kind' in event.payload ? event.payload.kind : 'game.patch';
  switch (kind) {
    case 'game.patch':
      await handlers.gamePatch(
        event as OutboxWorkEvent & {
          readonly payload: { readonly changes: Record<string, unknown> };
        },
      );
      return;
    case 'notification.work':
      if (handlers.notification === undefined)
        throw new Error('No notification work handler is configured');
      await handlers.notification(
        event as OutboxWorkEvent & { readonly payload: NotificationWorkPayload },
      );
      return;
    case 'push.work':
      if (handlers.push === undefined) throw new Error('No push work handler is configured');
      await handlers.push(event as OutboxWorkEvent & { readonly payload: PushWorkPayload });
      return;
    case 'snapshot.required':
      if (handlers.snapshotRequired === undefined)
        throw new Error('No snapshot fallback handler is configured');
      await handlers.snapshotRequired(
        event as OutboxWorkEvent & { readonly payload: SnapshotFallbackWorkPayload },
      );
      return;
    default:
      throw new Error(`Unsupported outbox work kind: ${String(kind)}`);
  }
}

export type { ParticipantId };
