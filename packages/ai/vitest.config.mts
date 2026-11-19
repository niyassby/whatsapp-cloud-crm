import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.mjs';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: coverage({ lines: 71, functions: 74, branches: 55, statements: 69 }),
  },
});
