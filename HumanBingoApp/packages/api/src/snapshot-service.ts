import {
  DomainErrorCode,
  HumanBingoError,
  VerificationRequestStatus,
  type CorrelationId,
  type GameDto,
  type GameSnapshotDto,
  type GetGameSnapshotQuery,
  type GetGameSnapshotResult,
  type GridDto,
  type GridSquareDto,
  type MembershipDto,
  type NotificationDto,
  type ParticipantDto,
  type ParticipantIdentityDto,
  type PlayerCode,
  type PlayerProfileDto,
  type StateVersion,
  type TaskEntryDto,
  type Timestamp,
  type VerificationRequestDto,
} from '@human-bingo/domain';
import type {
  GameRecord,
  MembershipRecord,
  NotificationRecord,
  ParticipantRecord,
  PlayerProfileRecord,
  SquareRecord,
  TaskEntryRecord,
  VerificationRepository,
  VerificationState,
} from '@human-bingo/persistence';
import type { MemberAuthorization } from './access/authorization.js';
import type { SnapshotHttpService } from './http.js';
import { projectLeaderboards, projectProgressLeaderboard } from './leaderboards.js';

/**
 * SQL-backed member snapshot reader. It reads the authoritative game state in
 * one transaction and returns only the current member's grid, requests, and
 * notifications, plus game-level leaderboards. The same transaction boundary
 * used by verification mutations guarantees the snapshot cannot observe a
 * half-committed mutation.
 */
export class SqlSnapshotReader implements SnapshotHttpService {
  public constructor(private readonly repository: VerificationRepository) {}

  public async read(
    query: GetGameSnapshotQuery,
    authorization: MemberAuthorization,
  ): Promise<GetGameSnapshotResult> {
    const state =
      this.repository.read === undefined
        ? await this.repository.withVerificationState(query.gameId, (state) => state)
        : await this.repository.read(query.gameId);
    return { snapshot: snapshotForMember(state, authorization, query.correlationId) };
  }
}

const snapshotForMember = (
  state: VerificationState,
  authorization: MemberAuthorization,
  correlationId: CorrelationId,
): GameSnapshotDto => {
  const game = state.game;
  const membership = state.memberships.find(
    (candidate) => candidate.id === authorization.membership.id,
  );
  if (membership === undefined) throw gameNotFound(correlationId);
  const participant = state.participants.find(
    (candidate) => candidate.id === membership.participantId,
  );
  if (participant === undefined) throw gameNotFound(correlationId);
  const profile = state.profiles.find(
    (candidate) => candidate.participantId === membership.participantId,
  );
  if (profile === undefined) throw gameNotFound(correlationId);
  const grid = state.grids.find(
    (candidate) =>
      candidate.gameId === game.id && candidate.participantId === membership.participantId,
  );
  if (grid === undefined) throw gameNotFound(correlationId);

  const participantId = membership.participantId;
  const tasks = state.tasks.filter((task) => task.removedAt === null);
  const squares = state.squares.filter((square) => square.gridId === grid.id);
  const requests = state.verificationRequests
    .filter(
      (request) =>
        request.gameId === game.id &&
        (request.requestingParticipantId === participantId ||
          request.identifiedParticipantId === participantId),
    )
    .map((request) => toRequestDto(state, request, tasks));
  const notifications = state.notifications
    .filter(
      (notification) =>
        notification.gameId === game.id && notification.recipientParticipantId === participantId,
    )
    .map((notification) => toNotificationDto(state, notification));

  return {
    game: toGameDto(game, tasks.length),
    tasks: tasks.map(toTaskDto),
    membership: toMembershipDto(membership),
    participant: toParticipantDto(participant, profile),
    profile: toProfileDto(profile),
    grid: toGridDto(grid, squares, tasks),
    verificationRequests: requests,
    notifications,
    leaderboards: {
      ...projectLeaderboards(state),
      progress: projectProgressLeaderboard(state),
    },
    stateVersion: version(game.stateVersion),
  };
};

const gameNotFound = (correlationId: CorrelationId): HumanBingoError =>
  new HumanBingoError({
    code: DomainErrorCode.NotFound,
    message: 'The game was not found or membership is invalid.',
    correlationId,
    retryable: false,
    httpStatus: 404,
  });

const timestamp = (value: Date): Timestamp => value.toISOString() as Timestamp;

const version = (value: bigint): StateVersion => Number(value) as StateVersion;

const toGameDto = (game: GameRecord, distinctTaskCount: number): GameDto => ({
  id: game.id,
  name: game.name,
  status: game.status,
  distinctTaskCount,
  taskBagLocked: game.taskBagLockedAt !== null,
  stateVersion: version(game.stateVersion),
  createdAt: timestamp(game.createdAt),
  updatedAt: timestamp(game.updatedAt),
  ...(game.closedAt === null ? {} : { closedAt: timestamp(game.closedAt) }),
});

const toTaskDto = (task: TaskEntryRecord): TaskEntryDto => ({
  id: task.id,
  text: task.displayText,
  createdAt: timestamp(task.createdAt),
  updatedAt: timestamp(task.updatedAt),
});

const toMembershipDto = (membership: MembershipRecord): MembershipDto => ({
  id: membership.id,
  gameId: membership.gameId,
  participantId: membership.participantId,
  createdAt: timestamp(membership.createdAt),
  lastSeenAt: timestamp(membership.lastSeenAt),
});

const toParticipantDto = (
  participant: ParticipantRecord,
  profile: PlayerProfileRecord,
): ParticipantDto => ({
  id: participant.id,
  displayName: profile.displayName ?? participant.id,
  joinedAt: timestamp(participant.createdAt),
});

const toProfileDto = (profile: PlayerProfileRecord): PlayerProfileDto => ({
  id: profile.id,
  participantId: profile.participantId,
  displayName: profile.displayName ?? '',
  playerCode: profile.playerCode as PlayerCode,
  createdAt: timestamp(profile.createdAt),
});

const toGridDto = (
  grid: VerificationState['grids'][number],
  squares: readonly SquareRecord[],
  tasks: readonly TaskEntryRecord[],
): GridDto => ({
  id: grid.id,
  gameId: grid.gameId,
  participantId: grid.participantId,
  squares: squares.map((square) => toSquareDto(square, tasks)),
  taskBagVersion: version(grid.taskBagVersion),
  stateVersion: version(grid.stateVersion),
  createdAt: timestamp(grid.createdAt),
});

const toSquareDto = (square: SquareRecord, tasks: readonly TaskEntryRecord[]): GridSquareDto => ({
  gridId: square.gridId,
  squareIndex: square.squareIndex,
  row: (Math.floor(square.squareIndex / 5) + 1) as GridSquareDto['row'],
  column: ((square.squareIndex % 5) + 1) as GridSquareDto['column'],
  taskEntryId: square.taskEntryId,
  taskText: taskTextFor(tasks, square),
  status: square.status,
  ...(square.stampIndex === undefined ? {} : { stampIndex: square.stampIndex }),
  updatedAt: timestamp(square.updatedAt),
});

const toRequestDto = (
  state: VerificationState,
  request: VerificationState['verificationRequests'][number],
  tasks: readonly TaskEntryRecord[],
): VerificationRequestDto => {
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
    taskText: taskTextFor(tasks, square),
    requestingParticipant: identityFor(state, request.requestingParticipantId),
    identifiedParticipant: identityFor(state, request.identifiedParticipantId),
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
};

const toNotificationDto = (
  state: VerificationState,
  notification: NotificationRecord,
): NotificationDto => {
  const request = state.verificationRequests.find(
    (candidate) => candidate.id === notification.verificationRequestId,
  );
  if (request === undefined) throw new Error('Notification references a missing request');
  const square = state.squares.find(
    (candidate) =>
      candidate.gridId === request.gridId && candidate.squareIndex === request.squareIndex,
  );
  if (square === undefined) throw new Error('Notification references a missing square');
  const task = state.tasks.find((candidate) => candidate.id === square.taskEntryId);
  return {
    id: notification.id,
    gameId: notification.gameId,
    recipientParticipantId: notification.recipientParticipantId,
    verificationRequestId: notification.verificationRequestId,
    kind: 'verification_request',
    status: notification.status,
    gameName: state.game.name,
    requestingParticipant: identityFor(state, request.requestingParticipantId),
    taskText: task?.displayText ?? '',
    createdAt: timestamp(notification.createdAt),
    ...(notification.resolvedAt === null ? {} : { resolvedAt: timestamp(notification.resolvedAt) }),
  };
};

const identityFor = (state: VerificationState, participantId: string): ParticipantIdentityDto => {
  const profile = state.profiles.find((candidate) => candidate.participantId === participantId);
  if (profile === undefined) {
    const participant = state.participants.find((candidate) => candidate.id === participantId);
    if (participant === undefined) throw new Error('Identity references a missing participant');
    return {
      participantId: participant.id,
      displayName: participant.id,
      playerCode: '' as PlayerCode,
    };
  }
  return {
    participantId: profile.participantId,
    displayName: profile.displayName ?? profile.participantId,
    playerCode: profile.playerCode as PlayerCode,
  };
};

const taskTextFor = (tasks: readonly TaskEntryRecord[], square: SquareRecord): string =>
  tasks.find((task) => task.id === square.taskEntryId)?.displayText ?? '';
