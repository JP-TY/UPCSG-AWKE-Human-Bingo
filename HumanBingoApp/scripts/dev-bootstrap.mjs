#!/usr/bin/env node
import './load-env.mjs';
import { spawn } from 'node:child_process';
import {
  ensureApplicationDatabaseOwner,
  ensureLocalRole,
  parseLocalDevelopmentTarget,
  parseRolePreflightConfig,
  redact,
} from './local-role-preflight.mjs';

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown status'}`,
          ),
        );
    });
  });

try {
  const target = parseLocalDevelopmentTarget(process.argv.slice(2));
  // Validate both URLs and all safety guards before starting or connecting to anything.
  const roleConfig = parseRolePreflightConfig(process.env, target);
  await run('docker', ['compose', 'up', '-d', 'postgres']);
  const roleResult = await ensureLocalRole(roleConfig);
  console.log(
    `Local role preflight: ${roleResult.created ? 'created' : 'already present'} ${roleResult.roleName}`,
  );
  const ownerResult = await ensureApplicationDatabaseOwner(roleConfig);
  console.log(
    `Local database owner: ${ownerResult.changed ? 'aligned' : 'already aligned'} ${ownerResult.database}`,
  );
  await run(process.execPath, ['scripts/db.mjs', 'wait', '--target', target]);
  await run(process.execPath, ['scripts/db.mjs', 'create', '--target', target]);
  await run(process.execPath, ['scripts/db.mjs', 'migrate', '--target', target]);
} catch (error) {
  console.error(
    `Local development bootstrap failed: ${redact(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
}
