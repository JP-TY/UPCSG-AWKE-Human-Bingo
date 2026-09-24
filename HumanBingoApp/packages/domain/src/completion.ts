/**
 * Pure positional completion predicates for a persisted 5x5 grid.
 *
 * Boards use row-major square indexes: index = (zero-based row * 5) +
 * zero-based column. Line positions exposed by this module are 1-based for
 * rows and columns, matching the labels shown to participants.
 */

import { LineDirection, SquareStatus, type LinePosition } from './contracts.js';

export const BOARD_SIZE = 5;
export const BOARD_SQUARE_COUNT = BOARD_SIZE * BOARD_SIZE;

const BOARD_INDICES = Object.freeze(
  Array.from({ length: BOARD_SQUARE_COUNT }, (_, index) => index),
);

/**
 * The fixed Hashtag pattern uses 1-based rows 2 and 4 plus columns 2 and 4.
 * The implementation converts those coordinates to zero-based indexes and
 * filters the board indexes, so the four intersections are naturally counted
 * once rather than once for each selected row/column.
 */
const HASHTAG_ZERO_BASED_ROWS = new Set([1, 3]);
const HASHTAG_ZERO_BASED_COLUMNS = new Set([1, 3]);

export const HASHTAG_INDICES = Object.freeze(
  BOARD_INDICES.filter((index) => {
    const row = Math.floor(index / BOARD_SIZE);
    const column = index % BOARD_SIZE;
    return HASHTAG_ZERO_BASED_ROWS.has(row) || HASHTAG_ZERO_BASED_COLUMNS.has(column);
  }),
);

export const LINE_POSITIONS = Object.freeze([
  { direction: LineDirection.Horizontal, position: 1 },
  { direction: LineDirection.Horizontal, position: 2 },
  { direction: LineDirection.Horizontal, position: 3 },
  { direction: LineDirection.Horizontal, position: 4 },
  { direction: LineDirection.Horizontal, position: 5 },
  { direction: LineDirection.Vertical, position: 1 },
  { direction: LineDirection.Vertical, position: 2 },
  { direction: LineDirection.Vertical, position: 3 },
  { direction: LineDirection.Vertical, position: 4 },
  { direction: LineDirection.Vertical, position: 5 },
  { direction: LineDirection.Diagonal, position: 'top_left_to_bottom_right' },
  { direction: LineDirection.Diagonal, position: 'top_right_to_bottom_left' },
] as const satisfies readonly LinePosition[]);

/**
 * Returns the persisted zero-based indexes belonging to a line.
 * Horizontal and vertical positions are 1-based; diagonal positions are named
 * by their corner-to-corner direction.
 */
export function getLineIndices(line: LinePosition): readonly number[] {
  switch (line.direction) {
    case LineDirection.Horizontal: {
      const row = line.position - 1;
      return Array.from({ length: BOARD_SIZE }, (_, column) => row * BOARD_SIZE + column);
    }
    case LineDirection.Vertical: {
      const column = line.position - 1;
      return Array.from({ length: BOARD_SIZE }, (_, row) => row * BOARD_SIZE + column);
    }
    case LineDirection.Diagonal:
      return line.position === 'top_left_to_bottom_right' ? [0, 6, 12, 18, 24] : [4, 8, 12, 16, 20];
  }
}

function assertBoardSize(statuses: readonly SquareStatus[]): void {
  if (statuses.length !== BOARD_SQUARE_COUNT) {
    throw new RangeError(`A completion board must contain exactly ${BOARD_SQUARE_COUNT} squares.`);
  }
}

function allVerified(statuses: readonly SquareStatus[], indices: readonly number[]): boolean {
  return indices.every((index) => statuses[index] === SquareStatus.Verified);
}

/** Returns true when all 25 persisted squares are verified. */
export function isBlackoutComplete(statuses: readonly SquareStatus[]): boolean {
  assertBoardSize(statuses);
  return allVerified(statuses, BOARD_INDICES);
}

/** Returns true when every square in the specified row, column, or diagonal is verified. */
export function isLineComplete(statuses: readonly SquareStatus[], line: LinePosition): boolean {
  assertBoardSize(statuses);
  return allVerified(statuses, getLineIndices(line));
}

/** Returns every completed standard line in deterministic row, column, diagonal order. */
export function getCompletedLines(statuses: readonly SquareStatus[]): readonly LinePosition[] {
  assertBoardSize(statuses);
  return LINE_POSITIONS.filter((line) => isLineComplete(statuses, line));
}

/** Returns true when all 16 distinct fixed Hashtag positions are verified. */
export function isHashtagComplete(statuses: readonly SquareStatus[]): boolean {
  assertBoardSize(statuses);
  return allVerified(statuses, HASHTAG_INDICES);
}
