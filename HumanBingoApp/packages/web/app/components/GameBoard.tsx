'use client';

import { useRef, useState } from 'react';
import { SquareStatus } from '@human-bingo/domain';
import type { GridSquareDto } from '../lib/types';
import { FaceStamp } from './FaceStamp';

const statusLabels: Record<SquareStatus, string> = {
  [SquareStatus.Unverified]: 'Unverified',
  [SquareStatus.Pending]: 'Pending',
  [SquareStatus.Rejected]: 'Rejected',
  [SquareStatus.Verified]: 'Verified',
};

export function GameBoard({
  squares,
  closed,
  selectedIndex,
  onSelect,
}: {
  squares: readonly GridSquareDto[];
  closed: boolean;
  selectedIndex: number | null;
  onSelect: (square: GridSquareDto) => void;
}) {
  const [focusIndex, setFocusIndex] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>, square: GridSquareDto) => {
    const moves: Record<string, number> = {
      ArrowUp: -5,
      ArrowDown: 5,
      ArrowLeft: -1,
      ArrowRight: 1,
    };
    const move = moves[event.key];
    if (move === undefined) return;

    event.preventDefault();
    const target = Math.max(0, Math.min(24, square.squareIndex + move));
    setFocusIndex(target);
    buttons.current[target]?.focus();
  };

  const orderedSquares = [...squares].sort((a, b) => a.squareIndex - b.squareIndex);

  return (
    <div className="grid-paper">
      <div className="bingo-grid" role="grid" aria-label="Human Bingo task grid">
        {Array.from({ length: 5 }, (_, rowIndex) => (
          <div className="bingo-grid__row" role="row" key={rowIndex} aria-rowindex={rowIndex + 1}>
            {orderedSquares
              .filter((square) => square.row === rowIndex + 1)
              .map((square) => {
                const label = statusLabels[square.status];
                const selected = selectedIndex === square.squareIndex;
                const unavailable = closed || square.status === SquareStatus.Verified;
                return (
                  <div
                    className="bingo-grid__cell"
                    role="gridcell"
                    key={square.squareIndex}
                    aria-colindex={square.column}
                    aria-selected={selected}
                  >
                    <button
                      ref={(element) => {
                        buttons.current[square.squareIndex] = element;
                      }}
                      className={`bingo-square bingo-square--${square.status}${selected ? ' bingo-square--selected' : ''}`}
                      type="button"
                      disabled={unavailable}
                      tabIndex={focusIndex === square.squareIndex ? 0 : -1}
                      aria-label={`Row ${square.row}, column ${square.column}: ${square.taskText}. Status: ${label}.`}
                      aria-expanded={selected}
                      aria-controls={selected ? 'selected-square' : undefined}
                      data-status={square.status}
                      onFocus={() => setFocusIndex(square.squareIndex)}
                      onKeyDown={(event) => moveFocus(event, square)}
                      onClick={() => onSelect(square)}
                    >
                      <span className="bingo-square__task">{square.taskText}</span>
                      {square.status === SquareStatus.Pending ? (
                        <span className="bingo-square__state">Waiting</span>
                      ) : square.status === SquareStatus.Unverified ? (
                        <span className="bingo-square__state">Open</span>
                      ) : null}
                      {square.status === SquareStatus.Verified &&
                      square.stampIndex !== undefined ? (
                        <FaceStamp stampIndex={square.stampIndex} />
                      ) : null}
                    </button>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
