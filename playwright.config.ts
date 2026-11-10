import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './e2e/support/config.mjs';

/** Needs `pnpm docker:up` and built packages (`pnpm build`). */
export default defineConfig({
  testDir: './e2e',
  // Next compiles each route on first visit in dev mode.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { baseURL: WEB_URL, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: {
    command: 'node e2e/support/start-stack.mjs',
    url: `${WEB_URL}/health`,
    // Migrations, imports and a production build come first; the build alone has taken 10 minutes here.
    timeout: 900_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
});
