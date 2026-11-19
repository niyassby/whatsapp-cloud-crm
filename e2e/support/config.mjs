/**
 * Everything the e2e stack and the specs agree on. Fake values only: nothing here is a secret.
 *
 * By default the suite starts its own stack (start-stack.mjs). With E2E_EXTERNAL=1 it runs against
 * an environment deployed from infra/deployment.md instead, named by the E2E_* variables below; the
 * fakes still run beside the suite (e2e/support/start-fakes.mjs), and the deployment points at them.
 */
const env = process.env;
export const PORTS = { web: 3100, api: 4100, worker: 4101, graph: 4199, payments: 4198 };
export const EXTERNAL = env.E2E_EXTERNAL === '1';
export const WEB_URL = env.E2E_WEB_URL ?? `http://localhost:${PORTS.web}`;
export const API_URL = env.E2E_API_URL ?? `http://localhost:${PORTS.api}`;
export const APP_SECRET = 'e2e-app-secret';
export const VERIFY_TOKEN = 'e2e-verify-token';
export const STRIPE_WEBHOOK_SECRET = 'whsec_e2e';
export const DB_NAME = 'wacrm_e2e_test';
/** Owner connection for operator scripts the suite runs (wallet credit, admin grant). */
export const OPERATOR_DIRECT_URL =
  env.E2E_DIRECT_URL ?? `postgresql://wacrm:wacrm@127.0.0.1:5433/${DB_NAME}`;
/** Mailpit's API, where the deployment's SMTP_URL delivers. */
export const MAILPIT_API = env.E2E_MAILPIT_API ?? 'http://127.0.0.1:8025/api/v1';
/** Where the suite reaches the fakes, and where they listen. */
export const FAKES_HOST = env.E2E_FAKES_HOST ?? '127.0.0.1';
export const QUEUE_PREFIX = 'wacrm-e2e';
/** Sending to this number makes the fake Meta report a delivery failure. */
export const FAILING_RECIPIENT = '919800000099';
export const FAILURE_TEXT = 'Message undeliverable';
/** Signs fake Instagram webhooks. Fake value. */
export const IG_APP_SECRET = 'e2e-instagram-secret';
/** The fake Instagram professional account. */
export const IG_ACCOUNT_ID = '17841499999990001';
