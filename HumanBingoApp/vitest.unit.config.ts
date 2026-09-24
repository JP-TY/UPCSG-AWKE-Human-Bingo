import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    include: ['tests/unit/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    exclude: ['tests/property/**', 'tests/integration/**'],
    setupFiles: ['./tests/setup/vitest.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage/unit',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    },
  },
});
