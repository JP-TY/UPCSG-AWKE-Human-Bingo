import type { Clock } from './clock.js';

export type FixtureGameStatus = 'draft' | 'invitation_available' | 'active' | 'closed';

export interface TaskFixture {
  readonly id: string;
  readonly text: string;
}

export interface GameFixture {
  readonly id: string;
  readonly name: string;
  readonly status: FixtureGameStatus;
  readonly tasks: readonly TaskFixture[];
}

export interface FixtureFactory {
  readonly nextId: (prefix?: string) => string;
  readonly now: () => Date;
  readonly tasks: (count?: number, prefix?: string) => TaskFixture[];
  readonly game: (options?: {
    readonly name?: string;
    readonly status?: FixtureGameStatus;
    readonly taskCount?: number;
  }) => GameFixture;
}

export const createFixtureFactory = (clock: Clock): FixtureFactory => {
  let sequence = 0;
  const nextId = (prefix = 'fixture'): string => {
    sequence += 1;
    return `${prefix}-${String(sequence).padStart(6, '0')}`;
  };

  const tasks = (count = 25, prefix = 'Task'): TaskFixture[] => {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('Fixture task count must be a non-negative integer');
    }
    return Array.from({ length: count }, (_, index) => ({
      id: nextId('task'),
      text: `${prefix} ${index + 1}`,
    }));
  };

  return {
    nextId,
    now: clock.now,
    tasks,
    game: (options = {}): GameFixture => ({
      id: nextId('game'),
      name: options.name ?? 'Human Bingo Test Game',
      status: options.status ?? 'draft',
      tasks: tasks(options.taskCount ?? 25),
    }),
  };
};
