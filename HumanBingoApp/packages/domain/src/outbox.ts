import type {
  GameId,
  NotificationDto,
  ParticipantId,
  PatchChanges,
  SnapshotRequiredEvent,
  StateVersion,
} from './contracts.js';
import type { VerificationPushPayload } from './push.js';

/** Event names used by asynchronous workers and the realtime gateway. */
export type OutboxEventType =
  | 'game.patch'
  | 'notification.work'
  | 'push.work'
  | 'snapshot.required'
  | `game.${string}`
  | `verification.${string}`;

export interface GamePatchWorkPayload {
  readonly kind: 'game.patch';
  readonly changes: PatchChanges;
}

export interface NotificationWorkPayload {
  readonly kind: 'notification.work';
  readonly notification: NotificationDto;
}

export interface PushWorkPayload {
  readonly kind: 'push.work';
  readonly recipientParticipantId: ParticipantId;
  readonly payload: VerificationPushPayload;
}

export interface SnapshotFallbackWorkPayload {
  readonly kind: 'snapshot.required';
  readonly expectedStateVersion: StateVersion;
  readonly reason: SnapshotRequiredEvent['reason'];
}

export type OutboxWorkPayload =
  | GamePatchWorkPayload
  | NotificationWorkPayload
  | PushWorkPayload
  | SnapshotFallbackWorkPayload;

/**
 * Payloads are broadcast to asynchronous consumers and may be delivered to
 * more than one game member. These names are never allowed in an outbox
 * payload because they are credentials or provider secrets, not domain data.
 */
const SECRET_KEY =
  /(authorization|cookie|credential|password|push.?secret|session|subscription|token|secret)/i;

export class OutboxPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OutboxPayloadError';
  }
}

/**
 * Validates the JSON object persisted in an outbox row. The game id check
 * prevents an event for one game from carrying records from another game;
 * recursive secret checks prevent accidental credential publication.
 */
export function assertSafeOutboxPayload(
  gameId: GameId | string,
  payload: Record<string, unknown>,
): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new OutboxPayloadError('Outbox payload must be a JSON object');
  }
  walkPayload(payload, undefined, String(gameId));
}

function walkPayload(value: unknown, key: string | undefined, gameId: string): void {
  if (key !== undefined && SECRET_KEY.test(key)) {
    throw new OutboxPayloadError(`Outbox payload contains a secret field: ${key}`);
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw new OutboxPayloadError('Outbox payload contains a non-JSON value');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new OutboxPayloadError('Outbox payload contains a non-finite number');
  }
  if (Array.isArray(value)) {
    for (const item of value) walkPayload(item, undefined, gameId);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if ((childKey === 'gameId' || childKey === 'game_id') && childValue !== gameId) {
      throw new OutboxPayloadError('Outbox payload contains a record from another game');
    }
    walkPayload(childValue, childKey, gameId);
  }
}
