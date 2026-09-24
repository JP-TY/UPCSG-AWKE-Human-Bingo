import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'property',
    include: ['tests/property/**/*.property.test.ts', 'packages/**/src/**/*.property.test.ts'],
    setupFiles: ['./tests/setup/vitest.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage/property',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.property.test.ts'],
    },
  },
});
