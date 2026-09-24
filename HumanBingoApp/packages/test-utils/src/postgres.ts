import { Pool } from 'pg';
import type { Client, PoolClient } from 'pg';
import { requireDatabaseTestConfig } from './config.js';

export interface TestPostgres {
  readonly pool: Pool;
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Creates a node-postgres pool bound to the isolated test database. The URL
 * is taken from TEST_DATABASE_URL and validated by the shared database test
 * configuration, which refuses production URLs and requires NODE_ENV=test.
 */
export const createTestPostgres = (source: NodeJS.ProcessEnv = process.env): TestPostgres => {
  const config = requireDatabaseTestConfig(source);
  const pool = new Pool({ connectionString: config.url, max: config.maxConnections });
  return { pool, url: config.url, close: () => pool.end() };
};

/**
 * Runs work on a single checked-out client. Repository operations that open
 * raw BEGIN/COMMIT transactions (for example membership session creation)
 * must stay on one connection, so they cannot run against the pool directly.
 */
export const withTestClient = async <Value>(
  pool: Pool,
  work: (client: Client) => Promise<Value>,
): Promise<Value> => {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
};

const truncatedTables = ['games', 'browser_sessions'];

/**
 * Empties every table reachable from the repository roots between tests.
 * Accepts a pool or a checked-out client so callers that must stay on one
 * connection (raw BEGIN/COMMIT repositories) can reuse their client.
 */
export const truncateDatabase = async (pool: Pool | PoolClient): Promise<void> => {
  await pool.query(`TRUNCATE ${truncatedTables.join(', ')} RESTART IDENTITY CASCADE`);
};
