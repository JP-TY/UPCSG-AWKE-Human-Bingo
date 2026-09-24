import { chromium, defineConfig, devices } from '@playwright/test';
import { resolveChromiumExecutable } from './scripts/browser-executable.mjs';

const executableResolution = resolveChromiumExecutable({
  managedExecutablePath: chromium.executablePath(),
});
const executablePath = executableResolution.path;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const webServerCommand =
  process.env.PLAYWRIGHT_WEB_SERVER_COMMAND?.trim() ||
  'node node_modules/vite/bin/vite.js build --config vite.config.ts && node node_modules/vite/bin/vite.js preview --config vite.config.ts';
const webServerURL = process.env.PLAYWRIGHT_WEB_SERVER_URL?.trim() || baseURL;

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './test-results/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: webServerCommand
    ? {
        command: webServerCommand,
        url: webServerURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
});
