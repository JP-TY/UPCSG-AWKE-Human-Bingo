import { describe, expect, it } from 'vitest';

import { faceStampIndexFor } from './chop-bag.js';

describe('face stamp bag', () => {
  it('deals every face exactly once before starting a new bag', () => {
    const firstBag = Array.from({ length: 11 }, (_, ordinal) =>
      faceStampIndexFor('grid-ake-2026', ordinal),
    );
    const secondBag = Array.from({ length: 11 }, (_, ordinal) =>
      faceStampIndexFor('grid-ake-2026', ordinal + 11),
    );

    expect(new Set(firstBag).size).toBe(11);
    expect(new Set(secondBag).size).toBe(11);
    expect(firstBag.every((index) => index >= 0 && index < 11)).toBe(true);
    expect(secondBag.every((index) => index >= 0 && index < 11)).toBe(true);
  });

  it('returns the same face for a persisted verification ordinal', () => {
    expect(faceStampIndexFor('grid-ake-2026', 17)).toBe(faceStampIndexFor('grid-ake-2026', 17));
  });

  it('rejects invalid verification ordinals', () => {
    expect(() => faceStampIndexFor('grid-ake-2026', -1)).toThrow(RangeError);
    expect(() => faceStampIndexFor('grid-ake-2026', 1.5)).toThrow(RangeError);
  });
});
