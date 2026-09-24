export type RandomSeed = number | string;

export interface RandomSource {
  readonly next: () => number;
  readonly integer: (maxExclusive: number) => number;
  readonly bytes: (length: number) => Uint8Array;
  readonly shuffle: <T>(values: readonly T[]) => T[];
}

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const normalizeSeed = (seed: RandomSeed): number => {
  const numericSeed = typeof seed === 'number' ? seed : hashSeed(seed);
  if (!Number.isInteger(numericSeed)) {
    throw new Error('Random seed must be an integer or string');
  }
  return numericSeed >>> 0 || 0x6d2b79f5;
};

/** A small deterministic source intended for tests, not production security decisions. */
export const seededRandom = (seed: RandomSeed): RandomSource => {
  let state = normalizeSeed(seed);

  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };

  return {
    next,
    integer: (maxExclusive: number): number => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error('Random integer bound must be a positive integer');
      }
      return Math.floor(next() * maxExclusive);
    },
    bytes: (length: number): Uint8Array => {
      if (!Number.isInteger(length) || length < 0) {
        throw new Error('Random byte length must be a non-negative integer');
      }
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        result[index] = Math.floor(next() * 256);
      }
      return result;
    },
    shuffle: <T>(values: readonly T[]): T[] => {
      const result = [...values];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(next() * (index + 1));
        const value = result[index];
        result[index] = result[swapIndex] as T;
        result[swapIndex] = value as T;
      }
      return result;
    },
  };
};
