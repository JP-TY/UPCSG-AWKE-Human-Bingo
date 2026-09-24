import { describe, expect, it } from 'vitest';

import {
  BOARD_SQUARE_COUNT,
  HASHTAG_INDICES,
  LINE_POSITIONS,
  getCompletedLines,
  getLineIndices,
  isBlackoutComplete,
  isHashtagComplete,
  isLineComplete,
} from './completion.js';
import { LineDirection, SquareStatus, type LinePosition } from './contracts.js';

const emptyBoard = (): SquareStatus[] =>
  Array.from({ length: BOARD_SQUARE_COUNT }, () => SquareStatus.Unverified);

const boardWith = (indices: readonly number[]): SquareStatus[] => {
  const board = emptyBoard();
  for (const index of indices) {
    board[index] = SquareStatus.Verified;
  }
  return board;
};

describe('positional completion predicates', () => {
  it('recognizes Blackout only when all 25 squares are verified', () => {
    const board = boardWith(Array.from({ length: BOARD_SQUARE_COUNT }, (_, index) => index));

    expect(isBlackoutComplete(board)).toBe(true);

    board[24] = SquareStatus.Pending;
    expect(isBlackoutComplete(board)).toBe(false);
    board[24] = SquareStatus.Rejected;
    expect(isBlackoutComplete(board)).toBe(false);
    board[24] = SquareStatus.Unverified;
    expect(isBlackoutComplete(board)).toBe(false);
  });

  it('maps each horizontal position to exactly its five row-major indexes', () => {
    for (const row of [1, 2, 3, 4, 5] as const) {
      const line: LinePosition = { direction: LineDirection.Horizontal, position: row };
      expect(getLineIndices(line)).toEqual([
        (row - 1) * 5,
        (row - 1) * 5 + 1,
        (row - 1) * 5 + 2,
        (row - 1) * 5 + 3,
        (row - 1) * 5 + 4,
      ]);
      expect(isLineComplete(boardWith(getLineIndices(line)), line)).toBe(true);
    }
  });

  it('maps each vertical position to exactly its five row-major indexes', () => {
    for (const column of [1, 2, 3, 4, 5] as const) {
      const line: LinePosition = { direction: LineDirection.Vertical, position: column };
      expect(getLineIndices(line)).toEqual([
        column - 1,
        column + 4,
        column + 9,
        column + 14,
        column + 19,
      ]);
      expect(isLineComplete(boardWith(getLineIndices(line)), line)).toBe(true);
    }
  });

  it('maps and recognizes both diagonals while excluding adjacent non-diagonal squares', () => {
    const topLeftToBottomRight: LinePosition = {
      direction: LineDirection.Diagonal,
      position: 'top_left_to_bottom_right',
    };
    const topRightToBottomLeft: LinePosition = {
      direction: LineDirection.Diagonal,
      position: 'top_right_to_bottom_left',
    };

    expect(getLineIndices(topLeftToBottomRight)).toEqual([0, 6, 12, 18, 24]);
    expect(getLineIndices(topRightToBottomLeft)).toEqual([4, 8, 12, 16, 20]);
    expect(
      isLineComplete(boardWith(getLineIndices(topLeftToBottomRight)), topLeftToBottomRight),
    ).toBe(true);
    expect(
      isLineComplete(boardWith(getLineIndices(topRightToBottomLeft)), topRightToBottomLeft),
    ).toBe(true);

    const almostDiagonal = boardWith([0, 6, 12, 18, 23]);
    expect(isLineComplete(almostDiagonal, topLeftToBottomRight)).toBe(false);
  });

  it('rejects every standard line when any one of its five positions is not verified', () => {
    for (const line of LINE_POSITIONS) {
      for (const missingIndex of getLineIndices(line)) {
        const incomplete = boardWith(getLineIndices(line));
        incomplete[missingIndex] = SquareStatus.Pending;
        expect(isLineComplete(incomplete, line)).toBe(false);
      }
    }
  });

  it('returns all five rows, five columns, and two diagonals when the board is verified', () => {
    const board = boardWith(Array.from({ length: BOARD_SQUARE_COUNT }, (_, index) => index));

    expect(getCompletedLines(board)).toEqual(LINE_POSITIONS);
  });

  it('recognizes exactly the fixed 16-position Hashtag pattern with shared intersections once', () => {
    expect(HASHTAG_INDICES).toHaveLength(16);
    expect(new Set(HASHTAG_INDICES).size).toBe(16);
    expect(HASHTAG_INDICES).toEqual([1, 3, 5, 6, 7, 8, 9, 11, 13, 15, 16, 17, 18, 19, 21, 23]);
    expect(isHashtagComplete(boardWith(HASHTAG_INDICES))).toBe(true);

    for (const index of HASHTAG_INDICES) {
      const incomplete = boardWith(HASHTAG_INDICES.filter((candidate) => candidate !== index));
      expect(isHashtagComplete(incomplete)).toBe(false);
    }

    const unrelatedSquares = boardWith([0, 2, 4, 10, 12, 14, 20, 22]);
    expect(isHashtagComplete(unrelatedSquares)).toBe(false);
  });

  it('returns all 12 standard lines in stable horizontal, vertical, diagonal order', () => {
    const board = boardWith([
      ...getLineIndices({ direction: LineDirection.Horizontal, position: 1 }),
      ...getLineIndices({ direction: LineDirection.Horizontal, position: 3 }),
      ...getLineIndices({ direction: LineDirection.Vertical, position: 2 }),
      ...getLineIndices({
        direction: LineDirection.Diagonal,
        position: 'top_left_to_bottom_right',
      }),
    ]);

    expect(getCompletedLines(board)).toEqual([
      LINE_POSITIONS[0],
      LINE_POSITIONS[2],
      LINE_POSITIONS[6],
      LINE_POSITIONS[10],
    ]);
    expect(LINE_POSITIONS).toHaveLength(12);
  });

  it('ignores non-verified statuses and does not mutate the input board', () => {
    const board = emptyBoard();
    board[0] = SquareStatus.Pending;
    board[6] = SquareStatus.Rejected;
    const before = [...board];

    const incompleteLine = boardWith([0, 1, 2, 3, 4]);
    incompleteLine[0] = SquareStatus.Pending;
    expect(
      isLineComplete(incompleteLine, { direction: LineDirection.Horizontal, position: 1 }),
    ).toBe(false);
    expect(isBlackoutComplete(board)).toBe(false);
    expect(isHashtagComplete(board)).toBe(false);
    expect(board).toEqual(before);
  });

  it('rejects boards that are not exactly 5 by 5', () => {
    expect(() => isBlackoutComplete([])).toThrow(RangeError);
    expect(() =>
      isHashtagComplete(Array.from({ length: 24 }, () => SquareStatus.Verified)),
    ).toThrow('exactly 25 squares');
  });
});
