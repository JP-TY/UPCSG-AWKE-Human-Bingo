import { describe, expect, it } from 'vitest';
import {
  createTestContext,
  fixedClock,
  readPropertyTestOptions,
  seededRandom,
} from '@human-bingo/test-utils';

describe('test utilities', () => {
  it('provides a mutable deterministic clock with defensive Date copies', () => {
    const clock = fixedClock('2025-01-01T00:00:00.000Z');
    const first = clock.now();
    first.setUTCFullYear(2030);

    expect(clock.now().toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(clock.advance(1000).toISOString()).toBe('2025-01-01T00:00:01.000Z');
  });

  it('replays seeded random values and creates sequential fixture IDs', () => {
    const first = seededRandom('replayable');
    const second = seededRandom('replayable');
    const context = createTestContext({ seed: 7 });

    expect(Array.from(first.bytes(8))).toEqual(Array.from(second.bytes(8)));
    expect(context.fixtures.game().id).not.toBe(context.fixtures.game().id);
  });

  it('uses reproducible property defaults with at least 100 runs', () => {
    const options = readPropertyTestOptions({ FAST_CHECK_NUM_RUNS: '25', FAST_CHECK_SEED: '17' });

    expect(options).toEqual({ numRuns: 100, seed: 17 });
  });
});
