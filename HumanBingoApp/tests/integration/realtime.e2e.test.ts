import { describe, expect, it, vi } from 'vitest';
import { RealtimeGateway, type RealtimeSocket } from '../../packages/api/src/realtime.js';
import { type AuthorizationPrincipal } from '../../packages/api/src/access/authorization.js';
import { GameSyncController } from '../../packages/browser-client/src/transport.js';
import {
  CompletionCategory,
  GameStatus,
  NotificationStatus,
  SquareStatus,
  VerificationRequestStatus,
  type GameId,
  type GamePatchDto,
  type GameSnapshotDto,
  type GridSquareDto,
  type OutboxEventId,
  type ParticipantId,
  type RealtimeEvent,
  type StateVersion,
} from '@human-bingo/domain';
import { type OutboxEventRecord as PersistenceOutboxEventRecord } from '@human-bingo/persistence';

const GAME_ID = 'realtime-e2e-game' as GameId;
const CREATED_AT = '2025-01-01T00:00:00.000Z' as GameSnapshotDto['game']['createdAt'];
const UPDATED_AT = '2025-01-01T00:00:01.000Z' as GameSnapshotDto['game']['updatedAt'];
const PARTICIPANT_A = 'participant-a' as ParticipantId;
const PARTICIPANT_B = 'participant-b' as ParticipantId;
const GRID_A = 'grid-a' as GameSnapshotDto['grid']['id'];
const GRID_B = 'grid-b' as GameSnapshotDto['grid']['id'];

class BrowserSocket implements RealtimeSocket {
  public readonly messages: string[] = [];
  public readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
  #closeListener: (() => void) | undefined;

  public send(data: string): void {
    this.messages.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  public onMessage(listener: (data: string | Uint8Array | ArrayBuffer) => void): void {
    void listener;
  }

  public onClose(listener: () => void): void {
    this.#closeListener = listener;
  }

  public disconnect(): void {
    this.#closeListener?.();
  }
}

type Phase =
  | 'initial'
  | 'request-1'
  | 'confirmed-1'
  | 'request-2'
  | 'rejected-2'
  | 'pending-close'
  | 'closed';

interface BrowserClient {
  readonly participantId: ParticipantId;
  readonly socket: BrowserSocket;
  readonly controller: GameSyncController;
  readonly flush: () => Promise<void>;
}

const participant = (id: ParticipantId, displayName: string, playerCode: string) => ({
  participantId: id,
  displayName,
  playerCode: playerCode as GameSnapshotDto['profile']['playerCode'],
});

const gridFor = (
  participantId: ParticipantId,
  gridId: GameSnapshotDto['grid']['id'],
  phase: Phase,
): GameSnapshotDto['grid'] => {
  const statusFor = (squareIndex: number): SquareStatus => {
    if (
      phase === 'confirmed-1' ||
      phase === 'request-2' ||
      phase === 'rejected-2' ||
      phase === 'pending-close' ||
      phase === 'closed'
    ) {
      if (squareIndex === 0) return SquareStatus.Verified;
    }
    if (phase === 'request-1' || phase === 'request-2' || phase === 'pending-close') {
      if (squareIndex === 1 || (phase === 'request-1' && squareIndex === 0))
        return SquareStatus.Pending;
    }
    if ((phase === 'rejected-2' || phase === 'closed') && squareIndex === 1)
      return SquareStatus.Rejected;
    if (phase === 'pending-close' || phase === 'closed') {
      if (squareIndex === 2) return SquareStatus.Pending;
    }
    return SquareStatus.Unverified;
  };

  const squares: GridSquareDto[] = Array.from({ length: 25 }, (_, squareIndex) => ({
    gridId,
    squareIndex,
    row: (Math.floor(squareIndex / 5) + 1) as 1 | 2 | 3 | 4 | 5,
    column: ((squareIndex % 5) + 1) as 1 | 2 | 3 | 4 | 5,
    taskEntryId: `task-${squareIndex}` as GameSnapshotDto['tasks'][number]['id'],
    taskText: `Task ${squareIndex}`,
    status: statusFor(squareIndex),
    updatedAt: UPDATED_AT,
  }));
  return {
    id: gridId,
    gameId: GAME_ID,
    participantId,
    squares,
    taskBagVersion: 1 as StateVersion,
    stateVersion: 1 as StateVersion,
    createdAt: CREATED_AT,
  };
};

const requestFor = (requestNumber: 1 | 2 | 3, status: VerificationRequestStatus) => {
  const requester = participant(PARTICIPANT_A, 'Player A', 'PLAYRA');
  const identified = participant(PARTICIPANT_B, 'Player B', 'PLAYRB');
  return {
    id: `request-${requestNumber}` as GameSnapshotDto['verificationRequests'][number]['id'],
    gameId: GAME_ID,
    gridId: GRID_A,
    squareIndex: requestNumber - 1,
    taskText: `Task ${requestNumber - 1}`,
    requestingParticipant: requester,
    identifiedParticipant: identified,
    status,
    createdAt: CREATED_AT,
    ...(status === VerificationRequestStatus.Pending
      ? {}
      : {
          resolvedAt: UPDATED_AT,
          outcomeActorId: PARTICIPANT_B,
          decision:
            status === VerificationRequestStatus.Confirmed
              ? ('confirm' as const)
              : ('reject' as const),
        }),
  };
};

const notificationFor = (requestNumber: 1 | 2 | 3, status: NotificationStatus) => ({
  id: `notification-${requestNumber}` as GameSnapshotDto['notifications'][number]['id'],
  gameId: GAME_ID,
  recipientParticipantId: PARTICIPANT_B,
  verificationRequestId:
    `request-${requestNumber}` as GameSnapshotDto['verificationRequests'][number]['id'],
  kind: 'verification_request' as const,
  status,
  gameName: 'Realtime Bingo',
  requestingParticipant: participant(PARTICIPANT_A, 'Player A', 'PLAYRA'),
  taskText: `Task ${requestNumber - 1}`,
  createdAt: CREATED_AT,
  ...(status === NotificationStatus.Resolved ? { resolvedAt: UPDATED_AT } : {}),
});

const leaderboardsFor = (phase: Phase): GameSnapshotDto['leaderboards'] => {
  const completed =
    phase === 'confirmed-1' ||
    phase === 'request-2' ||
    phase === 'rejected-2' ||
    phase === 'pending-close' ||
    phase === 'closed';
  if (!completed) {
    return {
      blackout: { category: CompletionCategory.Blackout, totalCompletions: 0, entries: [] },
      line: { category: CompletionCategory.Line, entries: [] },
      hashtag: { category: CompletionCategory.Hashtag, totalCompletions: 0, entries: [] },
    };
  }
  const completedAt = UPDATED_AT;
  const blackoutCompletion = {
    id: 'completion-blackout' as GameSnapshotDto['leaderboards']['blackout']['entries'][number]['completions'][number]['id'],
    gameId: GAME_ID,
    participantId: PARTICIPANT_A,
    playerCode: 'PLAYRA' as GameSnapshotDto['profile']['playerCode'],
    category: CompletionCategory.Blackout,
    completionKey: 'blackout' as const,
    completedAt,
  };
  const lineCompletion = {
    ...blackoutCompletion,
    id: 'completion-line' as typeof blackoutCompletion.id,
    category: CompletionCategory.Line,
    completionKey: 'horizontal:1' as const,
  };
  const hashtagCompletion = {
    ...blackoutCompletion,
    id: 'completion-hashtag' as typeof blackoutCompletion.id,
    category: CompletionCategory.Hashtag,
    completionKey: 'hashtag' as const,
  };
  const identity = participant(PARTICIPANT_A, 'Player A', 'PLAYRA');
  return {
    blackout: {
      category: CompletionCategory.Blackout,
      totalCompletions: 1,
      entries: [
        {
          participant: identity,
          completionCount: 1,
          earliestCompletionAt: completedAt,
          completions: [blackoutCompletion],
        },
      ],
    },
    line: {
      category: CompletionCategory.Line,
      entries: [
        {
          participant: identity,
          completionCount: 1,
          earliestCompletionAt: completedAt,
          completions: [lineCompletion],
        },
      ],
    },
    hashtag: {
      category: CompletionCategory.Hashtag,
      totalCompletions: 1,
      entries: [
        {
          participant: identity,
          completionCount: 1,
          earliestCompletionAt: completedAt,
          completions: [hashtagCompletion],
        },
      ],
    },
  };
};

const snapshotFor = (version: number, phase: Phase): GameSnapshotDto => {
  const requestStatuses: Array<[1 | 2 | 3, VerificationRequestStatus]> = [];
  const notificationStatuses: Array<[1 | 2 | 3, NotificationStatus]> = [];
  if (phase !== 'initial') {
    requestStatuses.push([
      1,
      phase === 'request-1'
        ? VerificationRequestStatus.Pending
        : VerificationRequestStatus.Confirmed,
    ]);
    notificationStatuses.push([
      1,
      phase === 'request-1' ? NotificationStatus.Pending : NotificationStatus.Resolved,
    ]);
  }
  if (
    phase === 'request-2' ||
    phase === 'rejected-2' ||
    phase === 'pending-close' ||
    phase === 'closed'
  ) {
    requestStatuses.push([
      2,
      phase === 'request-2' || phase === 'pending-close' || phase === 'closed'
        ? VerificationRequestStatus.Pending
        : VerificationRequestStatus.Rejected,
    ]);
    notificationStatuses.push([
      2,
      phase === 'request-2' ? NotificationStatus.Pending : NotificationStatus.Resolved,
    ]);
  }
  if (phase === 'pending-close' || phase === 'closed') {
    requestStatuses.push([3, VerificationRequestStatus.Pending]);
    notificationStatuses.push([3, NotificationStatus.Pending]);
  }
  const game = {
    id: GAME_ID,
    name: 'Realtime Bingo',
    status: phase === 'closed' ? GameStatus.Closed : GameStatus.Active,
    distinctTaskCount: 25,
    taskBagLocked: true,
    stateVersion: version as StateVersion,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...(phase === 'closed' ? { closedAt: UPDATED_AT } : {}),
  };
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index}` as GameSnapshotDto['tasks'][number]['id'],
    text: `Task ${index}`,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  }));
  return {
    game,
    tasks,
    membership: {
      id: 'membership-a' as GameSnapshotDto['membership']['id'],
      gameId: GAME_ID,
      participantId: PARTICIPANT_A,
      createdAt: CREATED_AT,
      lastSeenAt: UPDATED_AT,
    },
    participant: { id: PARTICIPANT_A, displayName: 'Player A', joinedAt: CREATED_AT },
    profile: {
      id: 'profile-a' as GameSnapshotDto['profile']['id'],
      participantId: PARTICIPANT_A,
      displayName: 'Player A',
      playerCode: 'PLAYRA' as GameSnapshotDto['profile']['playerCode'],
      createdAt: CREATED_AT,
    },
    grid: gridFor(PARTICIPANT_A, GRID_A, phase),
    verificationRequests: requestStatuses.map(([number, status]) => requestFor(number, status)),
    notifications: notificationStatuses.map(([number, status]) => notificationFor(number, status)),
    leaderboards: leaderboardsFor(phase),
    stateVersion: version as StateVersion,
  };
};

const changesFor = (phase: Phase): GamePatchDto['changes'] => {
  const snapshot = snapshotFor(0, phase);
  const secondGrid = gridFor(PARTICIPANT_B, GRID_B, phase).squares;
  return {
    ...(phase === 'closed' ? { game: snapshot.game } : {}),
    squares: [...snapshot.grid.squares, ...secondGrid],
    verificationRequests: snapshot.verificationRequests,
    notifications: snapshot.notifications,
    leaderboards: snapshot.leaderboards,
  };
};

const outboxFor = (version: number, phase: Phase): PersistenceOutboxEventRecord => ({
  id: `event-${version}` as OutboxEventId,
  gameId: GAME_ID,
  stateVersion: BigInt(version),
  eventType: 'verification.changed',
  payload: { changes: changesFor(phase) },
  createdAt: new Date(UPDATED_AT),
  publishedAt: null,
  attemptCount: 0,
  nextAttemptAt: null,
  lastError: null,
});

const parseEvent = (message: string): RealtimeEvent => JSON.parse(message) as RealtimeEvent;

const createFixture = async (options: {
  readonly seededVersion?: StateVersion;
  readonly lastKnownStateVersion?: StateVersion;
} = {}): Promise<{
  readonly gateway: RealtimeGateway;
  readonly clients: readonly [BrowserClient, BrowserClient];
  readonly setAuthoritative: (version: number, phase: Phase) => void;
}> => {
  const lastKnownStateVersion = options.lastKnownStateVersion ?? (0 as StateVersion);
  let authoritative = snapshotFor(Number(lastKnownStateVersion), 'initial');
  const principalFor = (participantId: ParticipantId): AuthorizationPrincipal => ({
    accountOrGuestIdentity: `membership:${participantId}`,
    membershipId: `membership-${participantId}` as never,
    participantId,
  });
  const gateway = new RealtimeGateway(
    {
      authorize: ({ gameId, principal }) =>
        Promise.resolve({
          gameId,
          principal,
          participantId: principal.participantId!,
          membership: {} as never,
        }),
    },
    { authenticate: (credential) => Promise.resolve(principalFor(credential as ParticipantId)) },
    {
      heartbeat: { intervalMs: 60_000, timeoutMs: 1_000, maxMissedPongs: 2 },
      ...(options.seededVersion === undefined
        ? {}
        : { seedVersion: vi.fn(() => Promise.resolve(options.seededVersion!)) }),
    },
  );

  const createClient = async (participantId: ParticipantId): Promise<BrowserClient> => {
    const socket = new BrowserSocket();
    const controller = new GameSyncController({
      gameId: GAME_ID,
      loader: { loadSnapshot: () => Promise.resolve(authoritative) },
    });
    await gateway.accept(socket, {
      gameId: GAME_ID,
      sessionCredential: participantId,
      lastKnownStateVersion,
    });
    await controller.loadInitialSnapshot();
    let delivered = 0;
    const flush = async (): Promise<void> => {
      while (delivered < socket.messages.length) {
        const event = parseEvent(socket.messages[delivered]!);
        delivered += 1;
        if (event.type !== 'game.patch' && event.type !== 'snapshot_required') continue;
        await controller.handleRealtimeEvent(event);
      }
    };
    return { participantId, socket, controller, flush };
  };

  const clients = [await createClient(PARTICIPANT_A), await createClient(PARTICIPANT_B)] as const;
  return {
    gateway,
    clients,
    setAuthoritative: (version, phase) => {
      authoritative = snapshotFor(version, phase);
    },
  };
};

const publishAndDeliver = async (
  fixture: Awaited<ReturnType<typeof createFixture>>,
  version: number,
  phase: Phase,
): Promise<number> => {
  fixture.setAuthoritative(version, phase);
  const startedAt = Date.now();
  await expect(fixture.gateway.publish(outboxFor(version, phase))).resolves.toBe(true);
  await Promise.all(fixture.clients.map((client) => client.flush()));
  return Date.now() - startedAt;
};

describe('task 10.4 realtime browser-client end to end', () => {
  it('propagates request, confirm, reject, and close events to two authorized clients', async () => {
    const fixture = await createFixture();
    const [requester, identified] = fixture.clients;

    expect(requester.controller.view?.stateVersion).toBe(0);
    expect(identified.controller.view?.stateVersion).toBe(0);

    expect(await publishAndDeliver(fixture, 1, 'request-1')).toBeLessThan(5_000);
    expect(requester.controller.view?.stateVersion).toBe(1);
    expect(identified.controller.view?.stateVersion).toBe(1);
    expect(requester.controller.view?.verificationRequests.get('request-1' as never)?.status).toBe(
      VerificationRequestStatus.Pending,
    );
    expect(identified.controller.view?.notifications.get('notification-1' as never)?.status).toBe(
      NotificationStatus.Pending,
    );

    expect(await publishAndDeliver(fixture, 2, 'confirmed-1')).toBeLessThan(5_000);
    for (const client of fixture.clients) {
      expect(
        client.controller.view?.squares.get(`${client.controller.view.grid.id}:0`)?.status,
      ).toBe(SquareStatus.Verified);
      expect(client.controller.view?.verificationRequests.get('request-1' as never)?.status).toBe(
        VerificationRequestStatus.Confirmed,
      );
      expect(client.controller.view?.leaderboards.blackout.totalCompletions).toBe(1);
      expect(client.controller.view?.leaderboards.line.entries[0]?.completionCount).toBe(1);
      expect(client.controller.view?.leaderboards.hashtag.totalCompletions).toBe(1);
      expect(client.controller.view?.stateVersion).toBe(2);
    }
    expect(requester.controller.view?.leaderboards).toEqual(
      identified.controller.view?.leaderboards,
    );

    expect(await publishAndDeliver(fixture, 3, 'request-2')).toBeLessThan(5_000);
    expect(await publishAndDeliver(fixture, 4, 'rejected-2')).toBeLessThan(5_000);
    for (const client of fixture.clients) {
      expect(
        client.controller.view?.squares.get(`${client.controller.view.grid.id}:1`)?.status,
      ).toBe(SquareStatus.Rejected);
      expect(client.controller.view?.verificationRequests.get('request-2' as never)?.status).toBe(
        VerificationRequestStatus.Rejected,
      );
      expect(client.controller.view?.notifications.get('notification-2' as never)?.status).toBe(
        NotificationStatus.Resolved,
      );
      expect(client.controller.view?.stateVersion).toBe(4);
    }

    expect(await publishAndDeliver(fixture, 5, 'pending-close')).toBeLessThan(5_000);
    expect(await publishAndDeliver(fixture, 6, 'closed')).toBeLessThan(5_000);
    for (const client of fixture.clients) {
      expect(client.controller.view?.game.status).toBe(GameStatus.Closed);
      expect(
        client.controller.view?.squares.get(`${client.controller.view.grid.id}:1`)?.status,
      ).toBe(SquareStatus.Rejected);
      expect(client.controller.view?.verificationRequests.get('request-3' as never)?.status).toBe(
        VerificationRequestStatus.Pending,
      );
      expect(client.controller.view?.notifications.get('notification-3' as never)?.status).toBe(
        NotificationStatus.Pending,
      );
      expect(client.controller.view?.leaderboards.blackout.totalCompletions).toBe(1);
      expect(client.controller.view?.leaderboards.line.entries[0]?.completionCount).toBe(1);
      expect(client.controller.view?.leaderboards.hashtag.totalCompletions).toBe(1);
      expect(client.controller.view?.stateVersion).toBe(6);
    }
    expect(requester.controller.view?.verificationRequests).toEqual(
      identified.controller.view?.verificationRequests,
    );
    expect(requester.controller.view?.notifications).toEqual(
      identified.controller.view?.notifications,
    );

    fixture.clients.forEach((client) => client.controller.handleRealtimeDisconnect());
    expect(requester.controller.controls.canSubmitStateDependentActions).toBe(false);
    expect(identified.controller.controls.canSubmitStateDependentActions).toBe(false);
    fixture.clients.forEach((client) => client.controller.stopPolling());
  });

  it('rebuilds after reconnect and event gaps, deduplicates events, and blocks stale commands during sync', async () => {
    const fixture = await createFixture();
    const [requester, identified] = fixture.clients;
    await publishAndDeliver(fixture, 1, 'request-1');
    const firstPatch = parseEvent(requester.socket.messages[0]!);
    expect(firstPatch.type).toBe('game.patch');
    await expect(fixture.gateway.publish(outboxFor(1, 'request-1'))).resolves.toBe(false);
    expect(await requester.controller.handleRealtimeEvent(firstPatch)).toMatchObject({
      status: 'duplicate',
      synchronized: true,
    });

    await publishAndDeliver(fixture, 2, 'confirmed-1');
    await publishAndDeliver(fixture, 3, 'request-2');
    await publishAndDeliver(fixture, 4, 'rejected-2');
    await publishAndDeliver(fixture, 5, 'pending-close');
    await publishAndDeliver(fixture, 6, 'closed');

    fixture.setAuthoritative(6, 'closed');
    requester.controller.handleRealtimeDisconnect();
    expect(requester.controller.controls).toMatchObject({
      synchronized: false,
      canSubmitStateDependentActions: false,
    });
    expect(await requester.controller.reconnect()).toBe(true);
    expect(requester.controller.view?.stateVersion).toBe(6);
    expect(requester.controller.view?.game.status).toBe(GameStatus.Closed);
    expect(requester.controller.controls.canSubmitStateDependentActions).toBe(true);

    fixture.setAuthoritative(8, 'closed');
    const delayed = new Promise<GameSnapshotDto>((resolve) => {
      setTimeout(() => resolve(snapshotFor(8, 'closed')), 0);
    });
    const blockedController = new GameSyncController({
      gameId: GAME_ID,
      loader: { loadSnapshot: () => delayed },
    });
    blockedController.cache.replaceSnapshot(snapshotFor(6, 'closed'));
    blockedController.handleRealtimeDisconnect();
    const reconnecting = blockedController.reconnect();
    expect(blockedController.controls.canSubmitStateDependentActions).toBe(false);
    await expect(reconnecting).resolves.toBe(true);
    expect(blockedController.controls.canSubmitStateDependentActions).toBe(true);
    expect(blockedController.view?.stateVersion).toBe(8);

    await publishAndDeliver(fixture, 7, 'closed');
    fixture.setAuthoritative(9, 'closed');
    await expect(fixture.gateway.publish(outboxFor(9, 'closed'))).resolves.toBe(true);
    await Promise.all(fixture.clients.map((client) => client.flush()));
    expect(requester.controller.view?.stateVersion).toBe(9);
    expect(identified.controller.view?.stateVersion).toBe(9);
    expect(requester.controller.view?.sync.status).toBe('synchronized');
    expect(identified.controller.view?.sync.status).toBe('synchronized');

    let refreshed = false;
    const staleController = new GameSyncController({
      gameId: GAME_ID,
      loader: {
        loadSnapshot: () => {
          refreshed = true;
          return Promise.resolve(snapshotFor(10, 'closed'));
        },
      },
    });
    staleController.cache.replaceSnapshot(snapshotFor(9, 'closed'));
    await expect(
      staleController.runStateDependent(() =>
        Promise.reject(Object.assign(new Error('stale'), { code: 'STALE_STATE' })),
      ),
    ).rejects.toMatchObject({ code: 'STALE_STATE' });
    expect(refreshed).toBe(true);
    expect(staleController.view?.stateVersion).toBe(10);
    expect(staleController.controls.message).toContain('retry');
    expect(staleController.view?.game.status).toBe(GameStatus.Closed);

    requester.controller.stopPolling();
    identified.controller.stopPolling();
    blockedController.stopPolling();
    staleController.stopPolling();
  });

  it('seeds a restarted gateway from the published outbox version so reconnecting clients do not loop', async () => {
    const original = await createFixture();
    await publishAndDeliver(original, 5, 'confirmed-1');
    original.clients.forEach((client) => client.controller.handleRealtimeDisconnect());
    original.clients.forEach((client) => client.controller.stopPolling());

    const restarted = await createFixture({
      seededVersion: 5 as StateVersion,
      lastKnownStateVersion: 5 as StateVersion,
    });
    const [requester, identified] = restarted.clients;
    restarted.setAuthoritative(5, 'confirmed-1');

    expect(requester.socket.messages).toHaveLength(0);
    expect(identified.socket.messages).toHaveLength(0);
    expect(requester.controller.view?.sync.status).toBe('synchronized');
    expect(identified.controller.view?.sync.status).toBe('synchronized');

    await publishAndDeliver(restarted, 6, 'pending-close');
    expect(parseEvent(requester.socket.messages[0]!).type).toBe('game.patch');
    expect(parseEvent(identified.socket.messages[0]!).type).toBe('game.patch');
    expect(requester.controller.view?.stateVersion).toBe(6);
    expect(identified.controller.view?.stateVersion).toBe(6);
    expect(requester.controller.view?.sync.status).toBe('synchronized');
    expect(identified.controller.view?.sync.status).toBe('synchronized');

    restarted.clients.forEach((client) => client.controller.stopPolling());
  });
});
