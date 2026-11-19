/**
 * Dashboard load: agents working the inbox at once. Each virtual agent lists conversations, opens
 * one, reads its messages, looks at contacts and the dashboard, then pauses like a person.
 *
 *   k6 run load/dashboard.js                     (ramps to 100 agents)
 *   k6 run -e AGENTS=200 load/dashboard.js
 *
 * Targets (infra/load-testing.md): under 1% errors, p95 under 500 ms for every endpoint.
 */
import { check, sleep } from 'k6';
import http from 'k6/http';
import {
  API,
  createWorkspace,
  customerNumber,
  disconnect,
  inboundWebhook,
  jsonHeaders,
  waitForDrain,
} from './lib.js';

const AGENTS = Number(__ENV.AGENTS || 100);
const SEED = Number(__ENV.SEED_CONVERSATIONS || 300);

export const options = {
  setupTimeout: '300s',
  scenarios: {
    agents: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: AGENTS },
        { duration: __ENV.DURATION || '2m', target: AGENTS },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:GET /inbox/conversations}': ['p(95)<500'],
    'http_req_duration{name:GET /inbox/conversations/:id/messages}': ['p(95)<500'],
    'http_req_duration{name:GET /contacts}': ['p(95)<500'],
    'http_req_duration{name:GET /analytics/dashboard}': ['p(95)<500'],
    'http_req_duration{name:GET /auth/me}': ['p(95)<300'],
  },
};

export function setup() {
  const ws = createWorkspace();
  // A busy workspace: conversations with a few messages each.
  for (let i = 0; i < SEED; i++) {
    for (let m = 0; m < 3; m++) inboundWebhook(ws, customerNumber(500000 + i), `Seed ${m}`);
  }
  waitForDrain(['webhook-events', 'automation'], 240);
  return { ws };
}

export default function ({ ws }) {
  const headers = jsonHeaders(ws.token);
  const get = (path, name) => http.get(`${API}${path}`, { headers, tags: { name } });

  const me = get('/auth/me', 'GET /auth/me');
  check(me, { 'me 200': (r) => r.status === 200 });

  const list = get('/inbox/conversations?limit=30', 'GET /inbox/conversations');
  check(list, { 'list 200': (r) => r.status === 200 });
  const items = list.status === 200 ? list.json('items') : [];
  if (items && items.length > 0) {
    const pick = items[Math.floor(Math.random() * items.length)];
    const msgs = get(
      `/inbox/conversations/${pick.id}/messages?limit=50`,
      'GET /inbox/conversations/:id/messages',
    );
    check(msgs, { 'messages 200': (r) => r.status === 200 });
  }
  sleep(1 + Math.random());

  check(get('/contacts?limit=50', 'GET /contacts'), { 'contacts 200': (r) => r.status === 200 });
  if (Math.random() < 0.2) {
    check(get('/analytics/dashboard?days=7', 'GET /analytics/dashboard'), {
      'dashboard 200': (r) => r.status === 200,
    });
  }
  sleep(2 + Math.random() * 2);
}

export function teardown({ ws }) {
  disconnect(ws);
}
