import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  GameStatus,
  HumanBingoError,
  NotificationStatus,
  SquareStatus,
  VerificationRequestStatus,
  type CorrelationId,
  type GameId,
  type GridId,
  type IdempotencyKey,
  type ParticipantId,
  type PlayerCode,
  type StateVersion,
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

import { VerificationService } from './verification.js';

const gameId = 'game-1' as GameId;
const gridId = 'grid-1' as GridId;
const requesterId = 'participant-1' as ParticipantId;
const identifiedId = 'participant-2' as ParticipantId;
const correlationId = 'correlation-1' as CorrelationId;

const clock = (() => {
  let value = new Date('2025-01-01T00:00:00.000Z');
  return {
    now: () => new Date(value),
    advance: (milliseconds: number) => {
      value = new Date(value.getTime() + milliseconds);
    },
  };
})();

const recordFixture = () => {
  const game: GameRecord = {
    id: gameId,
    hostAccountId: 'host-1',
    name: 'Team Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: new Date('2025-01-01T00:00:00.000Z'),
    closedAt: null,
    stateVersion: 0n,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  };
  const participants: ParticipantRecord[] = [
    { id: requesterId, gameId, createdAt: game.createdAt, leftAt: null },
    { id: identifiedId, gameId, createdAt: game.createdAt, leftAt: null },
    { id: 'participant-3' as ParticipantId, gameId, createdAt: game.createdAt, leftAt: null },
  ];
  const memberships: MembershipRecord[] = participants.map((participant, index) => ({
    id: `membership-${index + 1}` as MembershipRecord['id'],
    gameId,
    participantId: participant.id,
    browserSessionId: null,
    resumableCredentialHash: new Uint8Array([index + 1]),
    createdAt: game.createdAt,
    lastSeenAt: game.createdAt,
  }));
  const profiles: PlayerProfileRecord[] = [
    {
      id: 'profile-1' as PlayerProfileRecord['id'],
      gameId,
      participantId: requesterId,
      displayName: 'Requester',
      playerCode: 'ALPHA',
      createdAt: game.createdAt,
    },
    {
      id: 'profile-2' as PlayerProfileRecord['id'],
      gameId,
      participantId: identifiedId,
      displayName: 'Identified',
      playerCode: 'BRAVO',
      createdAt: game.createdAt,
    },
    {
      id: 'profile-3' as PlayerProfileRecord['id'],
      gameId,
      participantId: 'participant-3' as ParticipantId,
      displayName: 'Third',
      playerCode: 'CHARLIE',
      createdAt: game.createdAt,
    },
  ];
  const tasks: TaskEntryRecord[] = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${index}` as TaskEntryRecord['id'],
    gameId,
    displayText: `Task ${index}`,
    normalizedText: `task ${index}`,
    createdAt: game.createdAt,
    updatedAt: game.createdAt,
    removedAt: null,
  }));
  const grid: GridRecord = {
    id: gridId,
    gameId,
    participantId: requesterId,
    taskBagVersion: 1n,
    stateVersion: 0n,
    createdAt: game.createdAt,
  };
  const squares: SquareRecord[] = tasks.map((task, squareIndex) => ({
    gridId,
    gameId,
    squareIndex,
    taskEntryId: task.id,
    status: SquareStatus.Unverified,
    updatedAt: game.createdAt,
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
};

const commandBase = {
  gameId,
  gridId,
  squareIndex: 0,
  identifiedPlayerCode: 'BRAVO' as PlayerCode,
  correlationId,
  knownStateVersion: 0 as StateVersion,
  idempotencyKey: 'request-1' as IdempotencyKey,
};

const expectCode = async (operation: () => Promise<unknown>, code: DomainErrorCode) => {
  let error: unknown;
  try {
    await operation();
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HumanBingoError);
  expect((error as HumanBingoError).code).toBe(code);
};

describe('VerificationService', () => {
  it('creates one pending request atomically and rejects duplicate or self verification', async () => {
    const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-${++sequence}`;
      })(),
    });

    const result = await service.request(commandBase, requesterId);
    expect(result.request.status).toBe(VerificationRequestStatus.Pending);
    expect(result.square.status).toBe(SquareStatus.Pending);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.status).toBe(NotificationStatus.Pending);
    expect(result.stateVersion).toBe(1);

    const state = await repository.read(gameId);
    expect(state.verificationRequests).toHaveLength(1);
    expect(state.squares[0]?.status).toBe(SquareStatus.Pending);
    expect(state.game.stateVersion).toBe(1n);

    await expectCode(
      () =>
        service.request(
          {
            ...commandBase,
            idempotencyKey: 'request-2' as IdempotencyKey,
            knownStateVersion: 1 as StateVersion,
          },
          requesterId,
        ),
      DomainErrorCode.RequestAlreadyPending,
    );
    await expectCode(
      () =>
        service.request(
          {
            ...commandBase,
            squareIndex: 1,
            identifiedPlayerCode: 'ALPHA' as PlayerCode,
            idempotencyKey: 'self-request' as IdempotencyKey,
            knownStateVersion: 1 as StateVersion,
          },
          requesterId,
        ),
      DomainErrorCode.SelfVerification,
    );
    expect((await repository.read(gameId)).verificationRequests).toHaveLength(1);
  });

  it('allows one identified participant only once per grid even after the request was resolved', async () => {
    const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-${++sequence}`;
      })(),
    });

    const created = await service.request(commandBase, requesterId);
    expect(created.request.status).toBe(VerificationRequestStatus.Pending);

    await service.reject(
      {
        gameId,
        verificationRequestId: created.request.id,
        decision: 'reject',
        correlationId,
        knownStateVersion: 1 as StateVersion,
        idempotencyKey: 'reject-1' as IdempotencyKey,
      },
      identifiedId,
    );
    expect((await repository.read(gameId)).game.stateVersion).toBe(2n);

    await expectCode(
      () =>
        service.request(
          {
            ...commandBase,
            squareIndex: 1,
            idempotencyKey: 'request-2' as IdempotencyKey,
            knownStateVersion: 2 as StateVersion,
          },
          requesterId,
        ),
      DomainErrorCode.DuplicateIdentifiedParticipant,
    );
    expect((await repository.read(gameId)).verificationRequests).toHaveLength(1);
  });

  it('dispatches optional push after committing the durable notification and ignores provider failure', async () => {
    const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
    const pushes: unknown[] = [];
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-${++sequence}`;
      })(),
      pushNotifier: {
        deliverVerificationRequest: (input) => {
          pushes.push(input);
          return Promise.reject(new Error('provider unavailable'));
        },
      },
    });

    await expect(service.request(commandBase, requesterId)).resolves.toMatchObject({
      request: { status: VerificationRequestStatus.Pending },
    });
    expect(pushes).toEqual([
      {
        gameId,
        participantId: identifiedId,
        verificationRequestId: 'generated-1',
        gameName: 'Team Bingo',
        requestingParticipant: 'Requester',
        taskText: 'Task 0',
      },
    ]);
    const state = await repository.read(gameId);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.status).toBe(NotificationStatus.Pending);
  });

  it('authorizes responses, records timestamps, resolves notifications, and replays idempotently', async () => {
    const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-${++sequence}`;
      })(),
    });
    const requested = await service.request(commandBase, requesterId);
    clock.advance(1000);
    const responseCommand = {
      gameId,
      verificationRequestId: requested.request.id,
      decision: 'confirm' as const,
      correlationId,
      knownStateVersion: 1 as StateVersion,
      idempotencyKey: 'response-1' as IdempotencyKey,
    };

    await expectCode(
      () => service.confirm(responseCommand, requesterId),
      DomainErrorCode.NotIdentifiedParticipant,
    );
    const confirmed = await service.confirm(responseCommand, identifiedId);
    expect(confirmed.request.status).toBe(VerificationRequestStatus.Confirmed);
    expect(confirmed.request.decision).toBe('confirm');
    expect(confirmed.request.resolvedAt).toBe('2025-01-01T00:00:01.000Z');
    expect(confirmed.square.status).toBe(SquareStatus.Verified);
    expect(confirmed.square.stampIndex).toBeGreaterThanOrEqual(0);
    expect(confirmed.square.stampIndex).toBeLessThan(11);
    expect(confirmed.notifications[0]?.status).toBe(NotificationStatus.Resolved);
    expect(confirmed.stateVersion).toBe(2);

    const replay = await service.confirm(
      { ...responseCommand, knownStateVersion: 999 as StateVersion },
      identifiedId,
    );
    expect(replay).toEqual(confirmed);
    const persisted = await repository.read(gameId);
    expect(persisted.game.stateVersion).toBe(2n);
    expect(
      persisted.squares.find((square) => square.squareIndex === confirmed.square.squareIndex)
        ?.stampIndex,
    ).toBe(confirmed.square.stampIndex);
  });

  it('retains rejected history, blocks reusing the identified participant, and rejects stale or closed commands', async () => {
    const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-${++sequence}`;
      })(),
    });
    const first = await service.request(commandBase, requesterId);
    const rejected = await service.reject(
      {
        gameId,
        verificationRequestId: first.request.id,
        decision: 'reject',
        correlationId,
        knownStateVersion: 1 as StateVersion,
        idempotencyKey: 'response-reject' as IdempotencyKey,
      },
      identifiedId,
    );
    expect(rejected.square.status).toBe(SquareStatus.Rejected);
    expect(rejected.request.decision).toBe('reject');
    expect(rejected.notifications[0]?.status).toBe(NotificationStatus.Resolved);

    await expectCode(
      () =>
        service.request(
          {
            ...commandBase,
            knownStateVersion: 2 as StateVersion,
            idempotencyKey: 'request-2' as IdempotencyKey,
          },
          requesterId,
        ),
      DomainErrorCode.DuplicateIdentifiedParticipant,
    );
    expect((await repository.read(gameId)).verificationRequests).toHaveLength(1);

    await expectCode(
      () =>
        service.request(
          {
            ...commandBase,
            knownStateVersion: 0 as StateVersion,
            idempotencyKey: 'stale' as IdempotencyKey,
          },
          requesterId,
        ),
      DomainErrorCode.StaleState,
    );
    await repository.withVerificationState(gameId, (state) => {
      state.game = {
        ...state.game,
        status: GameStatus.Closed,
        closedAt: new Date('2025-01-01T00:00:02.000Z'),
      };
    });
    await expectCode(
      () =>
        service.confirm(
          {
            gameId,
            verificationRequestId: first.request.id,
            decision: 'confirm',
            correlationId,
            knownStateVersion: 3 as StateVersion,
            idempotencyKey: 'closed-response' as IdempotencyKey,
          },
          identifiedId,
        ),
      DomainErrorCode.GameClosed,
    );
  });

  it('lists recipient-scoped pending notifications, counts actions, and retains resolved history', async () => {
    const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-${++sequence}`;
      })(),
    });

    await service.request(commandBase, requesterId);

    const identifiedPending = await service.listNotifications(
      { gameId, correlationId },
      identifiedId,
    );
    expect(identifiedPending.pendingCount).toBe(1);
    expect(identifiedPending.notifications).toHaveLength(1);
    expect(identifiedPending.notifications[0]).toMatchObject({
      recipientParticipantId: identifiedId,
      verificationRequestId: identifiedPending.notifications[0]?.verificationRequestId,
      status: NotificationStatus.Pending,
      taskText: 'Task 0',
    });

    const requesterPending = await service.listNotifications(
      { gameId, correlationId },
      requesterId,
    );
    expect(requesterPending).toEqual({ notifications: [], pendingCount: 0 });

    const responseCommand = {
      gameId,
      verificationRequestId: identifiedPending.notifications[0]!.verificationRequestId,
      decision: 'confirm' as const,
      correlationId,
      knownStateVersion: 1 as StateVersion,
      idempotencyKey: 'notification-response' as IdempotencyKey,
    };
    await service.confirm(responseCommand, identifiedId);

    const pendingAfterResolution = await service.listNotifications(
      { gameId, correlationId },
      identifiedId,
    );
    expect(pendingAfterResolution).toEqual({ notifications: [], pendingCount: 0 });

    const history = await service.listNotifications(
      { gameId, correlationId, includeResolved: true },
      identifiedId,
    );
    expect(history.pendingCount).toBe(0);
    expect(history.notifications).toHaveLength(1);
    const resolvedNotification = history.notifications[0];
    expect(resolvedNotification?.recipientParticipantId).toBe(identifiedId);
    expect(resolvedNotification?.status).toBe(NotificationStatus.Resolved);
    expect(resolvedNotification?.resolvedAt).toBeDefined();
  });

  it('does not disclose notification history to a non-member', async () => {
    const repository = new InMemoryVerificationRepository({ states: [recordFixture()] });
    const service = new VerificationService(repository);

    await expectCode(
      () => service.listNotifications({ gameId, correlationId }, 'not-a-member' as ParticipantId),
      DomainErrorCode.Forbidden,
    );
  });

  it('inserts every completion key affected by one confirmation and versions the grid atomically', async () => {
    const state = recordFixture();
    state.squares = state.squares.map((square) =>
      square.squareIndex === 12 ? square : { ...square, status: SquareStatus.Verified },
    );
    const repository = new InMemoryVerificationRepository({ states: [state] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-multi-${++sequence}`;
      })(),
    });

    const requested = await service.request({ ...commandBase, squareIndex: 12 }, requesterId);
    const confirmed = await service.confirm(
      {
        gameId,
        verificationRequestId: requested.request.id,
        decision: 'confirm',
        correlationId,
        knownStateVersion: 1 as StateVersion,
        idempotencyKey: 'multi-response' as IdempotencyKey,
      },
      identifiedId,
    );

    expect(confirmed.completions.map((completion) => completion.completionKey)).toEqual([
      'blackout',
      'horizontal:3',
      'vertical:3',
      'diagonal:top_left_to_bottom_right',
      'diagonal:top_right_to_bottom_left',
    ]);
    expect(confirmed.stateVersion).toBe(2);
    expect(confirmed.request.status).toBe(VerificationRequestStatus.Confirmed);
    expect(confirmed.square.status).toBe(SquareStatus.Verified);
    expect(confirmed.notifications[0]?.status).toBe(NotificationStatus.Resolved);
    const persisted = await repository.read(gameId);
    expect(persisted.completions).toHaveLength(5);
    expect(persisted.game.stateVersion).toBe(2n);
    expect(persisted.grids[0]?.stateVersion).toBe(2n);
    expect(persisted.verificationRequests[0]?.status).toBe(VerificationRequestStatus.Confirmed);
    expect(persisted.squares[12]?.status).toBe(SquareStatus.Verified);
    expect(persisted.notifications[0]?.status).toBe(NotificationStatus.Resolved);
  });

  it('inserts the fixed hashtag completion only when its newly verified square completes the pattern', async () => {
    const state = recordFixture();
    state.squares = state.squares.map((square) =>
      square.squareIndex === 6 ? square : { ...square, status: SquareStatus.Verified },
    );
    const repository = new InMemoryVerificationRepository({ states: [state] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-hashtag-${++sequence}`;
      })(),
    });

    const requested = await service.request({ ...commandBase, squareIndex: 6 }, requesterId);
    const confirmed = await service.confirm(
      {
        gameId,
        verificationRequestId: requested.request.id,
        decision: 'confirm',
        correlationId,
        knownStateVersion: 1 as StateVersion,
        idempotencyKey: 'hashtag-response' as IdempotencyKey,
      },
      identifiedId,
    );

    expect(confirmed.completions.map((completion) => completion.completionKey)).toEqual([
      'blackout',
      'hashtag',
      'horizontal:2',
      'vertical:2',
      'diagonal:top_left_to_bottom_right',
    ]);
  });

  it('keeps completion rows idempotent and preserves each first completion timestamp', async () => {
    const state = recordFixture();
    for (let index = 0; index < 4; index += 1) {
      const square = state.squares[index];
      if (square !== undefined) state.squares[index] = { ...square, status: SquareStatus.Verified };
    }
    for (let index = 5; index < 9; index += 1) {
      const square = state.squares[index];
      if (square !== undefined) state.squares[index] = { ...square, status: SquareStatus.Verified };
    }
    const repository = new InMemoryVerificationRepository({ states: [state] });
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: (() => {
        let sequence = 0;
        return () => `generated-idempotent-${++sequence}`;
      })(),
    });

    const firstRequest = await service.request({ ...commandBase, squareIndex: 4 }, requesterId);
    const first = await service.confirm(
      {
        gameId,
        verificationRequestId: firstRequest.request.id,
        decision: 'confirm',
        correlationId,
        knownStateVersion: 1 as StateVersion,
        idempotencyKey: 'first-line-response' as IdempotencyKey,
      },
      identifiedId,
    );
    const firstCompletion = first.completions.find(
      (completion) => completion.completionKey === 'horizontal:1',
    );
    expect(firstCompletion).toBeDefined();

    clock.advance(1000);
    const secondRequest = await service.request(
      {
        ...commandBase,
        squareIndex: 9,
        identifiedPlayerCode: 'CHARLIE' as PlayerCode,
        knownStateVersion: 2 as StateVersion,
        idempotencyKey: 'second-line-request' as IdempotencyKey,
      },
      requesterId,
    );
    const second = await service.confirm(
      {
        gameId,
        verificationRequestId: secondRequest.request.id,
        decision: 'confirm',
        correlationId,
        knownStateVersion: 3 as StateVersion,
        idempotencyKey: 'second-line-response' as IdempotencyKey,
      },
      'participant-3' as ParticipantId,
    );

    expect(second.completions).toHaveLength(1);
    expect(second.completions[0]?.completionKey).toBe('horizontal:2');
    const persisted = await repository.read(gameId);
    expect(persisted.completions).toHaveLength(2);
    expect(
      persisted.completions.find((completion) => completion.completionKey === 'row:1')?.completedAt,
    ).toEqual(new Date(firstCompletion!.completedAt));
    expect(second.stateVersion).toBe(4);
    expect(persisted.game.stateVersion).toBe(4n);
  });

  it('rolls back completion insertion and version changes when completion persistence fails', async () => {
    const state = recordFixture();
    for (let index = 0; index < 4; index += 1) {
      const square = state.squares[index];
      if (square !== undefined) state.squares[index] = { ...square, status: SquareStatus.Verified };
    }
    const repository = new InMemoryVerificationRepository({ states: [state] });
    let generatedIds = 0;
    const service = new VerificationService(repository, {
      now: clock.now,
      idFactory: () => {
        generatedIds += 1;
        if (generatedIds === 3) throw new Error('completion persistence failed');
        return `generated-rollback-${generatedIds}`;
      },
    });

    const requested = await service.request({ ...commandBase, squareIndex: 4 }, requesterId);
    await expect(
      service.confirm(
        {
          gameId,
          verificationRequestId: requested.request.id,
          decision: 'confirm',
          correlationId,
          knownStateVersion: 1 as StateVersion,
          idempotencyKey: 'rollback-response' as IdempotencyKey,
        },
        identifiedId,
      ),
    ).rejects.toThrow('completion persistence failed');

    const persisted = await repository.read(gameId);
    expect(persisted.game.stateVersion).toBe(1n);
    expect(persisted.grids[0]?.stateVersion).toBe(1n);
    expect(persisted.squares[4]?.status).toBe(SquareStatus.Pending);
    expect(persisted.verificationRequests).toHaveLength(1);
    expect(persisted.verificationRequests[0]?.status).toBe(VerificationRequestStatus.Pending);
    expect(persisted.notifications).toHaveLength(1);
    expect(persisted.notifications[0]?.status).toBe(NotificationStatus.Pending);
    expect(persisted.completions).toHaveLength(0);
  });
});
