/**
 * Outbound load: an integration sending replies through the public API, then the worker must send
 * every message to (fake) Meta.
 *
 *   k6 run load/send.js                          (50 a second for 1 minute)
 *   k6 run -e RATE=75 load/send.js
 *
 * Targets (infra/load-testing.md): under 0.5% errors and p95 under 300 ms for POST /v1/messages,
 * and every message handed to Meta within 2 minutes of the end with no failed job. The rate stays
 * under OUTBOUND_MPS_PER_NUMBER (80), the per-number limit, since all of it goes from one number.
 */
import { check } from 'k6';
import http from 'k6/http';
import {
  API,
  createWorkspace,
  customerNumber,
  disconnect,
  inboundWebhook,
  jsonHeaders,
  waitForDrain,
  workerMetrics,
} from './lib.js';

const RATE = Number(__ENV.RATE || 50);
const CUSTOMERS = Number(__ENV.CUSTOMERS || 200);

export const options = {
  setupTimeout: '300s',
  teardownTimeout: '300s',
  scenarios: {
    sends: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '1m',
      preAllocatedVUs: 30,
      maxVUs: 200,
    },
  },
  thresholds: {
    'http_req_failed{name:POST /v1/messages}': ['rate<0.005'],
    'http_req_duration{name:POST /v1/messages}': ['p(95)<300'],
  },
};

export function setup() {
  const ws = createWorkspace();
  // Customers write first, so free-form replies are inside the 24-hour window.
  for (let i = 0; i < CUSTOMERS; i++) inboundWebhook(ws, customerNumber(700000 + i), 'Hi');
  waitForDrain(['webhook-events', 'automation'], 240);
  const key = http.post(
    `${API}/api-keys`,
    JSON.stringify({ name: 'Load test', scopes: ['messages:send'] }),
    { headers: jsonHeaders(ws.token) },
  );
  if (key.status !== 201) throw new Error(`api key answered ${key.status}: ${key.body}`);
  return { ws, key: key.json('key'), before: workerMetrics().finished };
}

export default function ({ key }) {
  const to = `+${customerNumber(700000 + Math.floor(Math.random() * CUSTOMERS))}`;
  const res = http.post(
    `${API}/v1/messages`,
    JSON.stringify({ to, type: 'text', body: `Your order is on its way (${Date.now()})` }),
    { headers: jsonHeaders(key), tags: { name: 'POST /v1/messages' } },
  );
  check(res, { 'send accepted': (r) => r.status === 201 });
}

export function teardown({ ws, before }) {
  // Always free the number, even when the drain check fails, or the next test cannot connect it.
  try {
    const seconds = waitForDrain(['outbound-messages'], 120);
    console.log(`worker sent the backlog ${seconds.toFixed(1)} s after the load ended`);
    const after = workerMetrics().finished;
    const failed =
      (after['outbound-messages:failed'] || 0) - (before['outbound-messages:failed'] || 0);
    if (failed > 0) throw new Error(`${failed} outbound job attempt(s) failed during the run`);
  } finally {
    disconnect(ws);
  }
}
