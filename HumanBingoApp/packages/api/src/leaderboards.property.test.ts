import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CompletionCategory,
  GameStatus,
  type CompletionId,
  type GameId,
  type ParticipantId,
} from '@human-bingo/domain';
import {
  emptyVerificationState,
  type CompletionRecord,
  type GameRecord,
  type PlayerProfileRecord,
  type CompletionKey,
} from '@human-bingo/persistence';
import { readPropertyTestOptions } from '@human-bingo/test-utils';

import { projectLeaderboards } from './leaderboards.js';

type LineCompletionKey = Exclude<CompletionKey, 'blackout' | 'hashtag'>;

const GAME_ID = 'property-12-game' as GameId;
const OTHER_GAME_ID = 'property-12-other-game' as GameId;
const BASE_TIME = Date.parse('2025-01-01T00:00:00.000Z');
const PLAYER_CODES = [
  'ALPHA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
  'GOLF',
  'HOTEL',
] as const;
const LINE_KEYS: readonly LineCompletionKey[] = [
  'row:1',
  'row:2',
  'row:3',
  'row:4',
  'row:5',
  'column:1',
  'column:2',
  'column:3',
  'column:4',
  'column:5',
  'diag:tlbr',
  'diag:trbl',
];
const CATEGORIES = [
  CompletionCategory.Blackout,
  CompletionCategory.Line,
  CompletionCategory.Hashtag,
] as const;
type Category = (typeof CATEGORIES)[number];

interface ParticipantScenario {
  readonly playerCode: (typeof PLAYER_CODES)[number];
  readonly blackout: boolean;
  readonly hashtag: boolean;
  readonly lineCount: number;
  readonly baseSecond: number;
}

interface LeaderboardScenario {
  readonly participants: readonly ParticipantScenario[];
  readonly emptyCategory: Category | null;
}

const participantScenarioArbitrary: fc.Arbitrary<ParticipantScenario[]> = fc.uniqueArray(
  fc.record({
    playerCode: fc.constantFrom(...PLAYER_CODES),
    blackout: fc.boolean(),
    hashtag: fc.boolean(),
    // Every populated Line entry has multiple distinct Lines in the generated dataset.
    lineCount: fc.integer({ min: 2, max: LINE_KEYS.length }),
    // Equal values are intentional: they exercise the Player_Code tie-breaker.
    baseSecond: fc.integer({ min: 0, max: 20 }),
  }),
  {
    minLength: 0,
    maxLength: PLAYER_CODES.length,
    selector: (participant) => participant.playerCode,
  },
);

const leaderboardScenarioArbitrary: fc.Arbitrary<LeaderboardScenario> = fc.record({
  participants: participantScenarioArbitrary,
  emptyCategory: fc.oneof(fc.constant(null), fc.constantFrom(...CATEGORIES)),
});

const game: GameRecord = {
  id: GAME_ID,
  hostAccountId: 'property-12-host',
  name: 'Property 12 Bingo',
  status: GameStatus.Active,
  taskBagLockedAt: new Date(BASE_TIME),
  closedAt: null,
  stateVersion: 1n,
  createdAt: new Date(BASE_TIME),
  updatedAt: new Date(BASE_TIME),
};

const timestampAt = (second: number): Date => new Date(BASE_TIME + second * 1000);
const participantIdFor = (playerCode: string): ParticipantId =>
  `property-12-${playerCode.toLowerCase()}` as ParticipantId;

function completion(
  id: string,
  participantId: ParticipantId,
  category: CompletionCategory,
  completionKey: unknown,
  completedAt: Date,
  gameId: GameId = GAME_ID,
): CompletionRecord {
  return {
    id: id as CompletionId,
    gameId,
    participantId,
    category,
    completionKey: completionKey as CompletionRecord['completionKey'],
    completedAt,
    createdAt: completedAt,
  };
}

function recordsFor(
  participant: ParticipantScenario,
  emptyCategory: Category | null,
): CompletionRecord[] {
  const participantId = participantIdFor(participant.playerCode);
  const records: CompletionRecord[] = [];
  const categoryIsEnabled = (category: Category): boolean => emptyCategory !== category;

  if (participant.blackout && categoryIsEnabled(CompletionCategory.Blackout)) {
    records.push(
      completion(
        `blackout-${participant.playerCode}`,
        participantId,
        CompletionCategory.Blackout,
        'blackout',
        timestampAt(participant.baseSecond + 100),
      ),
    );
  }

  if (categoryIsEnabled(CompletionCategory.Line)) {
    records.push(
      ...LINE_KEYS.slice(0, participant.lineCount).map((lineKey, index) =>
        completion(
          `line-${participant.playerCode}-${index}`,
          participantId,
          CompletionCategory.Line,
          lineKey,
          timestampAt(participant.baseSecond + index),
        ),
      ),
    );
  }

  if (participant.hashtag && categoryIsEnabled(CompletionCategory.Hashtag)) {
    records.push(
      completion(
        `hashtag-${participant.playerCode}`,
        participantId,
        CompletionCategory.Hashtag,
        'hashtag',
        timestampAt(participant.baseSecond + 200),
      ),
    );
  }

  return records;
}

interface ExpectedEntry {
  readonly playerCode: string;
  readonly completionCount: number;
  readonly earliestCompletionAt: string;
}

function expectedEntries(
  participants: readonly ParticipantScenario[],
  category: Category,
  emptyCategory: Category | null,
): ExpectedEntry[] {
  if (emptyCategory === category) return [];

  return participants
    .flatMap((participant): ExpectedEntry[] => {
      const completionCount =
        category === CompletionCategory.Blackout
          ? participant.blackout
            ? 1
            : 0
          : category === CompletionCategory.Hashtag
            ? participant.hashtag
              ? 1
              : 0
            : participant.lineCount;
      if (completionCount === 0) return [];

      const earliestSecond =
        participant.baseSecond +
        (category === CompletionCategory.Blackout
          ? 100
          : category === CompletionCategory.Hashtag
            ? 200
            : 0);
      return [
        {
          playerCode: participant.playerCode,
          completionCount,
          earliestCompletionAt: timestampAt(earliestSecond).toISOString(),
        },
      ];
    })
    .sort((left, right) => {
      const countDifference = right.completionCount - left.completionCount;
      if (countDifference !== 0) return countDifference;
      const timestampDifference =
        Date.parse(left.earliestCompletionAt) - Date.parse(right.earliestCompletionAt);
      if (timestampDifference !== 0) return timestampDifference;
      return left.playerCode.localeCompare(right.playerCode);
    });
}

function makeState(scenario: LeaderboardScenario) {
  const profiles: PlayerProfileRecord[] = scenario.participants.map((participant, index) => ({
    id: `property-12-profile-${index}` as PlayerProfileRecord['id'],
    gameId: GAME_ID,
    participantId: participantIdFor(participant.playerCode),
    displayName: participant.playerCode,
    playerCode: participant.playerCode,
    createdAt: new Date(BASE_TIME),
  }));
  const generatedRecords = scenario.participants.flatMap((participant) =>
    recordsFor(participant, scenario.emptyCategory),
  );
  const unrelatedRecords: CompletionRecord[] = [
    completion(
      'foreign-game-blackout',
      participantIdFor('FOREIGN'),
      CompletionCategory.Blackout,
      'blackout',
      timestampAt(0),
      OTHER_GAME_ID,
    ),
    completion(
      'unknown-participant-line',
      'property-12-unknown' as ParticipantId,
      CompletionCategory.Line,
      'row:1',
      timestampAt(0),
    ),
  ];

  return emptyVerificationState({
    game,
    profiles,
    // Reverse insertion order so expected ordering cannot depend on storage order.
    completions: [...generatedRecords, ...unrelatedRecords].reverse(),
  });
}

describe('Property 12: deterministic leaderboard ordering', () => {
  it('filters categories and orders every populated leaderboard by count, time, then Player_Code', () => {
    // Feature: human-bingo, Property 12
    // **Validates: Requirements 8.5, 9.6-9.7, 10.5-10.6, 11.3**
    fc.assert(
      fc.property(leaderboardScenarioArbitrary, (scenario) => {
        const leaderboards = projectLeaderboards(makeState(scenario));

        for (const category of CATEGORIES) {
          const leaderboard =
            category === CompletionCategory.Blackout
              ? leaderboards.blackout
              : category === CompletionCategory.Line
                ? leaderboards.line
                : leaderboards.hashtag;
          const expected = expectedEntries(scenario.participants, category, scenario.emptyCategory);
          const actualSummary = leaderboard.entries.map((entry) => ({
            playerCode: entry.participant.playerCode,
            completionCount: entry.completionCount,
            earliestCompletionAt: entry.earliestCompletionAt,
          }));

          expect(actualSummary).toEqual(expected);
          expect(leaderboard.entries).toHaveLength(expected.length);
          expect(
            leaderboard.entries.every((entry) =>
              entry.completions.every((record) => record.category === category),
            ),
          ).toBe(true);
          expect(
            leaderboard.entries.every((entry) =>
              entry.completions.every((record) => record.gameId === GAME_ID),
            ),
          ).toBe(true);

          if ('totalCompletions' in leaderboard) {
            expect(leaderboard.totalCompletions).toBe(
              expected.reduce((total, entry) => total + entry.completionCount, 0),
            );
          }
        }
      }),
      readPropertyTestOptions(),
    );
  });
});
