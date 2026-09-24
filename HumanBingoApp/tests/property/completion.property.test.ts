import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BOARD_SQUARE_COUNT,
  HASHTAG_INDICES,
  LINE_POSITIONS,
  LineDirection,
  SquareStatus,
  getCompletedLines,
  isBlackoutComplete,
  isHashtagComplete,
  isLineComplete,
  type LinePosition,
} from '@human-bingo/domain';
import { readPropertyTestOptions } from '@human-bingo/test-utils';
interface SquareFixture {
  readonly status: SquareStatus;
  readonly taskText: string;
  readonly label: string;
}
const squareFixtureArbitrary = fc.record({
  status: fc.constantFrom(
    SquareStatus.Unverified,
    SquareStatus.Pending,
    SquareStatus.Rejected,
    SquareStatus.Verified,
  ),
  taskText: fc.string(),
  label: fc.string(),
});
const boardArbitrary = fc.array(squareFixtureArbitrary, {
  minLength: BOARD_SQUARE_COUNT,
  maxLength: BOARD_SQUARE_COUNT,
});
const referenceLineIndices = (line: LinePosition): readonly number[] => {
  switch (line.direction) {
    case LineDirection.Horizontal:
      return Array.from({ length: 5 }, (_, column) => (line.position - 1) * 5 + column);
    case LineDirection.Vertical:
      return Array.from({ length: 5 }, (_, row) => row * 5 + line.position - 1);
    case LineDirection.Diagonal:
      return line.position === 'top_left_to_bottom_right' ? [0, 6, 12, 18, 24] : [4, 8, 12, 16, 20];
  }
};
const referenceHashtagIndices = [1, 3, 5, 6, 7, 8, 9, 11, 13, 15, 16, 17, 18, 19, 21, 23];
const allVerifiedAt = (statuses: readonly SquareStatus[], indices: readonly number[]): boolean =>
  indices.every((index) => statuses[index] === SquareStatus.Verified);
const nonVerifiedStatuses = [
  SquareStatus.Unverified,
  SquareStatus.Pending,
  SquareStatus.Rejected,
] as const;
const statusesOf = (squares: readonly SquareFixture[]): SquareStatus[] =>
  squares.map(({ status }) => status);
describe('positional completion predicates', () => {
  it('validates Property 10 across arbitrary statuses and metadata', () => {
    // Feature: human-bingo, Property 10
    fc.assert(
      fc.property(boardArbitrary, (squares) => {
        const statuses = statusesOf(squares);
        const metadataVariant = squares.map(({ status }, index) => ({
          status,
          taskText: `different task ${index}`,
          label: `different label ${index}`,
        }));
        const metadataVariantStatuses = statusesOf(metadataVariant);
        expect(LINE_POSITIONS).toHaveLength(12);
        expect(HASHTAG_INDICES).toEqual(referenceHashtagIndices);
        const expectedBlackout = allVerifiedAt(
          statuses,
          Array.from({ length: BOARD_SQUARE_COUNT }, (_, index) => index),
        );
        const expectedLines = LINE_POSITIONS.filter((line) =>
          allVerifiedAt(statuses, referenceLineIndices(line)),
        );
        const expectedHashtag = allVerifiedAt(statuses, referenceHashtagIndices);
        expect(isBlackoutComplete(statuses)).toBe(expectedBlackout);
        expect(getCompletedLines(statuses)).toEqual(expectedLines);
        expect(isHashtagComplete(statuses)).toBe(expectedHashtag);
        for (const line of LINE_POSITIONS) {
          expect(isLineComplete(statuses, line)).toBe(
            allVerifiedAt(statuses, referenceLineIndices(line)),
          );
        }
        expect(isBlackoutComplete(metadataVariantStatuses)).toBe(isBlackoutComplete(statuses));
        expect(getCompletedLines(metadataVariantStatuses)).toEqual(getCompletedLines(statuses));
        expect(isHashtagComplete(metadataVariantStatuses)).toBe(isHashtagComplete(statuses));
        for (const line of LINE_POSITIONS) {
          const indices = referenceLineIndices(line);
          if (allVerifiedAt(statuses, indices)) {
            for (const nonVerifiedStatus of nonVerifiedStatuses) {
              const changed = [...statuses];
              const firstIndex = indices[0];
              if (firstIndex === undefined) {
                throw new Error('A completion line must contain at least one square');
              }
              changed[firstIndex] = nonVerifiedStatus;
              expect(isLineComplete(changed, line)).toBe(false);
            }
          }
        }
        if (expectedBlackout) {
          for (const nonVerifiedStatus of nonVerifiedStatuses) {
            const changed = [...statuses];
            changed[0] = nonVerifiedStatus;
            expect(isBlackoutComplete(changed)).toBe(false);
          }
        }
        if (expectedHashtag) {
          for (const nonVerifiedStatus of nonVerifiedStatuses) {
            const changed = [...statuses];
            changed[referenceHashtagIndices[0]] = nonVerifiedStatus;
            expect(isHashtagComplete(changed)).toBe(false);
          }
        }
      }),
      readPropertyTestOptions(),
    );
  });
});
