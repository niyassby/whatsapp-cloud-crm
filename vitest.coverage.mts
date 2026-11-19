/**
 * Coverage settings shared by every package (Phase 4.5). `pnpm test:coverage` runs each suite with
 * V8 coverage over that package's own `src`, and fails when a package drops below its floor.
 *
 * Floors are set a little under what the suites measured when they were set (see CLAUDE.md), so
 * they catch a real drop without failing on noise. Raise them as tests are added; never lower one
 * to get a change through.
 */
import type { CoverageV8Options } from 'vitest/node';

export interface CoverageFloor {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

export const coverage = (floor: CoverageFloor, exclude: string[] = []) =>
  ({
    provider: 'v8',
    include: ['src/**/*.{ts,tsx}'],
    exclude: [
      'src/**/*.test.{ts,tsx}',
      'src/**/*.d.ts',
      'src/generated/**',
      // Process entry points: start-up wiring, exercised by e2e rather than unit tests.
      'src/main.ts',
      'src/scripts/**',
      ...exclude,
    ],
    reporter: ['text-summary', 'json-summary'],
    reportsDirectory: 'coverage',
    thresholds: { ...floor },
  }) satisfies CoverageV8Options & { provider: 'v8' };
