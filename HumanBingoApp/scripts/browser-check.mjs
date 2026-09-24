import { chromium } from '@playwright/test';
import { checkChromiumExecutable, formatChromiumCheck } from './browser-executable.mjs';

const result = checkChromiumExecutable({
  managedExecutablePath: chromium.executablePath(),
});

console.log(formatChromiumCheck(result));
if (result.status !== 'PASS') process.exitCode = 1;
