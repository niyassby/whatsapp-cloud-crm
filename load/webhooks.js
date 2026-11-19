/**
 * Inbound load: signed Meta webhooks at a steady rate, then the worker must drain everything.
 *
 *   k6 run load/webhooks.js                      (200 a second for 2 minutes)
 *   k6 run -e RATE=400 -e DURATION=5m load/webhooks.js
 *
 * Targets (infra/load-testing.md): no refused webhook, p95 under 250 ms and p99 under 1 s for the
 * receiver, and the worker turns every event into an inbox message within 2 minutes of the end
 * with no failed job.
 */
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import {
  createWorkspace,
  customerNumber,
  disconnect,
  inboundWebhook,
  waitForDrain,
  workerMetrics,
} from './lib.js';

const RATE = Number(__ENV.RATE || 200);
const CUSTOMERS = Number(__ENV.CUSTOMERS || 2000);
const DRAIN_SECONDS = Number(__ENV.DRAIN_SECONDS || 120);
const accepted = new Counter('webhooks_accepted');

export const options = {
  setupTimeout: '60s',
  teardownTimeout: '300s',
  scenarios: {
    inbound: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
  },
  thresholds: {
    'http_req_failed{name:POST /webhooks/meta}': ['rate==0'],
    'http_req_duration{name:POST /webhooks/meta}': ['p(95)<250', 'p(99)<1000'],
    checks: ['rate==1'],
  },
};

export function setup() {
  const ws = createWorkspace();
  return { ws, before: workerMetrics().finished };
}

export default function ({ ws }) {
  const from = customerNumber(Math.floor(Math.random() * CUSTOMERS));
  const res = inboundWebhook(ws, from, `Load test message ${Date.now()}`);
  if (check(res, { 'webhook accepted': (r) => r.status === 200 })) accepted.add(1);
}

export function teardown({ ws, before }) {
  // Always free the number, even when the drain check fails, or the next test cannot connect it.
  try {
    const seconds = waitForDrain(['webhook-events', 'automation'], DRAIN_SECONDS);
    console.log(`worker drained the inbound backlog ${seconds.toFixed(1)} s after the load ended`);
    const after = workerMetrics().finished;
    const failed = (q) => (after[`${q}:failed`] || 0) - (before[`${q}:failed`] || 0);
    const failures = failed('webhook-events') + failed('automation');
    if (failures > 0) throw new Error(`${failures} inbound job attempt(s) failed during the run`);
  } finally {
    disconnect(ws);
  }
}
