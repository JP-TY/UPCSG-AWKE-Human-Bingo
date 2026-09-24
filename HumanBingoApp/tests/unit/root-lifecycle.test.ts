import { describe, expect, it } from 'vitest';

// The lifecycle module is intentionally JavaScript so it can supervise future runtime commands
// before the TypeScript packages have been built.
type LifecycleCommand = { command: string; args: string[] };
type LifecycleModule = {
  buildCommands(mode: string, env?: Record<string, string | undefined>): LifecycleCommand[];
  runSupervised(
    commands: LifecycleCommand[],
    options?: { cwd?: URL | string; env?: NodeJS.ProcessEnv },
  ): Promise<number>;
};

const lifecycle = (await import('../../scripts/lifecycle.mjs')) as unknown as LifecycleModule;

describe('root lifecycle commands', () => {
  it('starts API and browser development processes together', () => {
    expect(lifecycle.buildCommands('dev', {})).toEqual([
      { command: 'node', args: ['packages/api/dist/server.js'] },
      { command: 'vite', args: ['--config', 'vite.config.ts'] },
    ]);
  });

  it('starts only the API for production start', () => {
    expect(
      lifecycle.buildCommands('start', { API_RUNTIME_COMMAND: 'node custom-api.mjs' }),
    ).toEqual([{ command: 'node', args: ['custom-api.mjs'] }]);
  });

  it('uses the browser preview command without an API child', () => {
    expect(
      lifecycle.buildCommands('preview', {
        BROWSER_PREVIEW_COMMAND: 'vite preview --host 127.0.0.1',
      }),
    ).toEqual([{ command: 'vite', args: ['preview', '--host', '127.0.0.1'] }]);
  });

  it('returns a failed child exit code to the supervisor', async () => {
    const result = await lifecycle.runSupervised([
      { command: process.execPath, args: ['-e', 'process.exit(7)'] },
    ]);
    expect(result).toBe(7);
  });
});
