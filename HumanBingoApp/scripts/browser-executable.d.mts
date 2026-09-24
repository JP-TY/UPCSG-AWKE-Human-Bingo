export type ChromiumExecutableSelection = {
  source: 'override' | 'system' | 'playwright-managed';
  path: string;
};

export type ChromiumExecutableCheck =
  | { status: 'PASS'; selection: ChromiumExecutableSelection }
  | { status: 'ENVIRONMENT_BLOCKED'; message: string };

export type ChromiumExecutableOptions = {
  executableOverride?: string;
  pathValue?: string;
  knownCandidates?: readonly string[];
  managedExecutablePath?: string;
  validateExecutable?: (filePath: string) => boolean;
  isUsableExecutable?: (filePath: string) => boolean;
};

export declare const knownSystemChromiumCandidates: readonly string[];
export declare const chromiumExecutableRemedies: readonly string[];
export declare class ChromiumExecutableError extends Error {}
export declare function isRegularExecutable(filePath: string): boolean;
export declare function canLaunchChromium(filePath: string): boolean;
export declare function resolveChromiumExecutable(
  options?: ChromiumExecutableOptions,
): ChromiumExecutableSelection;
export declare function checkChromiumExecutable(
  options?: ChromiumExecutableOptions,
): ChromiumExecutableCheck;
export declare function formatChromiumCheck(result: ChromiumExecutableCheck): string;
