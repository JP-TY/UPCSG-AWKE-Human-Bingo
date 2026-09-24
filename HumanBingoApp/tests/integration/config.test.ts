import { describe, expect, it } from 'vitest';
import {
  DatabaseTestConfigurationError,
  readDatabaseTestConfig,
  requireDatabaseTestConfig,
} from '@human-bingo/test-utils';

describe('database test configuration', () => {
  it('does not infer a database URL from the application environment', () => {
    const config = readDatabaseTestConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/human_bingo',
    });

    expect(config.url).toBeUndefined();
    expect(() => requireDatabaseTestConfig({ NODE_ENV: 'test' })).toThrow(
      DatabaseTestConfigurationError,
    );
  });

  it('accepts an explicit PostgreSQL test URL', () => {
    const config = requireDatabaseTestConfig({
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'postgresql://localhost:5432/human_bingo_test',
    });

    expect(config.url).toBe('postgresql://localhost:5432/human_bingo_test');
    expect(config.schema).toMatch(/^test_/);
  });
});
