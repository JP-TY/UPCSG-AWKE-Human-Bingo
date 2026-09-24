import { existsSync, readFileSync } from 'node:fs';

const ENV_FILE = new URL('../.env', import.meta.url);

/**
 * Loads the repository `.env` file into `process.env` as a side effect.
 * Existing environment variables always win over file values, so shell
 * exports and CI overrides are never clobbered. Absent `.env` is fine
 * (for example in CI or on ephemeral runners).
 */
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
} else if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}
