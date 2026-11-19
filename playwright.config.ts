import { defineConfig, devices } from '@playwright/test';
import { EXTERNAL, PORTS, WEB_URL } from './e2e/support/config.mjs';

/**
 * Needs the local services and built packages (`pnpm build`). E2E_EXTERNAL=1 runs the same suite
 * against a deployed environment instead (infra/deployment.md, "Verify a deployment").
 */
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
  webServer: EXTERNAL
    ? {
        // Against a deployed environment (infra/deployment.md): only the fakes run here.
        command: 'node e2e/support/start-fakes.mjs',
        url: `http://127.0.0.1:${PORTS.graph}/__health`,
        timeout: 30_000,
        reuseExistingServer: process.env.E2E_REUSE === '1',
        stdout: 'pipe',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      }
    : {
        command: 'node e2e/support/start-stack.mjs',
        url: `${WEB_URL}/health`,
        // Migrations, imports and a production build come first; the build alone has taken 10 minutes here.
        timeout: 900_000,
        // E2E_REUSE=1 uses a stack already started with `node e2e/support/start-stack.mjs`, to iterate quickly.
        reuseExistingServer: process.env.E2E_REUSE === '1',
        stdout: 'pipe',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      },
});
