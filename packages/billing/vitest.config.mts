import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.mjs';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: coverage({ lines: 86, functions: 77, branches: 79, statements: 82 }),
  },
});
