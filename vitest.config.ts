import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/shared/tests/**/*.test.ts', 'apps/api/tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/api/tests/integration/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
          globalSetup: ['apps/api/tests/integration/global-setup.ts'],
        },
      },
    ],
  },
});
