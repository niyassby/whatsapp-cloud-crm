import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.mjs';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: coverage({ lines: 78, functions: 79, branches: 60, statements: 75 }),
  },
});
