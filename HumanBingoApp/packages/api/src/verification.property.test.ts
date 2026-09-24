import * as fc from 'fast-check';
import type { AsyncCommand } from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  GameStatus,
  SquareStatus,
  VerificationRequestStatus,
  type CorrelationId,
  type GameId,
  type GridId,
  type IdempotencyKey,
  type ParticipantId,
  type PlayerCode,
  type RequestVerificationCommand,
  type RespondToVerificationCommand,
  type StateVersion,
  type VerificationRequestId,
} from '@human-bingo/domain';
import {
  emptyVerificationState,
  InMemoryVerificationRepository,
  type GameRecord,
  type GridRecord,
  type MembershipRecord,
  type ParticipantRecord,
  type PlayerProfileRecord,
  type TaskEntryRecord,
  type VerificationState,
} from '@human-bingo/persistence';

import { VerificationService } from './verification.js';

const GAME_ID = 'game-1' as GameId;
const OTHER_GAME_ID = 'game-2' as GameId;
const GRID_ID = 'grid-1' as GridId;
const REQUESTER_ID = 'participant-1' as ParticipantId;
const IDENTIFIED_ID = 'participant-2' as ParticipantId;
const OUTSIDER_ID = 'participant-outsider' as ParticipantId;
const ALPHA = 'ALPHA' as PlayerCode;
const BRAVO = 'BRAVO' as PlayerCode;
const CHARLIE = 'CHARLIE' as PlayerCode;
const OTHER_GAME_CODE = 'OTHER-GAME' as PlayerCode;
const INVALID_PLAYER_CODE = 'NOT-A-PLAYER' as PlayerCode;
const CORRELATION_ID = 'property-6' as CorrelationId;

type HistoryEntry = {
  readonly id: VerificationRequestId;
  readonly squareIndex: number;
  status: VerificationRequestStatus;
};

interface VerificationModel {
  version: number;
  squareStatuses: SquareStatus[];
  history: HistoryEntry[];
  pendingRequestId: VerificationRequestId | null;
  pendingSquareIndex: number | null;
  /** Participant identified by the pending request; the only actor who may respond. */
  pendingIdentifiedId: ParticipantId | null;
  lastRejectedSquareIndex: number | null;
  /** Each generated request command models a distinct client idempotency key. */
  usedRequestCommandIds: Set<string>;
  /** Participants already used to identify a square; each may be used once grid-wide. */
  usedIdentifiedParticipants: Set<PlayerCode>;
}

interface VerificationReal {
  readonly service: VerificationService;
  readonly repository: InMemoryVerificationRepository;
}

type VerificationCommand = AsyncCommand<VerificationModel, VerificationReal>;

const timestamp = new Date('2025-01-01T00:00:00.000Z');

function makeGame(id: GameId): GameRecord {
  return {
    id,
    hostAccountId: `host-${id}`,
    name: 'Property 6 Bingo',
    status: GameStatus.Active,
    taskBagLockedAt: timestamp,
    closedAt: null,
    stateVersion: 0n,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeState(
  gameId: GameId,
  gridId: GridId,
  requesterId: ParticipantId,
  identifiedId: ParticipantId,
  requesterCode: PlayerCode,
  identifiedCode: PlayerCode,
): VerificationState {
  const game = makeGame(gameId);
  const participants: ParticipantRecord[] = [
    { id: requesterId, gameId, createdAt: timestamp, leftAt: null },
    { id: identifiedId, gameId, createdAt: timestamp, leftAt: null },
    {
      id: 'participant-3' as ParticipantId,
      gameId,
      createdAt: timestamp,
      leftAt: null,
    },
  ];
  const memberships: MembershipRecord[] = participants.map((participant, index) => ({
    id: `membership-${gameId}-${index + 1}` as MembershipRecord['id'],
    gameId,
    participantId: participant.id,
    browserSessionId: null,
    resumableCredentialHash: new Uint8Array([index + 1]),
    createdAt: timestamp,
    lastSeenAt: timestamp,
  }));
  const profiles: PlayerProfileRecord[] = [
    {
      id: `profile-${gameId}-1` as PlayerProfileRecord['id'],
      gameId,
      participantId: requesterId,
      displayName: 'Requester',
      playerCode: requesterCode,
      createdAt: timestamp,
    },
    {
      id: `profile-${gameId}-2` as PlayerProfileRecord['id'],
      gameId,
      participantId: identifiedId,
      displayName: 'Identified',
      playerCode: identifiedCode,
      createdAt: timestamp,
    },
    {
      id: `profile-${gameId}-3` as PlayerProfileRecord['id'],
      gameId,
      participantId: 'participant-3' as ParticipantId,
      displayName: 'Third',
      playerCode: 'CHARLIE',
      createdAt: timestamp,
    },
  ];
  const tasks: TaskEntryRecord[] = Array.from({ length: 25 }, (_, index) => ({
    id: `${gameId}-task-${index}` as TaskEntryRecord['id'],
    gameId,
    displayText: `Task ${index}`,
    normalizedText: `task ${index}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    removedAt: null,
  }));
  const grid: GridRecord = {
    id: gridId,
    gameId,
    participantId: requesterId,
    taskBagVersion: 1n,
    stateVersion: 0n,
    createdAt: timestamp,
  };
  return emptyVerificationState({
    game,
    tasks,
    memberships,
    participants,
    profiles,
    grids: [grid],
    squares: tasks.map((task, squareIndex) => ({
      gridId,
      gameId,
      squareIndex,
      taskEntryId: task.id,
      status: SquareStatus.Unverified,
      updatedAt: timestamp,
    })),
  });
}

function makeReal(options: { readonly idFactory?: () => string } = {}): VerificationReal {
  const repository = new InMemoryVerificationRepository({
    states: [
      makeState(GAME_ID, GRID_ID, REQUESTER_ID, IDENTIFIED_ID, ALPHA, BRAVO),
      makeState(
        OTHER_GAME_ID,
        'grid-other' as GridId,
        'participant-other-requester' as ParticipantId,
        'participant-other-identified' as ParticipantId,
        'OTHER-REQUESTER' as PlayerCode,
        OTHER_GAME_CODE,
      ),
    ],
  });
  let id = 0;
  const service = new VerificationService(repository, {
    now: () => timestamp,
    idFactory: options.idFactory ?? (() => `property-6-${++id}`),
  });
  return { service, repository };
}

function initialModel(): VerificationModel {
  return {
    version: 0,
    squareStatuses: Array.from({ length: 25 }, () => SquareStatus.Unverified),
    history: [],
    pendingRequestId: null,
    pendingSquareIndex: null,
    pendingIdentifiedId: null,
    lastRejectedSquareIndex: null,
    usedRequestCommandIds: new Set(),
    usedIdentifiedParticipants: new Set(),
  };
}

function participantIdForCode(code: PlayerCode): ParticipantId {
  if (code === BRAVO) return IDENTIFIED_ID;
  if (code === CHARLIE) return 'participant-3' as ParticipantId;
  throw new Error(`No participant mapped for code ${code}`);
}

function requestCommand(
  id: string,
  squareIndex: number,
  knownStateVersion: number,
  identifiedPlayerCode: PlayerCode,
): RequestVerificationCommand {
  return {
    gameId: GAME_ID,
    gridId: GRID_ID,
    squareIndex,
    identifiedPlayerCode,
    correlationId: `${CORRELATION_ID}-${id}` as CorrelationId,
    knownStateVersion: knownStateVersion as StateVersion,
    idempotencyKey: `property-6-${id}` as IdempotencyKey,
  };
}

function responseCommand(
  id: string,
  verificationRequestId: VerificationRequestId,
  knownStateVersion: number,
  decision: 'confirm' | 'reject',
): RespondToVerificationCommand {
  return {
    gameId: GAME_ID,
    verificationRequestId,
    decision,
    correlationId: `${CORRELATION_ID}-${id}` as CorrelationId,
    knownStateVersion: knownStateVersion as StateVersion,
    idempotencyKey: `property-6-${id}` as IdempotencyKey,
  };
}

function stateFingerprint(state: VerificationState): string {
  return JSON.stringify({
    game: {
      status: state.game.status,
      stateVersion: String(state.game.stateVersion),
      closedAt: state.game.closedAt?.toISOString() ?? null,
      updatedAt: state.game.updatedAt.toISOString(),
    },
    tasks: state.tasks.map((task) => ({ id: task.id, text: task.displayText })),
    participants: state.participants,
    profiles: state.profiles,
    grids: state.grids.map((grid) => ({
      ...grid,
      taskBagVersion: String(grid.taskBagVersion),
      stateVersion: String(grid.stateVersion),
      createdAt: grid.createdAt.toISOString(),
    })),
    squares: state.squares.map((square) => ({
      ...square,
      updatedAt: square.updatedAt.toISOString(),
    })),
    verificationRequests: state.verificationRequests.map((request) => ({
      ...request,
      createdAt: request.createdAt.toISOString(),
      resolvedAt: request.resolvedAt?.toISOString() ?? null,
    })),
    notifications: state.notifications.map((notification) => ({
      ...notification,
      createdAt: notification.createdAt.toISOString(),
      resolvedAt: notification.resolvedAt?.toISOString() ?? null,
    })),
    completions: state.completions.map((completion) => ({
      ...completion,
      completedAt: completion.completedAt.toISOString(),
      createdAt: completion.createdAt.toISOString(),
    })),
    idempotencyKeys: [...state.idempotency.keys()],
  });
}

async function expectRejectedWithoutMutation(
  real: VerificationReal,
  operation: () => Promise<unknown>,
  code: DomainErrorCode,
): Promise<void> {
  const before = stateFingerprint(await real.repository.read(GAME_ID));
  await expect(operation()).rejects.toMatchObject({ code });
  expect(stateFingerprint(await real.repository.read(GAME_ID))).toBe(before);
}

async function expectFailedWithoutMutation(
  real: VerificationReal,
  operation: () => Promise<unknown>,
): Promise<void> {
  const before = stateFingerprint(await real.repository.read(GAME_ID));
  await expect(operation()).rejects.toThrow('transaction persistence failed');
  expect(stateFingerprint(await real.repository.read(GAME_ID))).toBe(before);
}

class ValidRequestCommand implements VerificationCommand {
  public constructor(
    private readonly id: string,
    private readonly squareIndex: number,
  ) {}

  public check(model: Readonly<VerificationModel>): boolean {
    const status = model.squareStatuses[this.squareIndex];
    return (
      (status === SquareStatus.Unverified || status === SquareStatus.Rejected) &&
      !model.usedRequestCommandIds.has(this.id) &&
      model.usedIdentifiedParticipants.size < 2
    );
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const identifiedCode = [BRAVO, CHARLIE].find(
      (code) => !model.usedIdentifiedParticipants.has(code),
    );
    if (identifiedCode === undefined) throw new Error('No unused identified participant remains');
    const result = await real.service.request(
      requestCommand(this.id, this.squareIndex, model.version, identifiedCode),
      REQUESTER_ID,
    );
    const state = await real.repository.read(GAME_ID);
    expect(result.request.status).toBe(VerificationRequestStatus.Pending);
    expect(result.square.status).toBe(SquareStatus.Pending);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.status).toBe('pending');
    expect(state.game.stateVersion).toBe(BigInt(model.version + 1));
    expect(state.verificationRequests).toHaveLength(model.history.length + 1);
    expect(state.notifications).toHaveLength(model.history.length + 1);
    expect(state.notifications.at(-1)?.verificationRequestId).toBe(result.request.id);
    expect(state.notifications.at(-1)?.status).toBe('pending');

    model.usedRequestCommandIds.add(this.id);
    model.usedIdentifiedParticipants.add(identifiedCode);
    model.version += 1;
    model.squareStatuses[this.squareIndex] = SquareStatus.Pending;
    model.history.push({
      id: result.request.id,
      squareIndex: this.squareIndex,
      status: VerificationRequestStatus.Pending,
    });
    model.pendingRequestId = result.request.id;
    model.pendingSquareIndex = this.squareIndex;
    model.pendingIdentifiedId = participantIdForCode(identifiedCode);
    model.lastRejectedSquareIndex = null;
  }

  public toString(): string {
    return `valid request(square=${this.squareIndex})`;
  }
}

class DuplicatePendingRequestCommand implements VerificationCommand {
  public constructor(private readonly id: string) {}

  public check(model: Readonly<VerificationModel>): boolean {
    return model.pendingRequestId !== null;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const squareIndex = model.pendingSquareIndex;
    if (squareIndex === null) throw new Error('Pending request has no square');
    await expectRejectedWithoutMutation(
      real,
      () =>
        real.service.request(
          requestCommand(this.id, squareIndex, model.version, BRAVO),
          REQUESTER_ID,
        ),
      DomainErrorCode.RequestAlreadyPending,
    );
  }

  public toString(): string {
    return 'duplicate pending request';
  }
}

class CrossGamePlayerCodeCommand implements VerificationCommand {
  public constructor(
    private readonly id: string,
    private readonly squareIndex: number,
  ) {}

  public check(model: Readonly<VerificationModel>): boolean {
    const status = model.squareStatuses[this.squareIndex];
    return status === SquareStatus.Unverified || status === SquareStatus.Rejected;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    await expectRejectedWithoutMutation(
      real,
      () =>
        real.service.request(
          requestCommand(this.id, this.squareIndex, model.version, OTHER_GAME_CODE),
          REQUESTER_ID,
        ),
      DomainErrorCode.InvalidPlayerCode,
    );
  }

  public toString(): string {
    return `cross-game Player_Code(square=${this.squareIndex})`;
  }
}

class SelfVerificationCommand implements VerificationCommand {
  public constructor(
    private readonly id: string,
    private readonly squareIndex: number,
  ) {}

  public check(model: Readonly<VerificationModel>): boolean {
    const status = model.squareStatuses[this.squareIndex];
    return status === SquareStatus.Unverified || status === SquareStatus.Rejected;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    await expectRejectedWithoutMutation(
      real,
      () =>
        real.service.request(
          requestCommand(this.id, this.squareIndex, model.version, ALPHA),
          REQUESTER_ID,
        ),
      DomainErrorCode.SelfVerification,
    );
  }

  public toString(): string {
    return `self verification(square=${this.squareIndex})`;
  }
}

class ReusedIdentifiedParticipantCommand implements VerificationCommand {
  public constructor(
    private readonly id: string,
    private readonly squareIndex: number,
  ) {}

  public check(model: Readonly<VerificationModel>): boolean {
    const status = model.squareStatuses[this.squareIndex];
    return (
      model.usedIdentifiedParticipants.size > 0 &&
      (status === SquareStatus.Unverified || status === SquareStatus.Rejected)
    );
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const usedCode = [...model.usedIdentifiedParticipants][0];
    if (usedCode === undefined) throw new Error('A used identified participant is required');
    await expectRejectedWithoutMutation(
      real,
      () =>
        real.service.request(
          requestCommand(this.id, this.squareIndex, model.version, usedCode),
          REQUESTER_ID,
        ),
      DomainErrorCode.DuplicateIdentifiedParticipant,
    );
  }

  public toString(): string {
    return `reuse identified participant(square=${this.squareIndex})`;
  }
}

class StaleRequestCommand implements VerificationCommand {
  public constructor(
    private readonly id: string,
    private readonly squareIndex: number,
  ) {}

  public check(model: Readonly<VerificationModel>): boolean {
    const status = model.squareStatuses[this.squareIndex];
    return status === SquareStatus.Unverified || status === SquareStatus.Rejected;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const staleVersion = model.version === 0 ? 1 : model.version - 1;
    await expectRejectedWithoutMutation(
      real,
      () =>
        real.service.request(
          requestCommand(this.id, this.squareIndex, staleVersion, BRAVO),
          REQUESTER_ID,
        ),
      DomainErrorCode.StaleState,
    );
  }

  public toString(): string {
    return `stale request(square=${this.squareIndex})`;
  }
}

class UnauthorizedRequestCommand implements VerificationCommand {
  public constructor(
    private readonly id: string,
    private readonly squareIndex: number,
  ) {}

  public check(model: Readonly<VerificationModel>): boolean {
    const status = model.squareStatuses[this.squareIndex];
    return status === SquareStatus.Unverified || status === SquareStatus.Rejected;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    await expectRejectedWithoutMutation(
      real,
      () =>
        real.service.request(
          requestCommand(this.id, this.squareIndex, model.version, BRAVO),
          OUTSIDER_ID,
        ),
      DomainErrorCode.Forbidden,
    );
  }

  public toString(): string {
    return `unauthorized request(square=${this.squareIndex})`;
  }
}

class UnauthorizedResponseCommand implements VerificationCommand {
  public constructor(private readonly id: string) {}

  public check(model: Readonly<VerificationModel>): boolean {
    return model.pendingRequestId !== null;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const requestId = model.pendingRequestId;
    if (requestId === null) throw new Error('Pending request is required');
    await expectRejectedWithoutMutation(
      real,
      () =>
        real.service.respond(
          responseCommand(this.id, requestId, model.version, 'confirm'),
          REQUESTER_ID,
        ),
      DomainErrorCode.NotIdentifiedParticipant,
    );
  }

  public toString(): string {
    return 'unauthorized response';
  }
}

class ConfirmCommand implements VerificationCommand {
  public constructor(private readonly id: string) {}

  public check(model: Readonly<VerificationModel>): boolean {
    return model.pendingRequestId !== null;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const requestId = model.pendingRequestId;
    const squareIndex = model.pendingSquareIndex;
    if (requestId === null || squareIndex === null) throw new Error('Pending request is required');
    const result = await real.service.confirm(
      responseCommand(this.id, requestId, model.version, 'confirm'),
      model.pendingIdentifiedId ?? IDENTIFIED_ID,
    );
    const state = await real.repository.read(GAME_ID);
    expect(result.request.status).toBe(VerificationRequestStatus.Confirmed);
    expect(result.request.decision).toBe('confirm');
    expect(result.square.status).toBe(SquareStatus.Verified);
    expect(result.notifications[0]?.status).toBe('resolved');
    expect(state.game.stateVersion).toBe(BigInt(model.version + 1));
    expect(state.verificationRequests.find((request) => request.id === requestId)?.status).toBe(
      VerificationRequestStatus.Confirmed,
    );
    expect(state.squares.find((square) => square.squareIndex === squareIndex)?.status).toBe(
      SquareStatus.Verified,
    );
    expect(
      state.notifications.find((notification) => notification.verificationRequestId === requestId)
        ?.status,
    ).toBe('resolved');

    model.version += 1;
    model.squareStatuses[squareIndex] = SquareStatus.Verified;
    const history = model.history.find((entry) => entry.id === requestId);
    if (history === undefined) throw new Error('Request history disappeared');
    history.status = VerificationRequestStatus.Confirmed;
    model.pendingRequestId = null;
    model.pendingSquareIndex = null;
    model.pendingIdentifiedId = null;
    model.lastRejectedSquareIndex = null;
  }

  public toString(): string {
    return 'confirm pending request';
  }
}

class RejectCommand implements VerificationCommand {
  public constructor(private readonly id: string) {}

  public check(model: Readonly<VerificationModel>): boolean {
    return model.pendingRequestId !== null;
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const requestId = model.pendingRequestId;
    const squareIndex = model.pendingSquareIndex;
    if (requestId === null || squareIndex === null) throw new Error('Pending request is required');
    const result = await real.service.reject(
      responseCommand(this.id, requestId, model.version, 'reject'),
      model.pendingIdentifiedId ?? IDENTIFIED_ID,
    );
    const state = await real.repository.read(GAME_ID);
    expect(result.request.status).toBe(VerificationRequestStatus.Rejected);
    expect(result.request.decision).toBe('reject');
    expect(result.square.status).toBe(SquareStatus.Rejected);
    expect(result.notifications[0]?.status).toBe('resolved');
    expect(state.game.stateVersion).toBe(BigInt(model.version + 1));
    expect(state.verificationRequests.find((request) => request.id === requestId)?.status).toBe(
      VerificationRequestStatus.Rejected,
    );
    expect(state.squares.find((square) => square.squareIndex === squareIndex)?.status).toBe(
      SquareStatus.Rejected,
    );
    expect(
      state.notifications.find((notification) => notification.verificationRequestId === requestId)
        ?.status,
    ).toBe('resolved');

    model.version += 1;
    model.squareStatuses[squareIndex] = SquareStatus.Rejected;
    const history = model.history.find((entry) => entry.id === requestId);
    if (history === undefined) throw new Error('Request history disappeared');
    history.status = VerificationRequestStatus.Rejected;
    model.pendingRequestId = null;
    model.pendingSquareIndex = null;
    model.pendingIdentifiedId = null;
    model.lastRejectedSquareIndex = squareIndex;
  }

  public toString(): string {
    return 'reject pending request';
  }
}

class LaterRetryCommand implements VerificationCommand {
  public constructor(private readonly id: string) {}

  public check(model: Readonly<VerificationModel>): boolean {
    return (
      model.pendingRequestId === null &&
      model.lastRejectedSquareIndex !== null &&
      model.usedIdentifiedParticipants.size < 2
    );
  }

  public async run(model: VerificationModel, real: VerificationReal): Promise<void> {
    const squareIndex = model.lastRejectedSquareIndex;
    if (squareIndex === null) throw new Error('A rejected square is required');
    const identifiedCode = [BRAVO, CHARLIE].find(
      (code) => !model.usedIdentifiedParticipants.has(code),
    );
    if (identifiedCode === undefined) throw new Error('No unused identified participant remains');
    const result = await real.service.request(
      requestCommand(this.id, squareIndex, model.version, identifiedCode),
      REQUESTER_ID,
    );
    const state = await real.repository.read(GAME_ID);
    expect(result.request.status).toBe(VerificationRequestStatus.Pending);
    expect(result.square.status).toBe(SquareStatus.Pending);
    expect(result.notifications).toHaveLength(1);
    expect(state.game.stateVersion).toBe(BigInt(model.version + 1));
    expect(state.verificationRequests).toHaveLength(model.history.length + 1);
    expect(
      state.verificationRequests.filter(
        (request) => request.status === VerificationRequestStatus.Pending,
      ),
    ).toHaveLength(1);
    expect(
      state.verificationRequests.filter(
        (request) => request.status === VerificationRequestStatus.Rejected,
      ),
    ).not.toHaveLength(0);

    model.version += 1;
    model.squareStatuses[squareIndex] = SquareStatus.Pending;
    model.usedIdentifiedParticipants.add(identifiedCode);
    model.history.push({
      id: result.request.id,
      squareIndex,
      status: VerificationRequestStatus.Pending,
    });
    model.pendingRequestId = result.request.id;
    model.pendingSquareIndex = squareIndex;
    model.pendingIdentifiedId = participantIdForCode(identifiedCode);
    model.lastRejectedSquareIndex = null;
  }

  public toString(): string {
    return 'later retry after rejection';
  }
}

const squareIndexArbitrary = fc.integer({ min: 0, max: 24 });
const commandArbitrary: fc.Arbitrary<VerificationCommand> = fc.oneof(
  fc
    .tuple(fc.uuid(), squareIndexArbitrary)
    .map(([id, squareIndex]) => new ValidRequestCommand(id, squareIndex)),
  fc.uuid().map((id) => new DuplicatePendingRequestCommand(id)),
  fc
    .tuple(fc.uuid(), squareIndexArbitrary)
    .map(([id, squareIndex]) => new CrossGamePlayerCodeCommand(id, squareIndex)),
  fc
    .tuple(fc.uuid(), squareIndexArbitrary)
    .map(([id, squareIndex]) => new SelfVerificationCommand(id, squareIndex)),
  fc
    .tuple(fc.uuid(), squareIndexArbitrary)
    .map(([id, squareIndex]) => new StaleRequestCommand(id, squareIndex)),
  fc
    .tuple(fc.uuid(), squareIndexArbitrary)
    .map(([id, squareIndex]) => new ReusedIdentifiedParticipantCommand(id, squareIndex)),
  fc
    .tuple(fc.uuid(), squareIndexArbitrary)
    .map(([id, squareIndex]) => new UnauthorizedRequestCommand(id, squareIndex)),
  fc.uuid().map((id) => new UnauthorizedResponseCommand(id)),
  fc.uuid().map((id) => new ConfirmCommand(id)),
  fc.uuid().map((id) => new RejectCommand(id)),
  fc.uuid().map((id) => new LaterRetryCommand(id)),
);

describe('VerificationService state machine properties', () => {
  it('preserves the verification request state machine across generated command sequences', async () => {
    // Feature: human-bingo, Property 6: Verification request state machine
    // Validates: Requirements 5.1-5.7, 5.10
    await fc.assert(
      fc.asyncProperty(fc.commands([commandArbitrary], { maxCommands: 40 }), async (commands) => {
        await fc.asyncModelRun(() => ({ model: initialModel(), real: makeReal() }), commands);
      }),
      { numRuns: 100, seed: 20250308 },
    );
  });
});

describe('Verification preservation properties', () => {
  const rejectionScenarioArbitrary = fc.constantFrom(
    'invalid-player-code',
    'self-verification',
    'cross-game-player-code',
    'stale-known-version',
    'unauthorized-response',
    'duplicate-pending-request',
    'closed-game',
    'failed-transaction',
  );

  it('keeps every fingerprinted record unchanged for rejected commands', async () => {
    // Feature: human-bingo, Property 2: Rejected commands are immutable
    // Validates: Requirements 2.2, 3.1, 3.2, 3.3
    await fc.assert(
      fc.asyncProperty(fc.uuid(), rejectionScenarioArbitrary, async (id, scenario) => {
        let real: VerificationReal;
        let operation: () => Promise<unknown>;
        let expectedCode: DomainErrorCode | null = null;

        if (scenario === 'failed-transaction') {
          let allocations = 0;
          real = makeReal({
            idFactory: () => {
              allocations += 1;
              if (allocations === 2) throw new Error('transaction persistence failed');
              return `property-6-failing-${allocations}`;
            },
          });
          operation = () => real.service.request(requestCommand(id, 0, 0, BRAVO), REQUESTER_ID);
          await expectFailedWithoutMutation(real, operation);
          return;
        }

        real = makeReal();
        switch (scenario) {
          case 'invalid-player-code':
            expectedCode = DomainErrorCode.InvalidPlayerCode;
            operation = () =>
              real.service.request(requestCommand(id, 0, 0, INVALID_PLAYER_CODE), REQUESTER_ID);
            break;
          case 'self-verification':
            expectedCode = DomainErrorCode.SelfVerification;
            operation = () => real.service.request(requestCommand(id, 0, 0, ALPHA), REQUESTER_ID);
            break;
          case 'cross-game-player-code':
            expectedCode = DomainErrorCode.InvalidPlayerCode;
            operation = () =>
              real.service.request(requestCommand(id, 0, 0, OTHER_GAME_CODE), REQUESTER_ID);
            break;
          case 'stale-known-version':
            expectedCode = DomainErrorCode.StaleState;
            operation = () => real.service.request(requestCommand(id, 0, 1, BRAVO), REQUESTER_ID);
            break;
          case 'unauthorized-response': {
            const requested = await real.service.request(
              requestCommand(`setup-${id}`, 0, 0, BRAVO),
              REQUESTER_ID,
            );
            expectedCode = DomainErrorCode.NotIdentifiedParticipant;
            operation = () =>
              real.service.respond(
                responseCommand(id, requested.request.id, 1, 'confirm'),
                REQUESTER_ID,
              );
            break;
          }
          case 'duplicate-pending-request': {
            await real.service.request(requestCommand(`setup-${id}`, 0, 0, BRAVO), REQUESTER_ID);
            expectedCode = DomainErrorCode.RequestAlreadyPending;
            operation = () => real.service.request(requestCommand(id, 0, 1, BRAVO), REQUESTER_ID);
            break;
          }
          case 'closed-game':
            await real.repository.withVerificationState(GAME_ID, (state) => {
              state.game = {
                ...state.game,
                status: GameStatus.Closed,
                closedAt: timestamp,
              };
            });
            expectedCode = DomainErrorCode.GameClosed;
            operation = () => real.service.request(requestCommand(id, 0, 0, BRAVO), REQUESTER_ID);
            break;
        }

        if (expectedCode === null) throw new Error(`Unhandled preservation scenario: ${scenario}`);
        await expectRejectedWithoutMutation(real, operation, expectedCode);
      }),
      { numRuns: 100, seed: 20250309 },
    );
  });

  it('returns the original result for request and response replays without mutation', async () => {
    // Feature: human-bingo, Property 2: Idempotent replays are immutable
    // Validates: Requirements 2.2, 3.1, 3.2, 3.3
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        const real = makeReal();
        const request = requestCommand(id, 0, 0, BRAVO);
        const acceptedRequest = await real.service.request(request, REQUESTER_ID);
        const requestFingerprint = stateFingerprint(await real.repository.read(GAME_ID));

        const requestReplay = await real.service.request(
          { ...request, knownStateVersion: 999 as StateVersion },
          REQUESTER_ID,
        );
        expect(requestReplay).toEqual(acceptedRequest);
        expect(stateFingerprint(await real.repository.read(GAME_ID))).toBe(requestFingerprint);

        const response = responseCommand(
          `${id}-response`,
          acceptedRequest.request.id,
          1,
          'confirm',
        );
        const acceptedResponse = await real.service.respond(response, IDENTIFIED_ID);
        const responseFingerprint = stateFingerprint(await real.repository.read(GAME_ID));
        const persistedAfterResponse = await real.repository.read(GAME_ID);

        const responseReplay = await real.service.respond(
          { ...response, knownStateVersion: 999 as StateVersion },
          IDENTIFIED_ID,
        );
        expect(responseReplay).toEqual(acceptedResponse);
        expect(stateFingerprint(await real.repository.read(GAME_ID))).toBe(responseFingerprint);
        expect(persistedAfterResponse.game.stateVersion).toBe(2n);
        expect(persistedAfterResponse.verificationRequests).toHaveLength(1);
        expect(persistedAfterResponse.notifications).toHaveLength(1);
        expect(persistedAfterResponse.grids[0]?.stateVersion).toBe(2n);
      }),
      { numRuns: 100, seed: 20250310 },
    );
  });
});

describe('Verification bug-condition exploration', () => {
  it('keeps one authoritative version through request, rejection, retry, and replay', async () => {
    // Feature: human-bingo, Property 1: One authoritative version across verification mutations
    // Validates: Requirements 2.1-2.3
    const real = makeReal();
    const assertAcceptedVersion = async (
      result: Awaited<ReturnType<VerificationService['request']>>,
      expectedVersion: number,
    ) => {
      expect(result.stateVersion).toBe(expectedVersion);
      const state = await real.repository.read(GAME_ID);
      expect(state.game.stateVersion).toBe(BigInt(expectedVersion));

      const affectedGrids = state.grids.filter((grid) => grid.gameId === GAME_ID);
      expect(affectedGrids.map((grid) => grid.stateVersion)).toEqual([
        ...affectedGrids.map(() => BigInt(expectedVersion)),
      ]);

      const persistedRequest = state.verificationRequests.find(
        (request) => request.id === result.request.id,
      );
      expect(persistedRequest?.status).toBe(result.request.status);
      const persistedSquare = state.squares.find(
        (square) =>
          square.gridId === result.square.gridId &&
          square.squareIndex === result.square.squareIndex,
      );
      expect(persistedSquare?.status).toBe(result.square.status);

      const persistedNotifications = state.notifications.filter(
        (notification) => notification.verificationRequestId === result.request.id,
      );
      expect(persistedNotifications).toHaveLength(result.notifications.length);
      expect(persistedNotifications.map((notification) => notification.status)).toEqual(
        result.notifications.map((notification) => notification.status),
      );
      expect(state.completions).toHaveLength(result.completions.length);
      return state;
    };

    const first = await real.service.request(
      requestCommand('deterministic-request', 0, 0, BRAVO),
      REQUESTER_ID,
    );
    const afterFirst = await assertAcceptedVersion(first, 1);
    expect(first.request.status).toBe(VerificationRequestStatus.Pending);
    expect(first.square.status).toBe(SquareStatus.Pending);
    expect(afterFirst.verificationRequests).toHaveLength(1);
    expect(afterFirst.squares[0]?.status).toBe(SquareStatus.Pending);
    expect(afterFirst.notifications).toHaveLength(1);
    expect(afterFirst.notifications[0]?.status).toBe('pending');

    const rejected = await real.service.reject(
      responseCommand('deterministic-reject', first.request.id, 1, 'reject'),
      IDENTIFIED_ID,
    );
    const afterReject = await assertAcceptedVersion(rejected, 2);
    expect(rejected.request.status).toBe(VerificationRequestStatus.Rejected);
    expect(rejected.square.status).toBe(SquareStatus.Rejected);
    expect(afterReject.verificationRequests).toHaveLength(1);
    expect(afterReject.verificationRequests[0]?.status).toBe(VerificationRequestStatus.Rejected);
    expect(afterReject.squares[0]?.status).toBe(SquareStatus.Rejected);
    expect(afterReject.notifications).toHaveLength(1);
    expect(afterReject.notifications[0]?.status).toBe('resolved');

    const retryCommand = requestCommand('deterministic-retry', 0, 2, CHARLIE);
    const retry = await real.service.request(retryCommand, REQUESTER_ID);
    const afterRetry = await assertAcceptedVersion(retry, 3);
    expect(retry.request.status).toBe(VerificationRequestStatus.Pending);
    expect(retry.square.status).toBe(SquareStatus.Pending);
    expect(afterRetry.verificationRequests).toHaveLength(2);
    expect(afterRetry.verificationRequests.map((request) => request.status)).toEqual([
      VerificationRequestStatus.Rejected,
      VerificationRequestStatus.Pending,
    ]);
    expect(afterRetry.squares[0]?.status).toBe(SquareStatus.Pending);
    expect(afterRetry.notifications).toHaveLength(2);
    expect(afterRetry.notifications.map((notification) => notification.status)).toEqual([
      'resolved',
      'pending',
    ]);

    const beforeReplay = stateFingerprint(afterRetry);
    const replay = await real.service.request(
      { ...retryCommand, knownStateVersion: 999 as StateVersion },
      REQUESTER_ID,
    );
    expect(replay).toEqual(retry);
    expect(stateFingerprint(await real.repository.read(GAME_ID))).toBe(beforeReplay);
  });
});
