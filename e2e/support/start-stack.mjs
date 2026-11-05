/**
 * Starts the whole app for e2e: a fresh database, the fake Meta, API, worker and web. Its own
 * ports, database and queue prefix, so it cannot touch development data. The web app is a
 * production build: it is what ships, and it does not compile routes while tests wait.
 */
import { execSync, spawn } from 'node:child_process';
import {
  API_URL,
  APP_SECRET,
  DB_NAME,
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
  SMTP_URL: 'smtp://127.0.0.1:1025',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'localdev',
  S3_SECRET_ACCESS_KEY: 'localdev-secret',
};

execSync(`pnpm --filter @wacrm/db exec tsx scripts/prepare-test-db.ts ${DB_NAME}`, {
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
