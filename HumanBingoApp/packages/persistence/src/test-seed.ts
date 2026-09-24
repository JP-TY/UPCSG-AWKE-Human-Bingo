import type { MigrationClient } from './migrations/index.js';

export type SeedEnvironment = 'development' | 'test';

export const testSeedSql = String.raw`
INSERT INTO games (id, host_account_id, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'test-host', 'Human Bingo Test Game', 'draft')
ON CONFLICT (id) DO NOTHING;

INSERT INTO task_entries (game_id, display_text, normalized_text)
SELECT '00000000-0000-0000-0000-000000000001', 'Test task ' || task_number,
       lower('test task ' || task_number)
FROM generate_series(1, 25) AS task_number
WHERE NOT EXISTS (
  SELECT 1 FROM task_entries
  WHERE game_id = '00000000-0000-0000-0000-000000000001'
);
`;

export async function seedTestData(client: MigrationClient, environment: string): Promise<void> {
  if (environment !== 'development' && environment !== 'test') {
    throw new Error('Test seed data is only available in development or test environments');
  }

  await client.query('BEGIN');
  try {
    await client.query(testSeedSql);
    await client.query('COMMIT');
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the seed error; the caller's connection should be discarded.
    }
    throw error;
  }
}
