import { describe, expect, it } from 'vitest';

type BrowserCheckResult =
  | { status: 'PASS'; selection: { source: string; path: string } }
  | { status: 'ENVIRONMENT_BLOCKED'; message: string };

type BrowserExecutableModule = {
  canLaunchChromium: (filePath: string) => boolean;
  checkChromiumExecutable: (options?: Record<string, unknown>) => BrowserCheckResult;
  formatChromiumCheck: (result: BrowserCheckResult) => string;
  isRegularExecutable: (filePath: string) => boolean;
  resolveChromiumExecutable: (options?: Record<string, unknown>) => {
    source: string;
    path: string;
  };
};

const browserExecutable = (await import(
  '../../scripts/browser-executable.mjs'
)) as BrowserExecutableModule;

const resolve = (options: Record<string, unknown>) =>
  browserExecutable.resolveChromiumExecutable({
    ...options,
    isUsableExecutable:
      (options.isUsableExecutable as ((candidate: string) => boolean) | undefined) ?? (() => true),
  });

describe('Chromium executable resolution', () => {
  it('requires a regular executable and confirms it responds to --version', () => {
    expect(browserExecutable.isRegularExecutable(process.execPath)).toBe(true);
    expect(browserExecutable.canLaunchChromium(process.execPath)).toBe(true);
    expect(browserExecutable.isRegularExecutable('/not/a/real/executable')).toBe(false);
  });

  it('selects a usable explicit override before system and managed candidates', () => {
    expect(
      resolve({
        executableOverride: '/custom/chromium',
        pathValue: '/system/bin',
        knownCandidates: ['/usr/bin/chromium'],
        managedExecutablePath: '/managed/chromium',
      }),
    ).toEqual({ source: 'override', path: '/custom/chromium' });
  });

  it('rejects an invalid explicit override with actionable remedies instead of falling back', () => {
    expect(() =>
      resolve({
        executableOverride: '/invalid/chromium',
        isUsableExecutable: () => false,
        managedExecutablePath: '/managed/chromium',
      }),
    ).toThrow(
      /\/invalid\/chromium.*sudo pacman -S chromium.*npm run test:browser:install.*PLAYWRIGHT_EXECUTABLE_PATH/,
    );
  });

  it('selects a usable known Arch Chromium candidate', () => {
    expect(
      resolve({
        executableOverride: '',
        pathValue: '',
        knownCandidates: ['/usr/bin/chromium'],
        managedExecutablePath: '/managed/chromium',
      }),
    ).toEqual({ source: 'system', path: '/usr/bin/chromium' });
  });

  it('discovers a usable Chromium candidate from PATH before managed Chromium', () => {
    expect(
      resolve({
        executableOverride: '',
        pathValue: '/first/bin:/second/bin',
        knownCandidates: [],
        managedExecutablePath: '/managed/chromium',
        isUsableExecutable: (candidate: string) => candidate === '/second/bin/chromium',
      }),
    ).toEqual({ source: 'system', path: '/second/bin/chromium' });
  });

  it('falls back to Playwright-managed Chromium when no system candidate is usable', () => {
    expect(
      resolve({
        executableOverride: '',
        pathValue: '',
        knownCandidates: [],
        managedExecutablePath: '/managed/chromium',
        isUsableExecutable: (candidate: string) => candidate === '/managed/chromium',
      }),
    ).toEqual({ source: 'playwright-managed', path: '/managed/chromium' });
  });

  it('reports the selected source and path as a machine-readable PASS result', () => {
    const result = browserExecutable.checkChromiumExecutable({
      executableOverride: '/custom/chromium',
      pathValue: '/system/bin',
      knownCandidates: ['/usr/bin/chromium'],
      managedExecutablePath: '/managed/chromium',
      isUsableExecutable: (candidate: string) => candidate === '/custom/chromium',
    });

    expect(result).toEqual({
      status: 'PASS',
      selection: { source: 'override', path: '/custom/chromium' },
    });
    expect(browserExecutable.formatChromiumCheck(result)).toBe(
      'CHROMIUM_CHECK=PASS\nCHROMIUM_SOURCE=override\nCHROMIUM_PATH=/custom/chromium',
    );
  });

  it('classifies an invalid explicit override as environment-blocked without fallback', () => {
    const result = browserExecutable.checkChromiumExecutable({
      executableOverride: '/invalid/chromium',
      pathValue: '/system/bin',
      knownCandidates: ['/usr/bin/chromium'],
      managedExecutablePath: '/managed/chromium',
      isUsableExecutable: () => false,
    });

    expect(result.status).toBe('ENVIRONMENT_BLOCKED');
    expect(browserExecutable.formatChromiumCheck(result)).toContain(
      'CHROMIUM_CHECK=ENVIRONMENT_BLOCKED',
    );
    expect(browserExecutable.formatChromiumCheck(result)).toContain(
      'CHROMIUM_MESSAGE=PLAYWRIGHT_EXECUTABLE_PATH is not a usable Chromium executable: /invalid/chromium.',
    );
    expect(browserExecutable.formatChromiumCheck(result)).toContain('sudo pacman -S chromium');
  });

  it('reports an environment-blocked result and machine-readable remedy when none is usable', () => {
    const result = browserExecutable.checkChromiumExecutable({
      executableOverride: '',
      pathValue: '',
      knownCandidates: [],
      managedExecutablePath: '',
      isUsableExecutable: () => false,
    });

    expect(result).toMatchObject({ status: 'ENVIRONMENT_BLOCKED' });
    expect(browserExecutable.formatChromiumCheck(result)).toContain(
      'CHROMIUM_CHECK=ENVIRONMENT_BLOCKED',
    );
    expect(browserExecutable.formatChromiumCheck(result)).toContain('sudo pacman -S chromium');
    expect(browserExecutable.formatChromiumCheck(result)).toContain('npm run test:browser:install');
    expect(browserExecutable.formatChromiumCheck(result)).toContain('PLAYWRIGHT_EXECUTABLE_PATH');
  });
});
