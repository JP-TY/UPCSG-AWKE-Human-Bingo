import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.test.ts', 'packages/**/src/**/*.integration.test.ts'],
    setupFiles: ['./tests/setup/vitest.ts'],
    globalSetup: ['./tests/setup/database-global.ts'],
    environment: 'node',
    // Integration suites share one test database and spawn servers; parallel
    // files would truncate each other's rows and fight for ports.
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage/integration',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.integration.test.ts'],
    },
  },
});
