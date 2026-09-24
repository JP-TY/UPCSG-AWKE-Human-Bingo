import { describe, expect, it } from 'vitest';

import {
  GameStatus,
  NotificationStatus,
  SquareStatus,
  VerificationRequestStatus,
  type CorrelationId,
  type GameId,
  type GridId,
  type IdempotencyKey,
  type ParticipantId,
  type PlayerCode,
  type PushSubscriptionId,
  type StateVersion,
  type VerificationPushPayload,
} from '@human-bingo/domain';
import {
  emptyVerificationState,
  InMemoryVerificationRepository,
  type GameRecord,
  type GridRecord,
  type MembershipRecord,
  type ParticipantRecord,
  type PlayerProfileRecord,
  type SquareRecord,
  type TaskEntryRecord,
} from '@human-bingo/persistence';
import {
  hashEndpoint,
  InMemoryPushSubscriptionStore,
  PushNotificationService,
  VerificationService,
  type PushProvider,
} from '@human-bingo/api';
import { handleNotificationClick, type NotificationClickEventLike } from '@human-bingo/worker';
import { registerBrowserPush, type BrowserPushSubscription } from '@human-bingo/browser-client';

const GAME_ID = 'integration-notification-game' as GameId;
const GRID_ID = 'integration-notification-grid' as GridId;
const REQUESTER_ID = 'integration-requester' as ParticipantId;
const IDENTIFIED_ID = 'integration-identified' as ParticipantId;
const IDENTIFIED_CODE = 'IDENTIFIED' as PlayerCode;
const CREATED_AT = new Date('2025-01-01T00:00:00.000Z');
const CORRELATION_ID = 'integration-notification' as CorrelationId;
const VAPID_PUBLIC_KEY = 'AQIDBAUGBwgJCgsMDQ4PEA';

function createVerificationState(): ReturnType<typeof emptyVerificationState> {
  const game: GameRecord = {
    id: GAME_ID,
    hostAccountId: 'integration-host',
    name: 'Integration Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: CREATED_AT,
    closedAt: null,
    stateVersion: 0n,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  const participants: ParticipantRecord[] = [
    { id: REQUESTER_ID, gameId: GAME_ID, createdAt: CREATED_AT, leftAt: null },
    { id: IDENTIFIED_ID, gameId: GAME_ID, createdAt: CREATED_AT, leftAt: null },
  ];
  const memberships: MembershipRecord[] = participants.map((participant, index) => ({
    id: `integration-membership-${index}` as MembershipRecord['id'],
    gameId: GAME_ID,
    participantId: participant.id,
    browserSessionId: null,
    resumableCredentialHash: new Uint8Array([index + 1]),
    createdAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
  }));
  const profiles: PlayerProfileRecord[] = [
    {
      id: 'integration-requester-profile' as PlayerProfileRecord['id'],
      gameId: GAME_ID,
      participantId: REQUESTER_ID,
      displayName: 'Requester',
      playerCode: 'REQUESTER' as PlayerCode,
      createdAt: CREATED_AT,
    },
    {
      id: 'integration-identified-profile' as PlayerProfileRecord['id'],
      gameId: GAME_ID,
      participantId: IDENTIFIED_ID,
      displayName: 'Identified Participant',
      playerCode: IDENTIFIED_CODE,
      createdAt: CREATED_AT,
    },
  ];
  const tasks: TaskEntryRecord[] = Array.from({ length: 25 }, (_, squareIndex) => ({
    id: `integration-task-${squareIndex}` as TaskEntryRecord['id'],
    gameId: GAME_ID,
    displayText: `Task ${squareIndex}`,
    normalizedText: `task ${squareIndex}`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    removedAt: null,
  }));
  const grid: GridRecord = {
    id: GRID_ID,
    gameId: GAME_ID,
    participantId: REQUESTER_ID,
    taskBagVersion: 1n,
    stateVersion: 0n,
    createdAt: CREATED_AT,
  };
  const squares: SquareRecord[] = tasks.map((task, squareIndex) => ({
    gridId: GRID_ID,
    gameId: GAME_ID,
    squareIndex,
    taskEntryId: task.id,
    status: SquareStatus.Unverified,
    updatedAt: CREATED_AT,
  }));

  return emptyVerificationState({
    game,
    tasks,
    memberships,
    participants,
    profiles,
    grids: [grid],
    squares,
  });
}

function browserEnvironment(permission: NotificationPermission) {
  let subscribeCalls = 0;
  const subscription: BrowserPushSubscription = {
    endpoint: 'https://push.example/integration-subscription',
    toJSON: () => ({
      keys: {
        p256dh: 'abcdefghijklmnopqrstuvwxyz01',
        auth: 'abcdefghijklmnopqrstuvwxyz02',
      },
    }),
  };
  return {
    get subscribeCalls() {
      return subscribeCalls;
    },
    environment: {
      notifications: {
        permission,
        requestPermission: () => Promise.resolve('granted' as NotificationPermission),
      },
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            subscribe: () => {
              subscribeCalls += 1;
              return Promise.resolve(subscription);
            },
          },
        }),
      },
    },
  };
}

async function addSubscription(
  store: InMemoryPushSubscriptionStore,
  endpoint: string,
): Promise<void> {
  await store.register({
    gameId: GAME_ID,
    participantId: IDENTIFIED_ID,
    endpointHash: hashEndpoint(endpoint),
    providerData: {
      endpoint,
      p256dh: 'abcdefghijklmnopqrstuvwxyz01',
      auth: 'abcdefghijklmnopqrstuvwxyz02',
    },
  });
}

describe('task 10.2 notification and push integration', () => {
  it('keeps durable in-app state authoritative across permission and provider outcomes', async () => {
    const granted = browserEnvironment('granted');
    const grantedResult = await registerBrowserPush({
      vapidPublicKey: VAPID_PUBLIC_KEY,
      environment: granted.environment,
    });
    expect(grantedResult.status).toBe('granted');
    expect(grantedResult.subscription?.endpoint).toBe(
      'https://push.example/integration-subscription',
    );
    expect(granted.subscribeCalls).toBe(1);

    const denied = browserEnvironment('denied');
    await expect(
      registerBrowserPush({
        vapidPublicKey: VAPID_PUBLIC_KEY,
        environment: denied.environment,
      }),
    ).resolves.toMatchObject({ status: 'denied' });
    expect(denied.subscribeCalls).toBe(0);

    await expect(
      registerBrowserPush({ vapidPublicKey: VAPID_PUBLIC_KEY, environment: {} }),
    ).resolves.toMatchObject({ status: 'unsupported' });

    const store = new InMemoryPushSubscriptionStore({
      idFactory: (() => {
        let nextId = 0;
        return () => `integration-subscription-${++nextId}` as PushSubscriptionId;
      })(),
    });
    await addSubscription(store, 'https://push.example/success');
    await addSubscription(store, 'https://push.example/temporary');
    await addSubscription(store, 'https://push.example/stale');

    const deliveredPayloads: VerificationPushPayload[] = [];
    const provider: PushProvider = {
      send: (subscription, payload) => {
        const endpoint = String(subscription.providerData.endpoint);
        if (endpoint.endsWith('/stale')) {
          return Promise.reject(Object.assign(new Error('subscription gone'), { statusCode: 410 }));
        }
        if (endpoint.endsWith('/temporary')) {
          return Promise.reject(new Error('provider unavailable'));
        }
        deliveredPayloads.push(payload);
        return Promise.resolve();
      },
    };
    const push = new PushNotificationService(
      store,
      { isGameMember: () => Promise.resolve(true) },
      provider,
      { now: () => new Date('2025-01-01T00:00:01.000Z'), appOrigin: 'https://app.example' },
    );
    const reports: Array<{ attempted: number; delivered: number; failed: number; stale: number }> =
      [];
    const repository = new InMemoryVerificationRepository({ states: [createVerificationState()] });
    const verification = new VerificationService(repository, {
      now: () => new Date('2025-01-01T00:00:02.000Z'),
      idFactory: (() => {
        let nextId = 0;
        return () => `integration-generated-${++nextId}`;
      })(),
      pushNotifier: {
        deliverVerificationRequest: async (input) => {
          const report = await push.deliverVerificationRequest(input);
          reports.push(report);
        },
      },
    });

    const request = await verification.request(
      {
        gameId: GAME_ID,
        gridId: GRID_ID,
        squareIndex: 7,
        identifiedPlayerCode: IDENTIFIED_CODE,
        correlationId: CORRELATION_ID,
        knownStateVersion: 0 as StateVersion,
        idempotencyKey: 'integration-request' as IdempotencyKey,
      },
      REQUESTER_ID,
    );

    expect(reports).toEqual([{ attempted: 3, delivered: 1, failed: 2, stale: 1 }]);
    expect(deliveredPayloads).toHaveLength(1);
    expect(deliveredPayloads[0]).toMatchObject({
      gameName: 'Integration Bingo',
      requestingParticipant: 'Requester',
      taskText: 'Task 7',
      deepLink:
        'https://app.example/game/integration-notification-game/notifications?request=integration-generated-1',
    });

    const pending = await verification.listNotifications(
      { gameId: GAME_ID, correlationId: CORRELATION_ID },
      IDENTIFIED_ID,
    );
    expect(pending.pendingCount).toBe(1);
    expect(pending.notifications).toHaveLength(1);
    expect(pending.notifications[0]).toMatchObject({
      verificationRequestId: request.request.id,
      status: NotificationStatus.Pending,
    });

    const activeAfterDelivery = await store.listActive(GAME_ID, IDENTIFIED_ID);
    expect(activeAfterDelivery).toHaveLength(2);
    expect(
      activeAfterDelivery.some(
        (subscription) => subscription.providerData.endpoint === 'https://push.example/stale',
      ),
    ).toBe(false);
    expect(
      activeAfterDelivery.filter((subscription) => subscription.lastSuccessAt !== null),
    ).toHaveLength(1);
    expect(
      activeAfterDelivery.some(
        (subscription) =>
          subscription.providerData.endpoint === 'https://push.example/temporary' &&
          subscription.revokedAt === null,
      ),
    ).toBe(true);

    const resolved = await verification.respond(
      {
        gameId: GAME_ID,
        verificationRequestId: request.request.id,
        decision: 'confirm',
        correlationId: CORRELATION_ID,
        knownStateVersion: 1 as StateVersion,
        idempotencyKey: 'integration-response' as IdempotencyKey,
      },
      IDENTIFIED_ID,
    );
    expect(resolved.request.status).toBe(VerificationRequestStatus.Confirmed);

    await expect(
      verification.listNotifications(
        { gameId: GAME_ID, correlationId: CORRELATION_ID },
        IDENTIFIED_ID,
      ),
    ).resolves.toEqual({ notifications: [], pendingCount: 0 });
    await expect(
      verification.listNotifications(
        { gameId: GAME_ID, correlationId: CORRELATION_ID, includeResolved: true },
        IDENTIFIED_ID,
      ),
    ).resolves.toMatchObject({
      pendingCount: 0,
      notifications: [
        { verificationRequestId: request.request.id, status: NotificationStatus.Resolved },
      ],
    });

    const stateAfterResolution = await repository.read(GAME_ID);
    expect(stateAfterResolution.notifications).toHaveLength(1);
    expect(stateAfterResolution.notifications[0]?.status).toBe(NotificationStatus.Resolved);
    expect(stateAfterResolution.verificationRequests[0]?.status).toBe(
      VerificationRequestStatus.Confirmed,
    );
  });

  it('clicks a safe push notification through to the existing app route or a new window', async () => {
    const deepLink =
      'https://app.example/game/integration-notification-game/notifications?request=request-1';
    let closed = 0;
    let opened = '';
    let pending: Promise<void> | undefined;
    const event: NotificationClickEventLike = {
      notification: {
        data: {
          gameName: 'Integration Bingo',
          requestingParticipant: 'Requester',
          taskText: 'Task 7',
          deepLink,
        },
        close: () => {
          closed += 1;
        },
      },
      waitUntil: (promise) => {
        pending = promise;
      },
    };

    handleNotificationClick(
      event,
      {
        matchClients: () => Promise.resolve([]),
        openWindow: (url) => {
          opened = url;
          return Promise.resolve(null);
        },
      },
      'https://app.example',
    );
    await pending;

    expect(closed).toBe(1);
    expect(opened).toBe(deepLink);
  });
});
