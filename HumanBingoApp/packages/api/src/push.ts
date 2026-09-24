import { createHash, randomUUID } from 'node:crypto';

import {
  createVerificationPushPayload,
  DomainErrorCode,
  HumanBingoError,
  type CorrelationId,
  type GameId,
  type ParticipantId,
  type PushSubscriptionId,
  type RegisterPushSubscriptionCommand,
  type RegisterPushSubscriptionResult,
  type VerificationPushPayload,
  type VerificationRequestId,
} from '@human-bingo/domain';
import type { PushSubscriptionRecord } from '@human-bingo/persistence';
import type { Observability } from './observability.js';
import { recordPushFailure } from './observability.js';

export interface PushSubscriptionStore {
  register(input: {
    readonly gameId: GameId;
    readonly participantId: ParticipantId;
    readonly endpointHash: Uint8Array;
    readonly providerData: Record<string, unknown>;
  }): Promise<PushSubscriptionRecord>;
  listActive(
    gameId: GameId,
    participantId: ParticipantId,
  ): Promise<readonly PushSubscriptionRecord[]>;
  markSuccess(id: PushSubscriptionId, deliveredAt: Date): Promise<void>;
  markFailure(id: PushSubscriptionId, failedAt: Date, stale: boolean): Promise<void>;
}

export interface PushSubscriptionActor {
  readonly gameId?: GameId;
  readonly participantId: ParticipantId;
}

export interface PushSubscriptionAuthorization {
  isGameMember(gameId: GameId, participantId: ParticipantId): Promise<boolean>;
}

export interface PushProvider {
  send(subscription: PushSubscriptionRecord, payload: VerificationPushPayload): Promise<void>;
}

export interface PushDeliveryOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly observability?: Observability;
  readonly appOrigin?: string;
}

export interface VerificationPushDeliveryInput {
  readonly gameId: GameId;
  readonly participantId: ParticipantId;
  readonly verificationRequestId: VerificationRequestId;
  readonly gameName: string;
  readonly requestingParticipant: string;
  readonly taskText: string;
}

export interface PushDeliveryReport {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly stale: number;
}

/**
 * Optional push adapter. It is deliberately separate from verification
 * mutation transactions: delivery failures are recorded on subscriptions and
 * never reject or roll back the durable in-app notification.
 */
export class PushNotificationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly appOrigin: string;
  private readonly observability: Observability | undefined;

  public constructor(
    private readonly subscriptions: PushSubscriptionStore,
    private readonly authorization: PushSubscriptionAuthorization,
    private readonly provider: PushProvider,
    options: PushDeliveryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.appOrigin = options.appOrigin ?? 'https://app.example';
    this.observability = options.observability;
  }

  public async register(
    command: RegisterPushSubscriptionCommand,
    actor: ParticipantId | PushSubscriptionActor,
  ): Promise<RegisterPushSubscriptionResult> {
    const participantId = typeof actor === 'string' ? actor : actor.participantId;
    if (
      typeof actor !== 'string' &&
      actor.gameId !== undefined &&
      actor.gameId !== command.gameId
    ) {
      throw pushError(
        DomainErrorCode.Forbidden,
        'The current participant is not a member of this game.',
        command.correlationId,
        403,
      );
    }
    const member = await this.authorization.isGameMember(command.gameId, participantId);
    if (!member) {
      throw pushError(
        DomainErrorCode.Forbidden,
        'The current participant is not a member of this game.',
        command.correlationId,
        403,
      );
    }

    const endpoint = validateEndpoint(command.subscription.endpoint, command.correlationId);
    const p256dh = validateCredential(command.subscription.p256dh, 'p256dh', command.correlationId);
    const auth = validateCredential(command.subscription.auth, 'auth', command.correlationId);
    const record = await this.subscriptions.register({
      gameId: command.gameId,
      participantId,
      endpointHash: hashEndpoint(endpoint),
      providerData: { endpoint, p256dh, auth },
    });
    return { subscriptionId: record.id };
  }

  public async deliverVerificationRequest(
    input: VerificationPushDeliveryInput,
  ): Promise<PushDeliveryReport> {
    const payload = createVerificationPushPayload({
      appOrigin: this.appOrigin,
      gameId: input.gameId,
      verificationRequestId: input.verificationRequestId,
      gameName: input.gameName,
      requestingParticipant: input.requestingParticipant,
      taskText: input.taskText,
    });
    return this.deliver(input.gameId, input.participantId, payload);
  }

  public async deliver(
    gameId: GameId,
    participantId: ParticipantId,
    payload: VerificationPushPayload,
  ): Promise<PushDeliveryReport> {
    const active = await this.subscriptions.listActive(gameId, participantId);
    let delivered = 0;
    let failed = 0;
    let stale = 0;
    const deliveredAt = this.now();

    for (const subscription of active) {
      try {
        await this.provider.send(subscription, payload);
        await this.subscriptions.markSuccess(subscription.id, deliveredAt);
        delivered += 1;
      } catch (error: unknown) {
        failed += 1;
        const isStale = isStaleProviderError(error);
        if (isStale) stale += 1;
        await this.subscriptions.markFailure(subscription.id, deliveredAt, isStale);
        recordPushFailure(this.observability, {
          gameId,
          participantId,
          reason: isStale ? 'stale_subscription' : providerFailureReason(error),
        });
      }
    }

    return { attempted: active.length, delivered, failed, stale };
  }

  /** Exposed for adapters that need a stable subscription id without leaking credentials. */
  public newSubscriptionId(): PushSubscriptionId {
    return this.idFactory() as PushSubscriptionId;
  }
}

/** Small in-memory adapter used by local runtimes and unit tests. */
export class InMemoryPushSubscriptionStore implements PushSubscriptionStore {
  private readonly records = new Map<PushSubscriptionId, PushSubscriptionRecord>();
  private readonly idFactory: () => string;

  public constructor(options: { readonly idFactory?: () => string } = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public register(input: {
    readonly gameId: GameId;
    readonly participantId: ParticipantId;
    readonly endpointHash: Uint8Array;
    readonly providerData: Record<string, unknown>;
  }): Promise<PushSubscriptionRecord> {
    const existing = [...this.records.values()].find(
      (record) =>
        record.gameId === input.gameId &&
        record.participantId === input.participantId &&
        equalBytes(record.endpointHash, input.endpointHash),
    );
    const now = new Date();
    const record: PushSubscriptionRecord = {
      id: existing?.id ?? (this.idFactory() as PushSubscriptionId),
      gameId: input.gameId,
      participantId: input.participantId,
      endpointHash: new Uint8Array(input.endpointHash),
      providerData: { ...input.providerData },
      createdAt: existing?.createdAt ?? now,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      lastFailureAt: existing?.lastFailureAt ?? null,
      revokedAt: null,
    };
    this.records.set(record.id, record);
    return Promise.resolve(cloneRecord(record));
  }

  public listActive(
    gameId: GameId,
    participantId: ParticipantId,
  ): Promise<readonly PushSubscriptionRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (record) =>
            record.gameId === gameId &&
            record.participantId === participantId &&
            record.revokedAt === null,
        )
        .map(cloneRecord),
    );
  }

  public markSuccess(id: PushSubscriptionId, deliveredAt: Date): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined || record.revokedAt !== null) return Promise.resolve();
    this.records.set(id, { ...record, lastSuccessAt: new Date(deliveredAt), lastFailureAt: null });
    return Promise.resolve();
  }

  public markFailure(id: PushSubscriptionId, failedAt: Date, stale: boolean): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return Promise.resolve();
    this.records.set(id, {
      ...record,
      lastFailureAt: new Date(failedAt),
      revokedAt: stale ? (record.revokedAt ?? new Date(failedAt)) : record.revokedAt,
    });
    return Promise.resolve();
  }

  public read(id: PushSubscriptionId): PushSubscriptionRecord | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : cloneRecord(record);
  }
}

export function hashEndpoint(endpoint: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(endpoint, 'utf8').digest());
}

function validateEndpoint(endpoint: string, correlationId: CorrelationId): string {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('endpoint must use HTTPS');
    if (url.username !== '' || url.password !== '' || url.hash !== '')
      throw new Error('endpoint contains unsafe data');
    return url.toString();
  } catch {
    throw pushError(
      DomainErrorCode.ValidationError,
      'The push endpoint is invalid.',
      correlationId,
      422,
    );
  }
}

function validateCredential(value: string, name: string, correlationId: CorrelationId): string {
  if (!/^[A-Za-z0-9_-]{8,}$/.test(value)) {
    throw pushError(
      DomainErrorCode.ValidationError,
      `The push ${name} key is invalid.`,
      correlationId,
      422,
    );
  }
  return value;
}

function pushError(
  code: DomainErrorCode,
  message: string,
  correlationId: CorrelationId,
  httpStatus: 403 | 422,
): HumanBingoError {
  return new HumanBingoError({ code, message, correlationId, retryable: false, httpStatus });
}

function isStaleProviderError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly statusCode?: unknown;
    readonly status?: unknown;
    readonly stale?: unknown;
  };
  return (
    candidate.stale === true ||
    candidate.statusCode === 404 ||
    candidate.statusCode === 410 ||
    candidate.status === 404 ||
    candidate.status === 410
  );
}

function providerFailureReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { readonly statusCode?: unknown; readonly status?: unknown };
    if (typeof candidate.statusCode === 'number') return `provider_status_${candidate.statusCode}`;
    if (typeof candidate.status === 'number') return `provider_status_${candidate.status}`;
  }
  return 'provider_unavailable';
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function cloneRecord(record: PushSubscriptionRecord): PushSubscriptionRecord {
  return {
    ...record,
    endpointHash: new Uint8Array(record.endpointHash),
    providerData: { ...record.providerData },
    createdAt: new Date(record.createdAt),
    lastSuccessAt: record.lastSuccessAt === null ? null : new Date(record.lastSuccessAt),
    lastFailureAt: record.lastFailureAt === null ? null : new Date(record.lastFailureAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
  };
}
