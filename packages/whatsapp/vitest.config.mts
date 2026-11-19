import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.mjs';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: coverage({ lines: 66, functions: 47, branches: 56, statements: 60 }),
  },
});
