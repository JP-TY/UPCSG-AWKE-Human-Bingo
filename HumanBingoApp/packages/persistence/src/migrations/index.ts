import { faceStampsDownSql, faceStampsUpSql } from './face-stamps-sql.js';
import { initialSchemaDownSql, initialSchemaUpSql } from './schema-sql.js';

export interface MigrationClient {
  query(sql: string): Promise<unknown>;
}

export interface MigrationDefinition {
  readonly id: string;
  readonly upSql: string;
  readonly downSql: string;
}

export const initialSchemaMigration: MigrationDefinition = {
  id: '001_initial_schema',
  upSql: initialSchemaUpSql,
  downSql: initialSchemaDownSql,
};

export const faceStampsMigration: MigrationDefinition = {
  id: '002_face_stamps',
  upSql: faceStampsUpSql,
  downSql: faceStampsDownSql,
};

/** Ordered ledger: every migration runs in array order. */
export const migrationLedger: readonly MigrationDefinition[] = [
  initialSchemaMigration,
  faceStampsMigration,
];

export type MigrationDirection = 'up' | 'down';

export async function runMigration(
  client: MigrationClient,
  migration: MigrationDefinition,
  direction: MigrationDirection = 'up',
): Promise<void> {
  const sql = direction === 'up' ? migration.upSql : migration.downSql;
  await client.query('BEGIN');

  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the migration error; the caller's connection should be discarded.
    }
    throw error;
  }
}

export { initialSchemaDownSql, initialSchemaUpSql } from './schema-sql.js';
export { faceStampsDownSql, faceStampsUpSql } from './face-stamps-sql.js';
