/** Everything the e2e stack and the specs agree on. Fake values only: nothing here is a secret. */
export const PORTS = { web: 3100, api: 4100, worker: 4101, graph: 4199, payments: 4198 };
export const WEB_URL = `http://localhost:${PORTS.web}`;
export const API_URL = `http://localhost:${PORTS.api}`;
export const APP_SECRET = 'e2e-app-secret';
export const VERIFY_TOKEN = 'e2e-verify-token';
export const STRIPE_WEBHOOK_SECRET = 'whsec_e2e';
export const DB_NAME = 'wacrm_e2e_test';
export const QUEUE_PREFIX = 'wacrm-e2e';
/** Sending to this number makes the fake Meta report a delivery failure. */
export const FAILING_RECIPIENT = '919800000099';
export const FAILURE_TEXT = 'Message undeliverable';
