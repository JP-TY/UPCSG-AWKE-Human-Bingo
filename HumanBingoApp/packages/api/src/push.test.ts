import { describe, expect, it } from 'vitest';

import {
  type CorrelationId,
  type GameId,
  type IdempotencyKey,
  type ParticipantId,
  type PushSubscriptionId,
  type RegisterPushSubscriptionCommand,
  type VerificationRequestId,
} from '@human-bingo/domain';
import type { PushSubscriptionRecord } from '@human-bingo/persistence';

import { InMemoryPushSubscriptionStore, PushNotificationService, hashEndpoint } from './push.js';
import { createObservability, type InMemoryMetrics } from './observability.js';

const gameId = 'game-1' as GameId;
const participantId = 'participant-1' as ParticipantId;
const correlationId = 'correlation-1' as CorrelationId;

const command: RegisterPushSubscriptionCommand = {
  gameId,
  correlationId,
  idempotencyKey: 'push-1' as IdempotencyKey,
  subscription: {
    endpoint: 'https://push.example/subscription/1',
    p256dh: 'abcdefghijklmnopqrstuvwxyz01',
    auth: 'abcdefghijklmnopqrstuvwxyz02',
  },
};

const memberAuthorization = { isGameMember: () => Promise.resolve(true) };

function createRecord(id: string): PushSubscriptionRecord {
  const now = new Date('2025-01-01T00:00:00.000Z');
  return {
    id: id as PushSubscriptionId,
    gameId,
    participantId,
    endpointHash: hashEndpoint(`https://push.example/${id}`),
    providerData: { endpoint: `https://push.example/${id}`, p256dh: 'key', auth: 'auth' },
    createdAt: now,
    lastSuccessAt: null,
    lastFailureAt: null,
    revokedAt: null,
  };
}

describe('PushNotificationService', () => {
  it('authorizes and upserts browser subscriptions without exposing credentials in the result', async () => {
    const store = new InMemoryPushSubscriptionStore({ idFactory: () => 'subscription-1' });
    const service = new PushNotificationService(store, memberAuthorization, {
      send: () => Promise.resolve(),
    });

    const result = await service.register(command, participantId);
    expect(result).toEqual({ subscriptionId: 'subscription-1' });
    await expect(service.register(command, participantId)).resolves.toEqual(result);
    await expect(store.listActive(gameId, participantId)).resolves.toHaveLength(1);
  });

  it('records provider failures, revokes stale endpoints, and keeps other subscriptions active', async () => {
    const records = [createRecord('stale'), createRecord('temporary')];
    const failures: Array<{ id: string; stale: boolean }> = [];
    const store = {
      register: () => Promise.resolve(records[0]!),
      listActive: () => Promise.resolve(records),
      markSuccess: (id: PushSubscriptionId) => {
        void id;
        return Promise.resolve(undefined);
      },
      markFailure: (id: PushSubscriptionId, _at: Date, stale: boolean) => {
        failures.push({ id, stale });
        return Promise.resolve();
      },
    };
    const observability = createObservability();
    const provider = {
      send: (subscription: PushSubscriptionRecord) =>
        subscription.id === 'stale'
          ? Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 }))
          : Promise.reject(new Error('provider unavailable')),
    };
    const service = new PushNotificationService(store, memberAuthorization, provider, {
      observability,
      now: () => new Date('2025-01-01T00:00:01.000Z'),
    });

    const report = await service.deliverVerificationRequest({
      gameId,
      participantId,
      verificationRequestId: 'request-1' as VerificationRequestId,
      gameName: 'Team Bingo',
      requestingParticipant: 'Alex',
      taskText: 'has a bicycle',
    });

    expect(report).toEqual({ attempted: 2, delivered: 0, failed: 2, stale: 1 });
    expect(failures).toEqual([
      { id: 'stale', stale: true },
      { id: 'temporary', stale: false },
    ]);
    expect(
      (observability.metrics as InMemoryMetrics).snapshot().counters[
        'human_bingo_push_failure_total{reason=stale_subscription}'
      ],
    ).toBe(1);
  });

  it('does not permit non-members to register', async () => {
    const service = new PushNotificationService(
      new InMemoryPushSubscriptionStore(),
      { isGameMember: () => Promise.resolve(false) },
      { send: () => Promise.resolve() },
    );

    await expect(service.register(command, participantId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
  });

  it('uses HTTPS endpoints and rejects malformed browser credentials', async () => {
    const service = new PushNotificationService(
      new InMemoryPushSubscriptionStore(),
      memberAuthorization,
      { send: () => Promise.resolve() },
    );
    await expect(
      service.register(
        { ...command, subscription: { ...command.subscription, endpoint: 'http://push.example' } },
        participantId,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.register(
        { ...command, subscription: { ...command.subscription, auth: 'short' } },
        participantId,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
