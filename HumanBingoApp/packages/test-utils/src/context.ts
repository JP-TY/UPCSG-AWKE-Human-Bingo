import { fixedClock, type TestClock } from './clock.js';
import { createFixtureFactory, type FixtureFactory } from './fixtures.js';
import { seededRandom, type RandomSeed, type RandomSource } from './random.js';

export interface TestContext {
  readonly clock: TestClock;
  readonly random: RandomSource;
  readonly fixtures: FixtureFactory;
}

export interface TestContextOptions {
  readonly instant?: string | Date;
  readonly seed?: RandomSeed;
}

export const createTestContext = (options: TestContextOptions = {}): TestContext => {
  const clock = fixedClock(options.instant ?? '2025-01-01T00:00:00.000Z');
  const random = seededRandom(options.seed ?? 'human-bingo-test');
  return { clock, random, fixtures: createFixtureFactory(clock) };
};
