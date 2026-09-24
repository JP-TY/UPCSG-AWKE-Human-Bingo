import {
  CompletionCategory,
  DomainErrorCode,
  HASHTAG_INDICES,
  HumanBingoError,
  LINE_POSITIONS,
  SquareStatus,
  getCompletedLines,
  getLineIndices,
  type BlackoutLeaderboardDto,
  type BlackoutLeaderboardEntryDto,
  type CompletionDto,
  type GetLeaderboardsQuery,
  type GetLeaderboardsResult,
  type HashtagLeaderboardDto,
  type HashtagLeaderboardEntryDto,
  type LeaderboardsDto,
  type LineLeaderboardDto,
  type LineLeaderboardEntryDto,
  type ParticipantId,
  type PlayerCode,
  type ProgressLeaderboardDto,
  type ProgressLeaderboardEntryDto,
  type Timestamp,
} from '@human-bingo/domain';
import {
  type CompletionRecord,
  type PlayerProfileRecord,
  type VerificationRepository,
  type VerificationState,
} from '@human-bingo/persistence';

interface ProjectionCompletion {
  readonly record: CompletionRecord;
  readonly dto: CompletionDto;
  readonly profile: PlayerProfileRecord;
}

interface LeaderboardGroup {
  readonly profile: PlayerProfileRecord;
  readonly completions: ProjectionCompletion[];
}

/**
 * Builds all three category-specific leaderboard DTOs from authoritative
 * completion rows. Completion rows are deduplicated by their database identity
 * (game, participant, category, and completion key) before counts are derived,
 * so a repeated delivery cannot inflate a leaderboard.
 */
export function projectLeaderboards(
  state: Pick<VerificationState, 'game' | 'completions' | 'profiles'>,
): LeaderboardsDto {
  const completions = uniqueCompletionsForGame(state.game.id, state.completions, state.profiles);
  const blackout = groupsFor(completions, CompletionCategory.Blackout);
  const line = groupsFor(completions, CompletionCategory.Line);
  const hashtag = groupsFor(completions, CompletionCategory.Hashtag);

  return {
    blackout: toBlackoutLeaderboard(blackout),
    line: toLineLeaderboard(line),
    hashtag: toHashtagLeaderboard(hashtag),
  };
}

/**
 * Ranks every active participant by board progress, not only completed
 * milestones. Verified squares are the primary signal, followed by completed
 * lines and hashtag coverage for deterministic tie-breaking.
 */
export function projectProgressLeaderboard(
  state: Pick<
    VerificationState,
    'game' | 'memberships' | 'participants' | 'profiles' | 'grids' | 'squares'
  >,
): ProgressLeaderboardDto {
  const profilesByParticipant = new Map(
    state.profiles.map((profile) => [profile.participantId, profile]),
  );
  const activeParticipantIds = new Set(
    state.memberships
      .filter((membership) => membership.gameId === state.game.id)
      .map((membership) => membership.participantId),
  );
  const squaresByGrid = new Map<string, Map<number, SquareStatus>>();
  for (const square of state.squares) {
    const squares = squaresByGrid.get(String(square.gridId)) ?? new Map<number, SquareStatus>();
    squares.set(square.squareIndex, square.status);
    squaresByGrid.set(String(square.gridId), squares);
  }
  const entries = state.participants
    .filter(
      (participant) =>
        participant.gameId === state.game.id &&
        participant.leftAt === null &&
        activeParticipantIds.has(participant.id),
    )
    .map((participant): ProgressLeaderboardEntryDto => {
      const profile = profilesByParticipant.get(participant.id);
      const grid = state.grids.find(
        (candidate) =>
          candidate.gameId === state.game.id && candidate.participantId === participant.id,
      );
      const squares = grid === undefined ? undefined : squaresByGrid.get(String(grid.id));
      const statuses = Array.from(
        { length: 25 },
        (_, squareIndex) => squares?.get(squareIndex) ?? SquareStatus.Unverified,
      );
      return {
        participant:
          profile === undefined
            ? {
                participantId: participant.id,
                displayName: participant.id,
                playerCode: '' as PlayerCode,
              }
            : identityFor(profile),
        verifiedSquares: statuses.filter((status) => status === SquareStatus.Verified).length,
        qualifiedLines: getCompletedLines(statuses).length,
        hashtagSquares: HASHTAG_INDICES.filter(
          (index) => statuses[index] === SquareStatus.Verified,
        ).length,
        bestLine: bestLineProgress(statuses),
      };
    })
    .sort(compareProgressEntries);

  return { category: 'progress', entries };
}

/**
 * Member-scoped authoritative leaderboard query. It reads from the same
 * transaction-backed state used by verification commands and never exposes
 * completions for another game or an unknown participant profile.
 */
export class LeaderboardQueryService {
  public constructor(private readonly repository: VerificationRepository) {}

  public getLeaderboards(
    query: GetLeaderboardsQuery,
    actorParticipantId: ParticipantId,
  ): Promise<GetLeaderboardsResult> {
    const readState = this.repository.read === undefined
      ? this.repository.withVerificationState(query.gameId, (state) => state)
      : this.repository.read(query.gameId);
    return readState.then((state) => {
      const isMember =
        state.participants.some(
          (participant) =>
            participant.id === actorParticipantId &&
            participant.gameId === query.gameId &&
            participant.leftAt === null,
        ) &&
        state.memberships.some(
          (membership) =>
            membership.gameId === query.gameId && membership.participantId === actorParticipantId,
        );
      if (!isMember) {
        throw new HumanBingoError({
          code: DomainErrorCode.Forbidden,
          message: 'The current participant is not a member of this game.',
          correlationId: query.correlationId,
          retryable: false,
          httpStatus: 403,
        });
      }

      return {
        leaderboards: {
          ...projectLeaderboards(state),
          progress: projectProgressLeaderboard(state),
        },
        stateVersion: Number(state.game.stateVersion) as GetLeaderboardsResult['stateVersion'],
      };
    });
  }

  /** Alias used by query adapters that name reads explicitly. */
  public read(
    query: GetLeaderboardsQuery,
    actorParticipantId: ParticipantId,
  ): Promise<GetLeaderboardsResult> {
    return this.getLeaderboards(query, actorParticipantId);
  }
}

function uniqueCompletionsForGame(
  gameId: VerificationState['game']['id'],
  records: readonly CompletionRecord[],
  profiles: readonly PlayerProfileRecord[],
): ProjectionCompletion[] {
  const unique = new Map<string, ProjectionCompletion>();
  for (const record of records) {
    if (record.gameId !== gameId) continue;
    const profile = profiles.find(
      (candidate) =>
        candidate.gameId === gameId && candidate.participantId === record.participantId,
    );
    if (profile === undefined) continue;
    const completionKey = toDomainCompletionKey(record);
    if (completionKey === null || !isCategoryKeyPair(record.category, completionKey)) continue;

    const projection: ProjectionCompletion = {
      record,
      profile,
      dto: {
        id: record.id,
        gameId: record.gameId,
        participantId: record.participantId,
        playerCode: profile.playerCode as PlayerCode,
        category: record.category,
        completionKey,
        completedAt: record.completedAt.toISOString() as Timestamp,
      },
    };
    const identity = `${record.participantId}:${record.category}:${record.completionKey}`;
    const previous = unique.get(identity);
    if (previous === undefined || compareCompletion(projection, previous) < 0) {
      unique.set(identity, projection);
    }
  }
  return [...unique.values()];
}

function groupsFor(
  completions: readonly ProjectionCompletion[],
  category: CompletionCategory,
): LeaderboardGroup[] {
  const groups = new Map<ParticipantId, LeaderboardGroup>();
  for (const completion of completions) {
    if (completion.record.category !== category) continue;
    const existing = groups.get(completion.record.participantId);
    if (existing === undefined) {
      groups.set(completion.record.participantId, {
        profile: completion.profile,
        completions: [completion],
      });
    } else {
      existing.completions.push(completion);
    }
  }
  return [...groups.values()].sort(compareGroups);
}

function toBlackoutLeaderboard(groups: readonly LeaderboardGroup[]): BlackoutLeaderboardDto {
  const entries: BlackoutLeaderboardEntryDto[] = groups.map((group) => ({
    participant: identityFor(group.profile),
    completionCount: group.completions.length,
    earliestCompletionAt: earliestTimestamp(group.completions),
    completions: completionDtos(group.completions),
  }));
  return {
    category: CompletionCategory.Blackout,
    totalCompletions: entries.reduce((total, entry) => total + entry.completionCount, 0),
    entries,
  };
}

function toLineLeaderboard(groups: readonly LeaderboardGroup[]): LineLeaderboardDto {
  return {
    category: CompletionCategory.Line,
    entries: groups.map(
      (group): LineLeaderboardEntryDto => ({
        participant: identityFor(group.profile),
        completionCount: group.completions.length,
        earliestCompletionAt: earliestTimestamp(group.completions),
        completions: completionDtos(group.completions),
      }),
    ),
  };
}

function toHashtagLeaderboard(groups: readonly LeaderboardGroup[]): HashtagLeaderboardDto {
  const entries: HashtagLeaderboardEntryDto[] = groups.map((group) => ({
    participant: identityFor(group.profile),
    completionCount: group.completions.length,
    earliestCompletionAt: earliestTimestamp(group.completions),
    completions: completionDtos(group.completions),
  }));
  return {
    category: CompletionCategory.Hashtag,
    totalCompletions: entries.reduce((total, entry) => total + entry.completionCount, 0),
    entries,
  };
}

function completionDtos(completions: readonly ProjectionCompletion[]): readonly CompletionDto[] {
  return [...completions].sort(compareCompletion).map((completion) => completion.dto);
}

function compareGroups(left: LeaderboardGroup, right: LeaderboardGroup): number {
  const countDifference = right.completions.length - left.completions.length;
  if (countDifference !== 0) return countDifference;
  const timestampDifference =
    earliestCompletion(left).record.completedAt.getTime() -
    earliestCompletion(right).record.completedAt.getTime();
  if (timestampDifference !== 0) return timestampDifference;
  return comparePlayerCodes(left.profile.playerCode, right.profile.playerCode);
}

function earliestCompletion(group: LeaderboardGroup): ProjectionCompletion {
  return group.completions.reduce(
    (earliest, completion) => (compareCompletion(completion, earliest) < 0 ? completion : earliest),
    group.completions[0]!,
  );
}

function compareCompletion(left: ProjectionCompletion, right: ProjectionCompletion): number {
  const timestampDifference =
    left.record.completedAt.getTime() - right.record.completedAt.getTime();
  if (timestampDifference !== 0) return timestampDifference;
  const keyDifference = left.record.completionKey.localeCompare(right.record.completionKey);
  if (keyDifference !== 0) return keyDifference;
  return String(left.record.id).localeCompare(String(right.record.id));
}

function comparePlayerCodes(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Longest single row, column, or diagonal with verified squares, used as the
 * Line leaderboard progress signal before any line is completed.
 */
function bestLineProgress(statuses: readonly SquareStatus[]): number {
  return LINE_POSITIONS.reduce(
    (best, line) =>
      Math.max(
        best,
        getLineIndices(line).filter((index) => statuses[index] === SquareStatus.Verified).length,
      ),
    0,
  );
}

function compareProgressEntries(
  left: ProgressLeaderboardEntryDto,
  right: ProgressLeaderboardEntryDto,
): number {
  const verifiedDifference = right.verifiedSquares - left.verifiedSquares;
  if (verifiedDifference !== 0) return verifiedDifference;
  const lineDifference = right.qualifiedLines - left.qualifiedLines;
  if (lineDifference !== 0) return lineDifference;
  const hashtagDifference = right.hashtagSquares - left.hashtagSquares;
  if (hashtagDifference !== 0) return hashtagDifference;
  return comparePlayerCodes(left.participant.playerCode, right.participant.playerCode);
}

function earliestTimestamp(completions: readonly ProjectionCompletion[]): Timestamp {
  return completions
    .reduce(
      (earliest, completion) =>
        completion.record.completedAt.getTime() < earliest.getTime()
          ? completion.record.completedAt
          : earliest,
      completions[0]!.record.completedAt,
    )
    .toISOString() as Timestamp;
}

function identityFor(profile: PlayerProfileRecord) {
  return {
    participantId: profile.participantId,
    displayName: profile.displayName ?? 'Participant',
    playerCode: profile.playerCode as PlayerCode,
  };
}

function toDomainCompletionKey(record: CompletionRecord): CompletionDto['completionKey'] | null {
  switch (record.completionKey) {
    case 'blackout':
    case 'hashtag':
      return record.completionKey;
    case 'diag:tlbr':
      return 'diagonal:top_left_to_bottom_right';
    case 'diag:trbl':
      return 'diagonal:top_right_to_bottom_left';
    default: {
      const [direction, position] = record.completionKey.split(':');
      if (!['1', '2', '3', '4', '5'].includes(position ?? '')) return null;
      if (direction === 'row') return `horizontal:${position}` as CompletionDto['completionKey'];
      if (direction === 'column') return `vertical:${position}` as CompletionDto['completionKey'];
      return null;
    }
  }
}

function isCategoryKeyPair(
  category: CompletionCategory,
  completionKey: CompletionDto['completionKey'],
): boolean {
  if (category === CompletionCategory.Blackout) return completionKey === 'blackout';
  if (category === CompletionCategory.Hashtag) return completionKey === 'hashtag';
  return (
    completionKey.startsWith('horizontal:') ||
    completionKey.startsWith('vertical:') ||
    completionKey.startsWith('diagonal:')
  );
}
