import { chromium, defineConfig, devices } from '@playwright/test';
import { resolveChromiumExecutable } from './scripts/browser-executable.mjs';

const executableResolution = resolveChromiumExecutable({
  managedExecutablePath: chromium.executablePath(),
});

export default defineConfig({
  testDir: './tests/browser-next',
  outputDir: './test-results/browser-next',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.NEXT_BASE_URL ?? 'http://127.0.0.1:3012',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: executableResolution.path
      ? { executablePath: executableResolution.path }
      : undefined,
  },
  workers: 1,
  webServer: [
    {
      name: 'Human Bingo mock API',
      command: 'node scripts/mock-game-api.mjs',
      url: 'http://127.0.0.1:3013/test/health',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      name: 'Human Bingo Next.js',
      command:
        'API_PROXY_TARGET=http://127.0.0.1:3013 npm run build:web && WEB_PORT=3012 npm run start:web',
      url: process.env.NEXT_BASE_URL ?? 'http://127.0.0.1:3012',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
  ],
});
