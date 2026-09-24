export interface Clock {
  readonly now: () => Date;
}

export interface TestClock extends Clock {
  readonly advance: (milliseconds: number) => Date;
  readonly set: (instant: Date | string) => Date;
}

const parseInstant = (instant: Date | string): Date => {
  const date = instant instanceof Date ? new Date(instant) : new Date(instant);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid test instant: ${String(instant)}`);
  }
  return date;
};

export const fixedClock = (instant: string | Date): TestClock => {
  let current = parseInstant(instant);

  return {
    now: () => new Date(current),
    advance: (milliseconds: number): Date => {
      if (!Number.isFinite(milliseconds)) {
        throw new Error('Clock advance must be finite');
      }
      current = new Date(current.valueOf() + milliseconds);
      return new Date(current);
    },
    set: (nextInstant: Date | string): Date => {
      current = parseInstant(nextInstant);
      return new Date(current);
    },
  };
};
