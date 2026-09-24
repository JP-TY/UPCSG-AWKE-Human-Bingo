import './load-env.mjs';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { readEnvironment } from '../packages/api/dist/config/environment.js';

const config = readEnvironment();

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 1,
  ssl:
    config.databaseSslMode === 'disable'
      ? false
      : { rejectUnauthorized: config.databaseSslMode === 'verify-full' },
});
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('human-bingo-schema', 0))");

  const schema = await client.query("SELECT to_regclass('public.games') AS games");
  if (schema.rows[0]?.games === null) {
    const initialSchema = await readFile(
      new URL('../packages/persistence/src/migrations/001_initial_schema.sql', import.meta.url),
      'utf8',
    );
    await client.query(initialSchema);
  }

  const faceStampMigration = await readFile(
    new URL('../packages/persistence/src/migrations/002_face_stamps.sql', import.meta.url),
    'utf8',
  );
  await client.query(faceStampMigration);
  await client.query('COMMIT');
  console.log('Database schema is ready');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
