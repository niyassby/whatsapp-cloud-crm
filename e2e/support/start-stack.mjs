/**
 * Starts the whole app for e2e: a fresh database, the fake Meta, API, worker and web. Its own
 * ports, database and queue prefix, so it cannot touch development data. The web app is a
 * production build: it is what ships, and it does not compile routes while tests wait.
 */
import { execSync, spawn } from 'node:child_process';
import {
  API_URL,
  APP_SECRET,
  STRIPE_WEBHOOK_SECRET,
  DB_NAME,
  IG_APP_SECRET,
  PORTS,
  QUEUE_PREFIX,
  VERIFY_TOKEN,
  WEB_URL,
} from './config.mjs';

const pg = (user) => `postgresql://${user}:${user}@127.0.0.1:5433/${DB_NAME}`;

const env = {
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  DATABASE_URL: pg('wacrm_app'),
  DIRECT_URL: pg('wacrm'),
  TEST_DATABASE_URL: pg('wacrm_app'),
  TEST_DIRECT_URL: pg('wacrm'),
  REDIS_URL: 'redis://127.0.0.1:6379',
  QUEUE_PREFIX,
  TRUST_PROXY: 'true',
  WEB_URL,
  API_PORT: String(PORTS.api),
  WORKER_HEALTH_PORT: String(PORTS.worker),
  NEXT_PUBLIC_API_URL: API_URL,
  JWT_ACCESS_SECRET: 'dev-only-e2e-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'dev-only-e2e-refresh-secret-0123456789abcde',
  ENCRYPTION_KEY: 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=',
  META_APP_ID: 'e2e-app',
  META_APP_SECRET: APP_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  META_GRAPH_BASE_URL: `http://127.0.0.1:${PORTS.graph}`,
  INSTAGRAM_APP_ID: 'e2e-ig-app',
  INSTAGRAM_APP_SECRET: IG_APP_SECRET,
  INSTAGRAM_BASE_URL: `http://127.0.0.1:${PORTS.graph}/ig`,
  WEBHOOK_ALLOW_PRIVATE_URLS: 'true',
  INTEGRATIONS_DEMO: 'true',
  // Deterministic AI with no network: hashed word vectors and answers from the best passage.
  AI_PROVIDER: 'fake',
  AI_EMBEDDINGS_PROVIDER: 'fake',
  API_PUBLIC_URL: API_URL,
  STRIPE_SECRET_KEY: 'sk_test_e2e',
  STRIPE_WEBHOOK_SECRET,
  STRIPE_API_BASE: `http://127.0.0.1:${PORTS.payments}`,
  SMTP_URL: 'smtp://127.0.0.1:1025',
  // Reports read aggregates; recompute them every few seconds so a test sees its own messages.
  ANALYTICS_ROLLUP_EVERY_MS: '3000',
  // One address and fast browsers: the production limits would trip on the suite itself.
  RATE_LIMIT_IP_PER_MINUTE: '100000',
  RATE_LIMIT_USER_PER_MINUTE: '100000',
  // Every browser in the suite logs in from 127.0.0.1; the suite does more than 30 in 15 minutes.
  RATE_LIMIT_LOGIN_PER_IP: '100000',
  // Signed media links point at the local S3; the web CSP must allow it.
  MEDIA_PUBLIC_ORIGINS: 'http://localhost:9000',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'localdev',
  S3_SECRET_ACCESS_KEY: 'localdev-secret',
};

execSync(`pnpm --filter @wacrm/db exec tsx scripts/prepare-test-db.ts ${DB_NAME}`, {
  env,
  stdio: 'inherit',
});

// A fresh database deserves fresh counters: earlier runs from 127.0.0.1 would otherwise count.
execSync('node e2e/support/clear-rate-limits.mjs', { env, stdio: 'inherit' });

execSync('pnpm --filter @wacrm/db exec tsx scripts/rates-import.ts prisma/sample-rate-cards.csv', {
  env,
  stdio: 'inherit',
});

execSync('pnpm --filter @wacrm/db exec tsx scripts/plans-import.ts prisma/sample-plans.json', {
  env,
  stdio: 'inherit',
});

const webEnv = { ...env, NODE_ENV: 'production' };
execSync('pnpm --filter @wacrm/web exec next build', { env: webEnv, stdio: 'inherit' });

const procs = [];
const start = (cmd, args, procEnv = env) =>
  procs.push(
    spawn(cmd, args, { env: procEnv, stdio: 'inherit', shell: process.platform === 'win32' }),
  );

async function waitFor(url) {
  for (let i = 0; i < 240; i++) {
    const up = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not become ready`);
}

start('node', ['e2e/support/fake-graph.mjs']);
start('node', ['e2e/support/fake-payments.mjs']);
start('pnpm', [
  '--filter',
  '@wacrm/api',
  'exec',
  'node',
  '-r',
  '@swc-node/register',
  'src/main.ts',
]);
start('pnpm', ['--filter', '@wacrm/worker', 'exec', 'tsx', 'src/main.ts']);
await waitFor(`http://127.0.0.1:${PORTS.api}/health/ready`);
await waitFor(`http://127.0.0.1:${PORTS.worker}/health`);
// Last: Playwright waits on the web app, so it being up means the whole stack is up.
start('pnpm', ['--filter', '@wacrm/web', 'exec', 'next', 'start', '-p', String(PORTS.web)], webEnv);

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
