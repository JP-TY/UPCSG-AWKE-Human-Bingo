import {
  HASHTAG_INDICES,
  LINE_POSITIONS,
  SquareStatus,
  getCompletedLines,
  getLineIndices,
  type CorrelationId,
  type GameId,
  type HostOverviewDto,
  type HostParticipantProgressDto,
  type ParticipantIdentityDto,
  type PlayerCode,
  type StateVersion,
  type Timestamp,
} from '@human-bingo/domain';
import type {
  GridRecord,
  ParticipantRecord,
  PlayerProfileRecord,
  VerificationRepository,
  VerificationState,
} from '@human-bingo/persistence';
import { projectLeaderboards } from './leaderboards.js';
import type { HostOverviewHttpService } from './http.js';

export interface HostOverviewQuery {
  readonly gameId: GameId;
  readonly correlationId: CorrelationId;
}

/**
 * Host-scoped authoritative overview. It reads the same transaction-backed
 * state used by verification commands and returns active participants with
 * per-participant progress plus game-wide standings. It never exposes the
 * member-scoped requests or notifications carried by member snapshots.
 */
export class SqlHostOverviewReader implements HostOverviewHttpService {
  public constructor(private readonly repository: VerificationRepository) {}

  public read(query: HostOverviewQuery): Promise<HostOverviewDto> {
    return this.repository.read === undefined
      ? this.repository.withVerificationState(query.gameId, (state) => overviewForHost(state))
      : this.repository.read(query.gameId).then(overviewForHost);
  }
}

/**
 * Pure projection of the host overview from a verification state. Exported
 * separately so deterministic unit tests can exercise qualification rules
 * without a repository.
 */
export function overviewForHost(
  state: Pick<
    VerificationState,
    'game' | 'memberships' | 'participants' | 'profiles' | 'grids' | 'squares' | 'completions'
  >,
): HostOverviewDto {
  const gameId = state.game.id;
  const participants = activeParticipants(state)
    .map((participant) => progressFor(state, participant))
    .sort(compareProgress);
  return {
    gameId,
    participants,
    leaderboards: {
      ...projectLeaderboards(state),
      progress: {
        category: 'progress',
        entries: participants.map(
          ({ participant, verifiedSquares, qualifiedLines, hashtagSquares, bestLine }) => ({
            participant,
            verifiedSquares,
            qualifiedLines,
            hashtagSquares,
            bestLine,
          }),
        ),
      },
    },
    stateVersion: Number(state.game.stateVersion) as StateVersion,
  };
}

const activeParticipants = (
  state: Pick<VerificationState, 'game' | 'memberships' | 'participants'>,
): readonly ParticipantRecord[] => {
  const participantIds = new Set(
    state.memberships
      .filter((membership) => membership.gameId === state.game.id)
      .map((membership) => membership.participantId),
  );
  return state.participants.filter(
    (participant) =>
      participant.gameId === state.game.id &&
      participant.leftAt === null &&
      participantIds.has(participant.id),
  );
};

const progressFor = (
  state: Pick<VerificationState, 'game' | 'memberships' | 'profiles' | 'grids' | 'squares'>,
  participant: ParticipantRecord,
): HostParticipantProgressDto => {
  const profile = state.profiles.find(
    (candidate) => candidate.participantId === participant.id,
  );
  const membership = state.memberships.find(
    (candidate) =>
      candidate.gameId === state.game.id && candidate.participantId === participant.id,
  );
  const grid = state.grids.find(
    (candidate) =>
      candidate.gameId === state.game.id && candidate.participantId === participant.id,
  );
  const statuses = statusesFor(state, grid);
  const verifiedSquares = statuses.filter((status) => status === SquareStatus.Verified).length;
  return {
    participant: identityFor(profile, participant),
    verifiedSquares,
    qualifiedLines: getCompletedLines(statuses).length,
    hashtagSquares: HASHTAG_INDICES.filter((index) => statuses[index] === SquareStatus.Verified)
      .length,
    bestLine: LINE_POSITIONS.reduce(
      (best, line) =>
        Math.max(
          best,
          getLineIndices(line).filter((index) => statuses[index] === SquareStatus.Verified).length,
        ),
      0,
    ),
    joinedAt: timestamp(participant.createdAt),
    ...(membership === undefined ? {} : { lastSeenAt: timestamp(membership.lastSeenAt) }),
  };
};

const statusesFor = (
  state: Pick<VerificationState, 'squares'>,
  grid: GridRecord | undefined,
): SquareStatus[] => {
  const rows = new Map<number, SquareStatus>();
  if (grid === undefined)
    return Array.from({ length: 25 }, () => SquareStatus.Unverified);
  for (const square of state.squares) {
    if (square.gridId !== grid.id) continue;
    rows.set(square.squareIndex, square.status);
  }
  return Array.from({ length: 25 }, (_, squareIndex) => rows.get(squareIndex) ?? SquareStatus.Unverified);
};

const identityFor = (
  profile: PlayerProfileRecord | undefined,
  participant: ParticipantRecord,
): ParticipantIdentityDto =>
  profile === undefined
    ? {
        participantId: participant.id,
        displayName: participant.id,
        playerCode: '' as PlayerCode,
      }
    : {
        participantId: profile.participantId,
        displayName: profile.displayName ?? profile.participantId,
        playerCode: profile.playerCode as PlayerCode,
      };

const compareProgress = (
  left: HostParticipantProgressDto,
  right: HostParticipantProgressDto,
): number => {
  const squareDifference = right.verifiedSquares - left.verifiedSquares;
  if (squareDifference !== 0) return squareDifference;
  const lineDifference = right.qualifiedLines - left.qualifiedLines;
  if (lineDifference !== 0) return lineDifference;
  const leftCode = left.participant.playerCode;
  const rightCode = right.participant.playerCode;
  if (leftCode < rightCode) return -1;
  if (leftCode > rightCode) return 1;
  return 0;
};

const timestamp = (value: Date): Timestamp => value.toISOString() as Timestamp;
