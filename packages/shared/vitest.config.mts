import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.mjs';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: coverage({ lines: 71, functions: 63, branches: 64, statements: 70 }),
  },
});
