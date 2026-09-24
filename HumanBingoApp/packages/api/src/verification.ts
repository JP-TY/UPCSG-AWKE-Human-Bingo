import { randomUUID } from 'node:crypto';

import {
  CompletionCategory,
  DomainErrorCode,
  GameStatus,
  getCompletedLines,
  getLineIndices,
  HASHTAG_INDICES,
  HumanBingoError,
  isBlackoutComplete,
  isHashtagComplete,
  LineDirection,
  NotificationStatus,
  SquareStatus,
  VerificationRequestStatus,
  type CompletionDto,
  type CompletionKey,
  type CorrelationId,
  type GameDto,
  type GridSquareDto,
  type ParticipantIdentityDto,
  type PlayerCode,
  type ParticipantId,
  type RequestVerificationCommand,
  type RespondToVerificationCommand,
  type ListNotificationsQuery,
  type ListNotificationsResult,
  type Timestamp,
  type VerificationMutationResult,
  type VerificationRequestDto,
} from '@human-bingo/domain';
import {
  VerificationGameNotFoundError,
  type CompletionRecord,
  type GameRecord,
  type GridRecord,
  type NotificationRecord,
  type PlayerProfileRecord,
  type SquareRecord,
  type VerificationRepository,
  type VerificationState,
} from '@human-bingo/persistence';
import { faceStampIndexFor } from './chop-bag.js';

export type VerificationActor = ParticipantId | { readonly participantId: ParticipantId };

export interface VerificationPushNotifier {
  deliverVerificationRequest(input: {
    readonly gameId: GameRecord['id'];
    readonly participantId: ParticipantId;
    readonly verificationRequestId: VerificationRequestDto['id'];
    readonly gameName: string;
    readonly requestingParticipant: string;
    readonly taskText: string;
  }): Promise<unknown>;
}

export interface VerificationServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly pushNotifier?: VerificationPushNotifier;
}

interface RequestMutationOutput {
  readonly result: VerificationMutationResult;
  readonly push?: Parameters<VerificationPushNotifier['deliverVerificationRequest']>[0];
}

interface StoredCommandResult {
  readonly commandType: 'request_verification' | 'respond_to_verification';
  readonly result: VerificationMutationResult;
}

/**
 * Authoritative request/confirm/reject application service. The repository
 * callback is the transaction boundary: all validation, request history,
 * square state, notification state, completion rows, and game version changes
 * are committed together or none are committed.
 */
export class VerificationCompletionService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly pushNotifier: VerificationPushNotifier | undefined;

  public constructor(
    private readonly repository: VerificationRepository,
    options: VerificationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.pushNotifier = options.pushNotifier;
  }

  public request(
    command: RequestVerificationCommand,
    actor: VerificationActor,
  ): Promise<VerificationMutationResult> {
    const actorParticipantId = participantIdOf(actor);
    return this.repository
      .withVerificationState(command.gameId, (state) => {
        const replay = replayedResult(state, command, actorParticipantId, 'request_verification');
        if (replay !== null) return { result: replay } satisfies RequestMutationOutput;
        assertGameCanChange(state.game, command.correlationId);
        assertMember(state, command.gameId, actorParticipantId, command.correlationId);
        assertKnownVersion(state.game, command.knownStateVersion, command.correlationId);

        const grid = state.grids.find(
          (candidate) =>
            candidate.id === command.gridId &&
            candidate.gameId === command.gameId &&
            candidate.participantId === actorParticipantId,
        );
        if (grid === undefined) {
          throw commandError(
            DomainErrorCode.Forbidden,
            'The grid is not owned by the current participant.',
            command.correlationId,
            403,
          );
        }
        const square = state.squares.find(
          (candidate) =>
            candidate.gridId === grid.id && candidate.squareIndex === command.squareIndex,
        );
        if (square === undefined) {
          throw commandError(
            DomainErrorCode.NotFound,
            'The requested square was not found.',
            command.correlationId,
            404,
          );
        }
        if (
          !Number.isInteger(command.squareIndex) ||
          command.squareIndex < 0 ||
          command.squareIndex > 24
        ) {
          throw commandError(
            DomainErrorCode.ValidationError,
            'Square index must be between 0 and 24.',
            command.correlationId,
            422,
          );
        }
        if (square.status === SquareStatus.Verified) {
          throw commandError(
            DomainErrorCode.InvalidCommand,
            'A verified square cannot receive another verification request.',
            command.correlationId,
            409,
          );
        }
        const activeRequest = state.verificationRequests.find(
          (request) =>
            request.gameId === command.gameId &&
            request.gridId === grid.id &&
            request.squareIndex === command.squareIndex &&
            request.status === VerificationRequestStatus.Pending,
        );
        if (activeRequest !== undefined) {
          throw commandError(
            DomainErrorCode.RequestAlreadyPending,
            'A verification request is already pending for this square.',
            command.correlationId,
            409,
          );
        }

        const identifiedProfile = findProfileByPlayerCode(
          state,
          command.gameId,
          command.identifiedPlayerCode,
        );
        if (identifiedProfile === null) {
          throw commandError(
            DomainErrorCode.InvalidPlayerCode,
            'The Player_Code is invalid for this game.',
            command.correlationId,
            422,
          );
        }
        if (identifiedProfile.participantId === actorParticipantId) {
          throw commandError(
            DomainErrorCode.SelfVerification,
            'Self-verification is not allowed.',
            command.correlationId,
            422,
          );
        }
        const duplicateIdentified = state.verificationRequests.some(
          (request) =>
            request.gameId === command.gameId &&
            request.gridId === grid.id &&
            request.identifiedParticipantId === identifiedProfile.participantId,
        );
        if (duplicateIdentified) {
          throw commandError(
            DomainErrorCode.DuplicateIdentifiedParticipant,
            'This Player_Code was already used to verify a square on this grid.',
            command.correlationId,
            409,
          );
        }

        const now = new Date(this.now());
        const request = {
          id: this.idFactory() as VerificationRequestDto['id'],
          gameId: command.gameId,
          gridId: grid.id,
          squareIndex: command.squareIndex,
          requestingParticipantId: actorParticipantId,
          identifiedParticipantId: identifiedProfile.participantId,
          status: VerificationRequestStatus.Pending,
          createdAt: now,
          resolvedAt: null,
          outcomeActorId: null,
          clientCommandId: String(command.idempotencyKey),
        } satisfies VerificationState['verificationRequests'][number];
        state.verificationRequests.push(request);
        replaceSquare(state, square, SquareStatus.Pending, now);

        const notification: NotificationRecord = {
          id: this.idFactory() as NotificationRecord['id'],
          gameId: command.gameId,
          recipientParticipantId: identifiedProfile.participantId,
          verificationRequestId: request.id,
          kind: 'verification_request',
          status: NotificationStatus.Pending,
          createdAt: now,
          resolvedAt: null,
        };
        state.notifications.push(notification);
        const result = commitMutation(state, command.gameId, now, (nextStateVersion) =>
          this.toResult(state, request.id, [], nextStateVersion),
        );
        rememberResult(state, command, actorParticipantId, 'request_verification', result);
        const requestingProfile = profileFor(state, actorParticipantId);
        return {
          result,
          push: {
            gameId: command.gameId,
            participantId: identifiedProfile.participantId,
            verificationRequestId: request.id,
            gameName: state.game.name,
            requestingParticipant: requestingProfile.displayName ?? 'Participant',
            taskText: taskTextFor(state, square),
          },
        } satisfies RequestMutationOutput;
      })
      .then(async (output) => {
        if (output.push !== undefined && this.pushNotifier !== undefined) {
          try {
            await this.pushNotifier.deliverVerificationRequest(output.push);
          } catch {
            // Push is best effort; the durable in-app notification is authoritative.
          }
        }
        return output.result;
      })
      .catch((error: unknown) => mapNotFound(error, command.correlationId));
  }

  public confirm(
    command: RespondToVerificationCommand,
    actor: VerificationActor,
  ): Promise<VerificationMutationResult> {
    return this.respond({ ...command, decision: 'confirm' }, actor);
  }

  public reject(
    command: RespondToVerificationCommand,
    actor: VerificationActor,
  ): Promise<VerificationMutationResult> {
    return this.respond({ ...command, decision: 'reject' }, actor);
  }

  public respond(
    command: RespondToVerificationCommand,
    actor: VerificationActor,
  ): Promise<VerificationMutationResult> {
    const actorParticipantId = participantIdOf(actor);
    return this.repository
      .withVerificationState(command.gameId, (state) => {
        const replay = replayedResult(
          state,
          command,
          actorParticipantId,
          'respond_to_verification',
        );
        if (replay !== null) return replay;
        assertGameCanChange(state.game, command.correlationId);
        assertMember(state, command.gameId, actorParticipantId, command.correlationId);
        assertKnownVersion(state.game, command.knownStateVersion, command.correlationId);

        const request = state.verificationRequests.find(
          (candidate) =>
            candidate.id === command.verificationRequestId && candidate.gameId === command.gameId,
        );
        if (request === undefined) {
          throw commandError(
            DomainErrorCode.NotFound,
            'The verification request was not found.',
            command.correlationId,
            404,
          );
        }
        if (request.identifiedParticipantId !== actorParticipantId) {
          throw commandError(
            DomainErrorCode.NotIdentifiedParticipant,
            'Only the identified participant may respond to this request.',
            command.correlationId,
            403,
          );
        }
        if (request.status !== VerificationRequestStatus.Pending) {
          throw commandError(
            DomainErrorCode.InvalidCommand,
            'The verification request has already been resolved.',
            command.correlationId,
            409,
          );
        }

        const square = state.squares.find(
          (candidate) =>
            candidate.gridId === request.gridId && candidate.squareIndex === request.squareIndex,
        );
        if (square === undefined) {
          throw commandError(
            DomainErrorCode.NotFound,
            'The square for this verification request was not found.',
            command.correlationId,
            404,
          );
        }
        const now = new Date(this.now());
        const confirmed = command.decision === 'confirm';
        const stampIndex = confirmed
          ? faceStampIndexFor(
              request.gridId,
              state.squares.filter(
                (candidate) =>
                  candidate.gridId === request.gridId && candidate.status === SquareStatus.Verified,
              ).length,
            )
          : undefined;
        const updatedRequest = {
          ...request,
          status: confirmed
            ? VerificationRequestStatus.Confirmed
            : VerificationRequestStatus.Rejected,
          resolvedAt: now,
          outcomeActorId: actorParticipantId,
        } satisfies VerificationState['verificationRequests'][number];
        const requestIndex = state.verificationRequests.indexOf(request);
        state.verificationRequests[requestIndex] = updatedRequest;
        replaceSquare(
          state,
          square,
          confirmed ? SquareStatus.Verified : SquareStatus.Rejected,
          now,
          stampIndex,
        );
        resolveNotification(state, request.id, now);

        const newCompletions = confirmed
          ? this.evaluateCompletions(
              state,
              request.gridId,
              request.requestingParticipantId,
              request.squareIndex,
              now,
            )
          : [];
        const result = commitMutation(state, command.gameId, now, (nextStateVersion) =>
          this.toResult(state, request.id, newCompletions, nextStateVersion),
        );
        rememberResult(state, command, actorParticipantId, 'respond_to_verification', result);
        return result;
      })
      .catch((error: unknown) => mapNotFound(error, command.correlationId));
  }

  public execute(
    command: RequestVerificationCommand | RespondToVerificationCommand,
    actor: VerificationActor,
  ): Promise<VerificationMutationResult> {
    return 'identifiedPlayerCode' in command
      ? this.request(command, actor)
      : this.respond(command, actor);
  }

  /**
   * Lists only notifications addressed to the authenticated participant. The
   * same transaction-scoped aggregate used by mutations is used here so the
   * pending count and notification/request statuses cannot be read from
   * different versions of the game state.
   */
  public listNotifications(
    query: ListNotificationsQuery,
    actor: VerificationActor,
  ): Promise<ListNotificationsResult> {
    const actorParticipantId = participantIdOf(actor);
    return this.repository
      .withVerificationState(query.gameId, (state) => {
        assertMember(state, query.gameId, actorParticipantId, query.correlationId);

        const requestsById = new Map(
          state.verificationRequests.map((request) => [request.id, request] as const),
        );
        const isPendingAction = (notification: NotificationRecord): boolean => {
          const request = requestsById.get(notification.verificationRequestId);
          return (
            notification.status === NotificationStatus.Pending &&
            request?.status === VerificationRequestStatus.Pending
          );
        };
        const visibleNotifications = state.notifications
          .filter(
            (notification) =>
              notification.gameId === query.gameId &&
              notification.recipientParticipantId === actorParticipantId &&
              (query.includeResolved === true || isPendingAction(notification)),
          )
          .sort((left, right) => {
            const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();
            return createdAtDifference !== 0
              ? createdAtDifference
              : String(left.id).localeCompare(String(right.id));
          })
          .map((notification) => {
            const request = requestsById.get(notification.verificationRequestId);
            if (request === undefined) {
              throw new Error(`Notification ${notification.id} references a missing request`);
            }
            return this.toNotificationDto(state, notification, request);
          });

        return {
          notifications: visibleNotifications,
          pendingCount: state.notifications.filter(
            (notification) =>
              notification.gameId === query.gameId &&
              notification.recipientParticipantId === actorParticipantId &&
              isPendingAction(notification),
          ).length,
        };
      })
      .catch((error: unknown) => mapNotFound(error, query.correlationId));
  }

  private evaluateCompletions(
    state: VerificationState,
    gridId: GridRecord['id'],
    participantId: ParticipantId,
    squareIndex: number,
    completedAt: Date,
  ): CompletionDto[] {
    const squares = state.squares
      .filter((square) => square.gridId === gridId)
      .sort((left, right) => left.squareIndex - right.squareIndex);
    if (squares.length !== 25) return [];
    const statuses = squares.map((square) => square.status);
    const newlyAffectedKeys: Array<{
      readonly category: CompletionCategory;
      readonly completionKey: CompletionRecord['completionKey'];
    }> = [];
    const seenAffectedKeys = new Set<string>();
    const addAffected = (
      category: CompletionCategory,
      completionKey: CompletionRecord['completionKey'],
    ): void => {
      const identity = `${category}:${completionKey}`;
      if (seenAffectedKeys.has(identity)) return;
      seenAffectedKeys.add(identity);
      newlyAffectedKeys.push({ category, completionKey });
    };

    // A confirmation can only make completion keys containing the changed
    // square newly true. This keeps the transaction focused while preserving
    // reevaluation safety through the unique completion identity below.
    if (isBlackoutComplete(statuses)) {
      addAffected(CompletionCategory.Blackout, 'blackout');
    }
    if (isHashtagComplete(statuses) && HASHTAG_INDICES.includes(squareIndex)) {
      addAffected(CompletionCategory.Hashtag, 'hashtag');
    }
    for (const line of getCompletedLines(statuses)) {
      const completionKey = persistenceLineKey(line.direction, line.position);
      if (getLineIndices(line).includes(squareIndex)) {
        addAffected(CompletionCategory.Line, completionKey);
      }
    }

    const newRecords: CompletionRecord[] = [];
    for (const { category, completionKey } of newlyAffectedKeys) {
      const exists = state.completions.some(
        (completion) =>
          completion.gameId === state.game.id &&
          completion.participantId === participantId &&
          completion.category === category &&
          completion.completionKey === completionKey,
      );
      if (exists) continue;
      const completion: CompletionRecord = {
        id: this.idFactory() as CompletionRecord['id'],
        gameId: state.game.id,
        participantId,
        category,
        completionKey,
        completedAt,
        createdAt: completedAt,
      };
      state.completions.push(completion);
      newRecords.push(completion);
    }
    return newRecords.map((completion) => this.toCompletionDto(state, completion));
  }

  private toResult(
    state: VerificationState,
    requestId: VerificationRequestDto['id'],
    completions: readonly CompletionDto[],
    stateVersion: VerificationMutationResult['stateVersion'],
  ): VerificationMutationResult {
    const request = state.verificationRequests.find((candidate) => candidate.id === requestId);
    if (request === undefined) throw new Error(`Request ${requestId} disappeared during mutation`);
    const square = state.squares.find(
      (candidate) =>
        candidate.gridId === request.gridId && candidate.squareIndex === request.squareIndex,
    );
    if (square === undefined)
      throw new Error(`Square for request ${requestId} disappeared during mutation`);
    const requestDto = this.toRequestDto(state, request);
    return {
      request: requestDto,
      square: this.toSquareDto(state, square),
      notifications: state.notifications
        .filter((notification) => notification.verificationRequestId === request.id)
        .map((notification) => this.toNotificationDto(state, notification, request)),
      completions,
      stateVersion,
    };
  }

  private toRequestDto(
    state: VerificationState,
    request: VerificationState['verificationRequests'][number],
  ): VerificationRequestDto {
    const requesting = profileFor(state, request.requestingParticipantId);
    const identified = profileFor(state, request.identifiedParticipantId);
    const square = state.squares.find(
      (candidate) =>
        candidate.gridId === request.gridId && candidate.squareIndex === request.squareIndex,
    );
    if (square === undefined) throw new Error('Verification request references a missing square');
    return {
      id: request.id,
      gameId: request.gameId,
      gridId: request.gridId,
      squareIndex: request.squareIndex,
      taskText: taskTextFor(state, square),
      requestingParticipant: identityFor(requesting),
      identifiedParticipant: identityFor(identified),
      status: request.status,
      createdAt: timestamp(request.createdAt),
      ...(request.resolvedAt === null ? {} : { resolvedAt: timestamp(request.resolvedAt) }),
      ...(request.outcomeActorId === null ? {} : { outcomeActorId: request.outcomeActorId }),
      ...(request.status === VerificationRequestStatus.Pending
        ? {}
        : {
            decision: request.status === VerificationRequestStatus.Confirmed ? 'confirm' : 'reject',
          }),
    };
  }

  private toSquareDto(state: VerificationState, square: SquareRecord): GridSquareDto {
    return {
      gridId: square.gridId,
      squareIndex: square.squareIndex,
      row: (Math.floor(square.squareIndex / 5) + 1) as GridSquareDto['row'],
      column: ((square.squareIndex % 5) + 1) as GridSquareDto['column'],
      taskEntryId: square.taskEntryId,
      taskText: taskTextFor(state, square),
      status: square.status,
      ...(square.stampIndex === undefined ? {} : { stampIndex: square.stampIndex }),
      updatedAt: timestamp(square.updatedAt),
    };
  }

  private toCompletionDto(state: VerificationState, completion: CompletionRecord): CompletionDto {
    const profile = profileFor(state, completion.participantId);
    return {
      id: completion.id,
      gameId: completion.gameId,
      participantId: completion.participantId,
      playerCode: profile.playerCode as PlayerCode,
      category: completion.category,
      completionKey: domainCompletionKey(completion),
      completedAt: timestamp(completion.completedAt),
    };
  }

  private toNotificationDto(
    state: VerificationState,
    notification: NotificationRecord,
    request: VerificationState['verificationRequests'][number],
  ) {
    const game = toGameDto(
      state.game,
      state.tasks.filter((task) => task.removedAt === null).length,
    );
    const requesting = profileFor(state, request.requestingParticipantId);
    const square = state.squares.find(
      (candidate) =>
        candidate.gridId === request.gridId && candidate.squareIndex === request.squareIndex,
    );
    if (square === undefined) throw new Error('Notification references a missing square');
    return {
      id: notification.id,
      gameId: notification.gameId,
      recipientParticipantId: notification.recipientParticipantId,
      verificationRequestId: notification.verificationRequestId,
      kind: 'verification_request' as const,
      status: notification.status,
      gameName: game.name,
      requestingParticipant: identityFor(requesting),
      taskText: taskTextFor(state, square),
      createdAt: timestamp(notification.createdAt),
      ...(notification.resolvedAt === null
        ? {}
        : { resolvedAt: timestamp(notification.resolvedAt) }),
    };
  }
}

/** Alias matching the service name used by the product design. */
export class VerificationService extends VerificationCompletionService {}

function participantIdOf(actor: VerificationActor): ParticipantId {
  return typeof actor === 'string' ? actor : actor.participantId;
}

function assertGameCanChange(game: GameRecord, correlationId: CorrelationId): void {
  if (game.status === GameStatus.Closed) {
    throw commandError(DomainErrorCode.GameClosed, 'The game is closed.', correlationId, 409);
  }
  if (game.status !== GameStatus.Active) {
    throw commandError(
      DomainErrorCode.InvalidCommand,
      'Verification activity is available only in an active game.',
      correlationId,
      409,
    );
  }
}

function assertMember(
  state: VerificationState,
  gameId: GameRecord['id'],
  participantId: ParticipantId,
  correlationId: CorrelationId,
): void {
  const participant = state.participants.find(
    (candidate) =>
      candidate.id === participantId && candidate.gameId === gameId && candidate.leftAt === null,
  );
  const membership = state.memberships.find(
    (candidate) => candidate.participantId === participantId && candidate.gameId === gameId,
  );
  if (participant === undefined || membership === undefined) {
    throw commandError(
      DomainErrorCode.Forbidden,
      'The current participant is not a member of this game.',
      correlationId,
      403,
    );
  }
}

function assertKnownVersion(
  game: GameRecord,
  knownStateVersion: RequestVerificationCommand['knownStateVersion'],
  correlationId: CorrelationId,
): void {
  if (game.stateVersion !== BigInt(knownStateVersion)) {
    throw commandError(
      DomainErrorCode.StaleState,
      'The game state has changed; refresh and retry.',
      correlationId,
      409,
      true,
      { currentStateVersion: Number(game.stateVersion) },
    );
  }
}

function commandError(
  code: DomainErrorCode,
  message: string,
  correlationId: CorrelationId,
  httpStatus: 403 | 404 | 409 | 422,
  retryable = false,
  metadata?: Readonly<Record<string, string | number | boolean>>,
): HumanBingoError {
  return new HumanBingoError({
    code,
    message,
    correlationId,
    retryable,
    httpStatus,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function replayedResult(
  state: VerificationState,
  command: RequestVerificationCommand | RespondToVerificationCommand,
  actor: ParticipantId,
  commandType: StoredCommandResult['commandType'],
): VerificationMutationResult | null {
  const stored = state.idempotency.get(idempotencyScope(command, actor));
  if (stored === undefined) return null;
  const result = stored as StoredCommandResult;
  if (result.commandType !== commandType) {
    throw commandError(
      DomainErrorCode.InvalidCommand,
      'The idempotency key was already used for another command.',
      command.correlationId,
      409,
    );
  }
  return result.result;
}

function rememberResult(
  state: VerificationState,
  command: RequestVerificationCommand | RespondToVerificationCommand,
  actor: ParticipantId,
  commandType: StoredCommandResult['commandType'],
  result: VerificationMutationResult,
): void {
  state.idempotency.set(idempotencyScope(command, actor), {
    commandType,
    result,
  } satisfies StoredCommandResult);
}

function idempotencyScope(
  command: RequestVerificationCommand | RespondToVerificationCommand,
  actor: ParticipantId,
): string {
  return `${command.gameId}:${actor}:${String(command.idempotencyKey)}`;
}

function replaceSquare(
  state: VerificationState,
  square: SquareRecord,
  status: SquareStatus,
  updatedAt: Date,
  stampIndex?: number,
): void {
  const index = state.squares.indexOf(square);
  state.squares[index] = {
    ...square,
    status,
    updatedAt,
    ...(stampIndex === undefined ? {} : { stampIndex }),
  };
}

function resolveNotification(
  state: VerificationState,
  requestId: VerificationRequestDto['id'],
  resolvedAt: Date,
): void {
  for (let index = 0; index < state.notifications.length; index += 1) {
    const notification = state.notifications[index];
    if (
      notification?.verificationRequestId === requestId &&
      notification.status === NotificationStatus.Pending
    ) {
      state.notifications[index] = {
        ...notification,
        status: NotificationStatus.Resolved,
        resolvedAt,
      };
    }
  }
}

function findProfileByPlayerCode(
  state: VerificationState,
  gameId: GameRecord['id'],
  playerCode: PlayerCode,
): PlayerProfileRecord | null {
  const normalized = String(playerCode).trim();
  if (normalized.length === 0) return null;
  return (
    state.profiles.find(
      (profile) => profile.gameId === gameId && profile.playerCode === normalized,
    ) ?? null
  );
}

function profileFor(state: VerificationState, participantId: ParticipantId): PlayerProfileRecord {
  const profile = state.profiles.find((candidate) => candidate.participantId === participantId);
  if (profile === undefined) throw new Error(`Participant ${participantId} has no profile`);
  return profile;
}

function identityFor(profile: PlayerProfileRecord): ParticipantIdentityDto {
  return {
    participantId: profile.participantId,
    displayName: profile.displayName ?? 'Participant',
    playerCode: profile.playerCode as PlayerCode,
  };
}

function taskTextFor(state: VerificationState, square: SquareRecord): string {
  return state.tasks.find((task) => task.id === square.taskEntryId)?.displayText ?? '';
}

function timestamp(value: Date): Timestamp {
  return value.toISOString() as Timestamp;
}

function toGameDto(game: GameRecord, distinctTaskCount = 0): GameDto {
  return {
    id: game.id,
    name: game.name,
    status: game.status,
    distinctTaskCount,
    taskBagLocked: game.taskBagLockedAt !== null,
    stateVersion: Number(game.stateVersion) as GameDto['stateVersion'],
    createdAt: timestamp(game.createdAt),
    updatedAt: timestamp(game.updatedAt),
    ...(game.closedAt === null ? {} : { closedAt: timestamp(game.closedAt) }),
  };
}

function commitMutation(
  state: VerificationState,
  gameId: GameRecord['id'],
  now: Date,
  serializeResult: (
    nextStateVersion: VerificationMutationResult['stateVersion'],
  ) => VerificationMutationResult,
): VerificationMutationResult {
  const nextStateVersion = state.game.stateVersion + 1n;
  state.game = { ...state.game, stateVersion: nextStateVersion, updatedAt: now };
  for (let index = 0; index < state.grids.length; index += 1) {
    const grid = state.grids[index];
    if (grid?.gameId === gameId) state.grids[index] = { ...grid, stateVersion: nextStateVersion };
  }

  const result = serializeResult(
    Number(nextStateVersion) as VerificationMutationResult['stateVersion'],
  );
  assertCommittedVersion(state, gameId, nextStateVersion, result);
  return result;
}

function assertCommittedVersion(
  state: VerificationState,
  gameId: GameRecord['id'],
  nextStateVersion: bigint,
  result: VerificationMutationResult,
): void {
  const expectedVersion = Number(nextStateVersion) as VerificationMutationResult['stateVersion'];
  if (state.game.stateVersion !== nextStateVersion || result.stateVersion !== expectedVersion) {
    throw new Error('Verification mutation version is inconsistent with the staged game state');
  }
  const affectedGrid = state.grids.find(
    (grid) => grid.gameId === gameId && grid.stateVersion !== nextStateVersion,
  );
  if (affectedGrid !== undefined) {
    throw new Error(`Verification grid ${affectedGrid.id} has an inconsistent state version`);
  }
}

function persistenceLineKey(
  direction: LineDirection,
  position: 1 | 2 | 3 | 4 | 5 | 'top_left_to_bottom_right' | 'top_right_to_bottom_left',
): CompletionRecord['completionKey'] {
  if (direction === LineDirection.Horizontal) return `row:${position as 1 | 2 | 3 | 4 | 5}`;
  if (direction === LineDirection.Vertical) return `column:${position as 1 | 2 | 3 | 4 | 5}`;
  return position === 'top_left_to_bottom_right' ? 'diag:tlbr' : 'diag:trbl';
}

function domainCompletionKey(completion: CompletionRecord): CompletionKey {
  switch (completion.completionKey) {
    case 'blackout':
    case 'hashtag':
      return completion.completionKey;
    case 'diag:tlbr':
      return 'diagonal:top_left_to_bottom_right';
    case 'diag:trbl':
      return 'diagonal:top_right_to_bottom_left';
    default: {
      const [direction, position] = completion.completionKey.split(':');
      if (direction === 'row') return `horizontal:${position as unknown as 1 | 2 | 3 | 4 | 5}`;
      return `vertical:${position as unknown as 1 | 2 | 3 | 4 | 5}`;
    }
  }
}

function mapNotFound(error: unknown, correlationId: CorrelationId): never {
  if (error instanceof VerificationGameNotFoundError) {
    throw commandError(
      DomainErrorCode.NotFound,
      'The requested game was not found.',
      correlationId,
      404,
    );
  }
  throw error;
}
