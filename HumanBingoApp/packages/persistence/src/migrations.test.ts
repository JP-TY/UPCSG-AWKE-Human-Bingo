import { describe, expect, it } from 'vitest';

import {
  faceStampsDownSql,
  faceStampsMigration,
  faceStampsUpSql,
  initialSchemaDownSql,
  initialSchemaMigration,
  initialSchemaUpSql,
  migrationLedger,
  runMigration,
  type MigrationClient,
} from './migrations/index.js';
import { seedTestData, testSeedSql } from './test-seed.js';

class RecordingClient implements MigrationClient {
  readonly queries: string[] = [];

  constructor(private readonly failureQuery?: string) {}

  query(sql: string): Promise<void> {
    this.queries.push(sql);
    if (sql === this.failureQuery) {
      return Promise.reject(new Error('database failure'));
    }
    return Promise.resolve();
  }
}

describe('initial persistence migration', () => {
  it('contains every authoritative table and the required uniqueness constraints', () => {
    for (const table of [
      'games',
      'task_entries',
      'invitations',
      'browser_sessions',
      'command_idempotency',
      'memberships',
      'participants',
      'player_profiles',
      'grids',
      'squares',
      'verification_requests',
      'notifications',
      'push_subscriptions',
      'completions',
      'outbox_events',
    ]) {
      expect(initialSchemaUpSql).toContain(`CREATE TABLE ${table}`);
    }

    expect(initialSchemaUpSql).toContain('task_entries_active_normalized_uq');
    expect(initialSchemaUpSql).toContain('verification_requests_active_square_uq');
    expect(initialSchemaUpSql).toContain('UNIQUE (game_id, participant_id)');
    expect(initialSchemaUpSql).toContain('UNIQUE (game_id, state_version)');
    expect(initialSchemaDownSql).toContain('DROP TABLE IF EXISTS games');
  });

  it('commits an up or down migration only after its SQL succeeds', async () => {
    const upClient = new RecordingClient();
    await runMigration(upClient, initialSchemaMigration, 'up');
    expect(upClient.queries).toEqual(['BEGIN', initialSchemaUpSql, 'COMMIT']);

    const downClient = new RecordingClient();
    await runMigration(downClient, initialSchemaMigration, 'down');
    expect(downClient.queries).toEqual(['BEGIN', initialSchemaDownSql, 'COMMIT']);
  });

  it('rolls back a failed migration and preserves the original error', async () => {
    const client = new RecordingClient(initialSchemaUpSql);

    await expect(runMigration(client, initialSchemaMigration)).rejects.toThrow('database failure');
    expect(client.queries).toEqual(['BEGIN', initialSchemaUpSql, 'ROLLBACK']);
  });

  it('allows repeatable test seeds only outside production', async () => {
    const client = new RecordingClient();
    await seedTestData(client, 'test');
    expect(client.queries).toEqual(['BEGIN', testSeedSql, 'COMMIT']);

    await expect(seedTestData(client, 'production')).rejects.toThrow(
      'Test seed data is only available in development or test environments',
    );
  });
});

describe('face stamp migration', () => {
  it('adds a nullable 0-10 stamp index and backfills verified squares without repeats', async () => {
    expect(faceStampsMigration.id).toBe('002_face_stamps');
    expect(faceStampsUpSql).toContain('ADD COLUMN IF NOT EXISTS stamp_index');
    expect(faceStampsUpSql).toContain('squares_stamp_index_range');
    expect(faceStampsUpSql).toContain('CHECK (stamp_index BETWEEN 0 AND 10)');
    expect(faceStampsUpSql).toContain("WHERE status = 'verified'");
    expect(faceStampsUpSql).toContain('AND target.stamp_index IS NULL');
    expect(faceStampsDownSql).toContain('DROP COLUMN IF EXISTS stamp_index');

    const client = new RecordingClient();
    await runMigration(client, faceStampsMigration, 'up');
    expect(client.queries).toEqual(['BEGIN', faceStampsUpSql, 'COMMIT']);

    expect(migrationLedger.map((migration) => migration.id)).toEqual([
      '001_initial_schema',
      '002_face_stamps',
    ]);
  });
});

describe('outbox consumer receipt migration', () => {
  it('creates durable consumer receipts after the outbox table', () => {
    expect(initialSchemaUpSql).toContain('CREATE TABLE event_consumer_receipts');
    expect(initialSchemaUpSql).toContain('PRIMARY KEY (consumer_name, event_id)');
    expect(
      initialSchemaDownSql.indexOf('DROP TABLE IF EXISTS event_consumer_receipts'),
    ).toBeLessThan(initialSchemaDownSql.indexOf('DROP TABLE IF EXISTS outbox_events'));
  });
});
