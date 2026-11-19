/**
 * The fakes alone, for running the suite against a deployed environment (E2E_EXTERNAL=1, see
 * infra/deployment.md, "Verify a deployment"). The deployment's META_GRAPH_BASE_URL,
 * INSTAGRAM_BASE_URL and STRIPE_API_BASE point here, and the fakes send their signed webhooks to
 * E2E_API_URL. Nothing else is started: the database, API, worker and web app are the deployment's.
 */
import { spawn } from 'node:child_process';

const procs = ['e2e/support/fake-graph.mjs', 'e2e/support/fake-payments.mjs'].map((file) =>
  spawn('node', [file], { env: process.env, stdio: 'inherit' }),
);
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
