import type {
  BlackoutLeaderboardEntryDto,
  BlackoutLeaderboardDto,
  HashtagLeaderboardEntryDto,
  HashtagLeaderboardDto,
  LeaderboardsDto,
  LineLeaderboardEntryDto,
  LineLeaderboardDto,
  ParticipantId,
  ProgressLeaderboardEntryDto,
  StateVersion,
} from '@human-bingo/domain';
import { createAlert } from './design-system.js';

type CategoryEntry = BlackoutLeaderboardEntryDto | LineLeaderboardEntryDto | HashtagLeaderboardEntryDto;
type CategoryBoard = BlackoutLeaderboardDto | LineLeaderboardDto | HashtagLeaderboardDto;

interface MergedEntry {
  readonly progress: ProgressLeaderboardEntryDto;
  readonly completion: CategoryEntry | undefined;
}

function progressMetric(key: 'blackout' | 'line' | 'hashtag', entry: ProgressLeaderboardEntryDto): number {
  if (key === 'line') return entry.bestLine ?? 0;
  if (key === 'hashtag') return entry.hashtagSquares;
  return entry.verifiedSquares;
}

/**
 * A player's in-progress metric is their verified/best-line/hashtag progress
 * toward the category maximum; the completion count only decides ranking
 * order. A player with zero completions still displays real progress (for
 * example 5/25 squares) instead of an empty 0/x.
 */
function displayMetric(key: 'blackout' | 'line' | 'hashtag', entry: MergedEntry): number {
  return progressMetric(key, entry.progress);
}

function progressMaximum(key: 'blackout' | 'line' | 'hashtag'): number {
  if (key === 'line') return 5;
  if (key === 'hashtag') return 16;
  return 25;
}

function progressUnit(key: 'blackout' | 'line' | 'hashtag'): string {
  if (key === 'line') return 'best line';
  if (key === 'hashtag') return 'hashtag squares';
  return 'squares';
}

function mergeEntries(
  key: 'blackout' | 'line' | 'hashtag',
  progressEntries: readonly ProgressLeaderboardEntryDto[],
  completions: readonly CategoryEntry[],
): MergedEntry[] {
  const completionsById = new Map<ParticipantId, CategoryEntry>();
  for (const completion of completions) {
    completionsById.set(completion.participant.participantId, completion);
  }
  return progressEntries
    .map((progress) => ({ progress, completion: completionsById.get(progress.participant.participantId) }))
    .sort((left, right) => {
      const metricDifference = displayMetric(key, right) - displayMetric(key, left);
      if (metricDifference !== 0) return metricDifference;
      const completionDifference =
        (right.completion?.completionCount ?? 0) - (left.completion?.completionCount ?? 0);
      if (completionDifference !== 0) return completionDifference;
      return comparePlayerCodes(left.progress.participant.playerCode, right.progress.participant.playerCode);
    });
}

function comparePlayerCodes(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function mergedLeaderboardEntry(document: Document, entry: MergedEntry, rank: number, key: 'blackout' | 'line' | 'hashtag'): HTMLElement {
  const item = document.createElement('li');
  item.className = 'leaderboard-entry';
  const identity = document.createElement('div');
  identity.className = 'leaderboard-entry__identity';
  const name = document.createElement('strong');
  name.textContent = `${rank}. ${entry.progress.participant.displayName}`;
  const code = document.createElement('span');
  code.className = 'muted';
  code.textContent = `Player_Code: ${entry.progress.participant.playerCode}`;
  identity.append(name, code);
  const result = document.createElement('div');
  result.className = 'leaderboard-entry__result';
  const count = document.createElement('strong');
  count.textContent = `${displayMetric(key, entry)}/${progressMaximum(key)}`;
  const countLabel = document.createElement('span');
  countLabel.className = 'muted';
  countLabel.textContent = progressUnit(key);
  result.append(count, countLabel);
  const completionCount = entry.completion?.completionCount ?? 0;
  const completions = document.createElement('span');
  completions.className = 'muted';
  completions.textContent =
    completionCount > 0
      ? `${completionCount} ${completionCount === 1 ? 'completion' : 'completions'} · First: ${new Date(String(entry.completion!.earliestCompletionAt)).toLocaleString()}`
      : 'No completions yet';
  result.append(completions);
  item.append(identity, result);
  return item;
}

function completionOnlyLeaderboardEntry(
  document: Document,
  entry: CategoryEntry,
  rank: number,
): HTMLElement {
  const item = document.createElement('li');
  item.className = 'leaderboard-entry';
  const identity = document.createElement('div');
  identity.className = 'leaderboard-entry__identity';
  const name = document.createElement('strong');
  name.textContent = `${rank}. ${entry.participant.displayName}`;
  const code = document.createElement('span');
  code.className = 'muted';
  code.textContent = `Player_Code: ${entry.participant.playerCode}`;
  identity.append(name, code);
  const result = document.createElement('div');
  result.className = 'leaderboard-entry__result';
  const count = document.createElement('strong');
  count.textContent = String(entry.completionCount);
  const countLabel = document.createElement('span');
  countLabel.textContent = entry.completionCount === 1 ? 'completion' : 'completions';
  const earliest = document.createElement('time');
  earliest.dateTime = String(entry.earliestCompletionAt);
  earliest.textContent = `First: ${new Date(String(entry.earliestCompletionAt)).toLocaleString()}`;
  result.append(count, countLabel, earliest);
  item.append(identity, result);
  return item;
}

function createLeaderboard(
  document: Document,
  label: 'Blackout' | 'Line' | 'Hashtag',
  key: 'blackout' | 'line' | 'hashtag',
  board: CategoryBoard,
  totalCompletions: number,
  progressEntries: readonly ProgressLeaderboardEntryDto[] | undefined,
  stateVersion: StateVersion,
): HTMLElement {
  const section = document.createElement('section');
  section.className = `card stack leaderboard leaderboard--${key}`;
  section.dataset.leaderboard = key;
  section.dataset.stateVersion = String(stateVersion);
  section.setAttribute('aria-labelledby', `${key}-leaderboard-heading`);
  const heading = document.createElement('h2');
  heading.id = `${key}-leaderboard-heading`;
  heading.textContent = label;
  const totalElement = document.createElement('p');
  totalElement.className = 'leaderboard-total';
  totalElement.textContent = `${totalCompletions} total ${label === 'Line' ? 'line completions' : `${key} completions`}`;
  section.append(heading, totalElement);
  if (progressEntries !== undefined && progressEntries.length > 0) {
    const entries = mergeEntries(key, progressEntries, board.entries);
    if (entries.length === 0) {
      section.append(
        createAlert(document, {
          message: `No ${key} progress yet. Every player is ranked here once they join.`,
          tone: 'info',
        }),
      );
      return section;
    }
    const list = document.createElement('ol');
    list.className = 'leaderboard-list';
    list.setAttribute('aria-label', `${label} leaderboard entries`);
    entries.forEach((entry, index) => list.append(mergedLeaderboardEntry(document, entry, index + 1, key)));
    section.append(list);
    return section;
  }
  if (board.entries.length === 0) {
    section.append(
      createAlert(document, {
        message: `No ${key} completions yet. This leaderboard will update when a qualifying completion is recorded.`,
        tone: 'info',
      }),
    );
    return section;
  }
  const list = document.createElement('ol');
  list.className = 'leaderboard-list';
  list.setAttribute('aria-label', `${label} leaderboard entries`);
  board.entries.forEach((entry, index) => list.append(completionOnlyLeaderboardEntry(document, entry, index + 1)));
  section.append(list);
  return section;
}

/** Game-wide standings for host and member views. */
export function createLeaderboardsSection(
  document: Document,
  leaderboards: LeaderboardsDto,
  stateVersion: StateVersion,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'stack leaderboards';
  section.setAttribute('aria-labelledby', 'leaderboards-heading');
  const heading = document.createElement('h2');
  heading.id = 'leaderboards-heading';
  heading.textContent = 'Leaderboards';
  const description = document.createElement('p');
  description.className = 'muted';
  description.textContent =
    'Blackout, Line, and Hashtag rank every player by verified progress toward each milestone.';
  const progressEntries = leaderboards.progress?.entries;
  const lineTotal = leaderboards.line.entries.reduce(
    (total, entry) => total + entry.completionCount,
    0,
  );
  section.append(
    heading,
    description,
    createLeaderboard(
      document,
      'Blackout',
      'blackout',
      leaderboards.blackout,
      leaderboards.blackout.totalCompletions,
      progressEntries,
      stateVersion,
    ),
    createLeaderboard(
      document,
      'Line',
      'line',
      leaderboards.line,
      lineTotal,
      progressEntries,
      stateVersion,
    ),
    createLeaderboard(
      document,
      'Hashtag',
      'hashtag',
      leaderboards.hashtag,
      leaderboards.hashtag.totalCompletions,
      progressEntries,
      stateVersion,
    ),
  );
  return section;
}