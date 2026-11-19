import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.mjs';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: coverage({ lines: 86, functions: 88, branches: 69, statements: 83 }),
  },
});
