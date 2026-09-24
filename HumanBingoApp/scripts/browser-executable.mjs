import { execFileSync } from 'node:child_process';
import { constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const knownSystemChromiumCandidates = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

const browserRemedies = [
  'sudo pacman -S chromium',
  'npm run test:browser:install',
  'set PLAYWRIGHT_EXECUTABLE_PATH to a corrected executable path',
];

export class ChromiumExecutableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChromiumExecutableError';
  }
}

const remediationMessage = () => `Remedies: ${browserRemedies.join('; ')}.`;

export const chromiumExecutableRemedies = [...browserRemedies];

export function isRegularExecutable(filePath) {
  if (!filePath) return false;

  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (stats.mode & constants.S_IXUSR) !== 0;
  } catch {
    return false;
  }
}

export function canLaunchChromium(filePath) {
  if (!isRegularExecutable(filePath)) return false;

  try {
    const output = execFileSync(filePath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      windowsHide: true,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function defaultPathCandidates(pathValue) {
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  return (pathValue ?? process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)));
}

function unique(values) {
  return [...new Set(values)];
}

function invalidOverrideMessage(pathValue) {
  return [
    `PLAYWRIGHT_EXECUTABLE_PATH is not a usable Chromium executable: ${pathValue}.`,
    'The override must name a regular executable file that responds to --version.',
    remediationMessage(),
  ].join(' ');
}

function unavailableMessage() {
  return ['No usable Chromium executable was found for browser checks.', remediationMessage()].join(
    ' ',
  );
}

/**
 * Resolve a Chromium executable without starting a browser or invoking a shell.
 * The injectable values keep selection and validation deterministic in unit tests.
 */
export function resolveChromiumExecutable({
  executableOverride = process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  pathValue = process.env.PATH,
  knownCandidates = knownSystemChromiumCandidates,
  managedExecutablePath,
  validateExecutable = canLaunchChromium,
  isUsableExecutable = (candidate) =>
    isRegularExecutable(candidate) && validateExecutable(candidate),
} = {}) {
  const override = executableOverride?.trim();
  if (override) {
    if (!isUsableExecutable(override)) {
      throw new ChromiumExecutableError(invalidOverrideMessage(override));
    }
    return { source: 'override', path: override };
  }

  const systemCandidates = unique([...defaultPathCandidates(pathValue), ...knownCandidates]);
  const systemPath = systemCandidates.find((candidate) => isUsableExecutable(candidate));
  if (systemPath) return { source: 'system', path: systemPath };

  if (managedExecutablePath && isUsableExecutable(managedExecutablePath)) {
    return { source: 'playwright-managed', path: managedExecutablePath };
  }

  throw new ChromiumExecutableError(unavailableMessage());
}

export function checkChromiumExecutable(options = {}) {
  try {
    return { status: 'PASS', selection: resolveChromiumExecutable(options) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'ENVIRONMENT_BLOCKED', message };
  }
}

export function formatChromiumCheck(result) {
  if (result.status === 'PASS') {
    return [
      'CHROMIUM_CHECK=PASS',
      `CHROMIUM_SOURCE=${result.selection.source}`,
      `CHROMIUM_PATH=${result.selection.path}`,
    ].join('\n');
  }

  return ['CHROMIUM_CHECK=ENVIRONMENT_BLOCKED', `CHROMIUM_MESSAGE=${result.message}`].join('\n');
}
