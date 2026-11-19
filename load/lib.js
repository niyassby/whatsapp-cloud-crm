/**
 * Shared setup for the k6 load tests (Phase 4.5). See infra/load-testing.md.
 *
 * The tests run against a stack whose Meta and Stripe are the e2e fakes: a local e2e stack
 * (`node e2e/support/start-stack.mjs`) or a staging deployment with STAGING_TEST_DOUBLES
 * (infra/deployment.md). They never touch a real Meta account.
 */
import { sleep } from 'k6';
import crypto from 'k6/crypto';
import http from 'k6/http';

export const API = __ENV.API_URL || 'http://localhost:4100';
export const APP_SECRET = __ENV.APP_SECRET || 'e2e-app-secret';
export const WORKER = __ENV.WORKER_URL || 'http://127.0.0.1:4101';
const METRICS_TOKEN = __ENV.METRICS_TOKEN || '';

const randomIp = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const randomDigits = (n) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

export const jsonHeaders = (token) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

function must(res, what) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what} answered ${res.status}: ${String(res.body).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

/** The fake Meta's one phone number. A number is live in one workspace at a time, so the load
 * tests run one after another, not alongside the e2e suite; each frees it in teardown. */
const PHONE_NUMBER_ID = '200000000000888';

/** A fresh workspace (random WABA id) with the fake number connected. */
export function createWorkspace() {
  const tag = randomDigits(8);
  const signup = must(
    http.post(
      `${API}/auth/signup`,
      JSON.stringify({
        name: 'Load Test',
        email: `load-${tag}@load.test`,
        password: 'load-test-password-1',
        orgName: `Load ${tag}`,
      }),
      // Signups are limited per address; the target must trust the forwarded address.
      { headers: { ...jsonHeaders(), 'x-forwarded-for': randomIp() } },
    ),
    'signup',
  );
  const token = signup.accessToken;
  const wabaId = `${randomDigits(12)}777`;
  const phone = must(
    http.post(
      `${API}/whatsapp/manual-connect`,
      JSON.stringify({
        accessToken: 'fake-token-for-the-e2e-graph-server',
        wabaId,
        phoneNumberId: PHONE_NUMBER_ID,
      }),
      { headers: jsonHeaders(token) },
    ),
    'connect',
  );
  return { token, wabaId, phoneNumberId: phone.phoneNumberId, phoneId: phone.id };
}

/** Frees the fake number for the next test. No content type: the API refuses an empty JSON body. */
export function disconnect(ws) {
  const res = http.del(`${API}/whatsapp/phone-numbers/${ws.phoneId}`, null, {
    headers: { authorization: `Bearer ${ws.token}` },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`disconnect answered ${res.status}: ${String(res.body).slice(0, 200)}`);
  }
}

/** A signed inbound text, exactly as Meta delivers it. */
export function inboundWebhook(ws, from, text) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: ws.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550100888', phone_number_id: ws.phoneNumberId },
              contacts: [{ profile: { name: `Customer ${from.slice(-4)}` }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.LOAD.${randomDigits(20)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature = crypto.hmac('sha256', APP_SECRET, body, 'hex');
  return http.post(`${API}/webhooks/meta`, body, {
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    tags: { name: 'POST /webhooks/meta' },
  });
}

export const customerNumber = (i) => `9190${String(i).padStart(8, '0')}`;

/** Reads the worker's metrics: jobs per queue and state, and finished jobs per queue and result. */
export function workerMetrics() {
  const res = http.get(`${WORKER}/metrics`, {
    headers: METRICS_TOKEN ? { authorization: `Bearer ${METRICS_TOKEN}` } : {},
    tags: { name: 'worker metrics' },
  });
  if (res.status !== 200) throw new Error(`worker metrics answered ${res.status}`);
  const depth = {};
  const finished = {};
  for (const line of String(res.body).split('\n')) {
    let m = /^wacrm_queue_jobs\{queue="([^"]+)",state="([^"]+)"[^}]*\} (\d+)/.exec(line);
    if (m) depth[`${m[1]}:${m[2]}`] = Number(m[3]);
    m = /^wacrm_jobs_total\{queue="([^"]+)",result="([^"]+)"[^}]*\} (\d+)/.exec(line);
    if (m) finished[`${m[1]}:${m[2]}`] = Number(m[3]);
  }
  return { depth, finished };
}

/**
 * Waits until the named queues have nothing waiting, active or delayed (a parked send counts), and returns how long it took.
 * Throws after `limitSeconds`, which fails the run.
 */
export function waitForDrain(queues, limitSeconds) {
  const start = Date.now();
  for (;;) {
    const { depth } = workerMetrics();
    const states = ['waiting', 'active', 'prioritized', 'delayed'];
    const left = queues.reduce(
      (sum, q) => sum + states.reduce((n, st) => n + (depth[`${q}:${st}`] || 0), 0),
      0,
    );
    const seconds = (Date.now() - start) / 1000;
    if (left === 0) return seconds;
    if (seconds > limitSeconds) {
      throw new Error(
        `${left} job(s) still queued in ${queues.join(', ')} after ${limitSeconds} s`,
      );
    }
    sleep(1);
  }
}
