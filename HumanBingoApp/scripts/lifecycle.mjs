import './load-env.mjs';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url);
const envValue = (name, fallback) => process.env[name]?.trim() || fallback;

export function buildCommands(mode, env = process.env) {
  const apiCommand = envValueFrom(env, 'API_RUNTIME_COMMAND', 'node packages/api/dist/server.js');
  const browserCommand = envValueFrom(env, 'BROWSER_DEV_COMMAND', 'vite --config vite.config.ts');
  const previewCommand = envValueFrom(env, 'BROWSER_PREVIEW_COMMAND', 'vite preview');
  if (mode === 'dev') return [parseCommand(apiCommand), parseCommand(browserCommand)];
  if (mode === 'start') return [parseCommand(apiCommand)];
  if (mode === 'preview') return [parseCommand(previewCommand)];
  throw new Error(`Unknown lifecycle mode: ${mode}`);
}

function envValueFrom(env, name, fallback) {
  return env[name]?.trim() || fallback;
}

function parseCommand(command) {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return { command: parts[0], args: parts.slice(1).map((part) => part.replace(/^"|"$/g, '')) };
}

export function runSupervised(commands, options = {}) {
  if (commands.length === 0) return Promise.resolve(0);
  const children = new Set();
  let settled = false;
  let firstFailure = 0;
  let resolveExit;
  const result = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const stop = (code = 0) => {
    for (const child of children) child.kill('SIGTERM');
    if (children.size === 0 && !settled) {
      settled = true;
      resolveExit(code);
    }
  };
  const finish = (code) => {
    if (settled) return;
    if (code !== 0) firstFailure ||= code || 1;
    children.clear();
    settled = true;
    resolveExit(firstFailure);
  };
  for (const spec of commands) {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: 'inherit',
      shell: false,
    });
    children.add(child);
    child.once('error', () => {
      firstFailure ||= 1;
      stop(firstFailure);
    });
    child.once('exit', (code, signal) => {
      children.delete(child);
      const exitCode = code ?? (signal ? 1 : 0);
      if (exitCode !== 0) {
        firstFailure ||= exitCode;
        stop(firstFailure);
      } else if (children.size === 0) finish(0);
    });
  }
  const onSignal = () => stop(0);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return result.finally(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });
}

export function bootstrapCommand(env = process.env) {
  return parseCommand(envValueFrom(env, 'DEV_BOOTSTRAP_COMMAND', 'node scripts/dev-bootstrap.mjs'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  try {
    if (mode === 'dev') {
      const bootstrapExit = await runSupervised([bootstrapCommand()]);
      if (bootstrapExit !== 0) {
        process.exitCode = bootstrapExit;
        process.exit();
      }
    }
    const commands = buildCommands(mode);
    const exitCode = await runSupervised(commands);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
