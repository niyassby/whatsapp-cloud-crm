# Load testing

k6 scripts in [load/](../load/) put the three paths that carry real traffic under load, and fail when a target is missed. They run against a stack whose Meta and Stripe are the e2e fakes, never real accounts:

- a staging deployment with `STAGING_TEST_DOUBLES` ([deployment.md, section 9](deployment.md#9-verify-a-deployment)), with the fakes running beside k6 (`node e2e/support/start-fakes.mjs`), or
- the local e2e stack (`node e2e/support/start-stack.mjs`).

Install k6 from https://grafana.com/docs/k6/latest/set-up/install-k6/ (Windows: `winget install GrafanaLabs.k6`).

## Targets

| Test           | Load                                                                                                                               | Target                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks.js`  | 200 signed Meta webhooks a second for 2 minutes, from 2,000 customers                                                              | No webhook refused. Receiver p95 under 250 ms, p99 under 1 s. Every event processed (inbox message, rules) within 2 minutes of the end, with no failed job. |
| `dashboard.js` | Ramp to 100 agents, each reading the inbox, a conversation, contacts and sometimes the dashboard, with human pauses, for 2 minutes | Under 1% errors. p95 under 500 ms for the conversation list, messages, contacts and dashboard; under 300 ms for `/auth/me`.                                 |
| `send.js`      | 50 public API sends a second for 1 minute, to 200 customers                                                                        | Under 0.5% errors. p95 under 300 ms. Every message handed to Meta within 2 minutes of the end, with no failed job.                                          |

Why these numbers: 200 inbound messages a second is about 17 million a day, far above a first launch; 100 agents working at once is a large team or several medium ones; 50 sends a second stays under the per-number limit (`OUTBOUND_MPS_PER_NUMBER`, 80), since all of it goes from one number. Broadcast throughput was measured separately in Phase 2.4 (about 23 messages a second per campaign on the development PC).

## Running

The variables name the target; the defaults are the local e2e stack's ports.

```sh
k6 run -e API_URL=http://localhost:4300 -e WORKER_URL=http://127.0.0.1:4301 -e METRICS_TOKEN=<token> load/webhooks.js
k6 run -e API_URL=http://localhost:4300 -e WORKER_URL=http://127.0.0.1:4301 -e METRICS_TOKEN=<token> load/dashboard.js
k6 run -e API_URL=http://localhost:4300 -e WORKER_URL=http://127.0.0.1:4301 -e METRICS_TOKEN=<token> load/send.js
```

| Variable                       | Meaning                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `API_URL`                      | The API under test                                                       |
| `WORKER_URL`                   | A worker's health port, for the drain checks (reads `/metrics`)          |
| `METRICS_TOKEN`                | The worker's `METRICS_TOKEN`, if set                                     |
| `APP_SECRET`                   | The Meta app secret the target verifies webhooks with (`e2e-app-secret`) |
| `RATE`, `DURATION`             | Override the load (webhooks and send)                                    |
| `AGENTS`, `SEED_CONVERSATIONS` | Override the dashboard load                                              |

Each test creates its own workspace, connects the fake Meta's one number to it, and disconnects it at the end, so run the tests one at a time and not during an e2e run. If a run is killed before its teardown, disconnect that number (Settings > WhatsApp in the load test's workspace, or the workspace is simply abandoned on a staging reset). The target needs `TRUST_PROXY=true` and the request limits raised, as in the staging settings, since every virtual user comes from one address.

## Results

Recorded on the development PC: Windows 11, 8 GB RAM, everything on one machine (PostgreSQL 18, Memurai, one API process, one worker process with `WORKER_CONCURRENCY=10`, k6 and the fakes), against the staging deployment of 2026-11-19 (a production build, `NODE_ENV=production`). Nothing here had a machine of its own, so these are a floor, not the platform's capacity.

**The full targets were not met on this PC.** At target rates it is the single development machine that runs out, as the numbers below show; the targets stay as they are and must be checked on the production hardware before launch (deployment guide, launch checklist).

| Test      | Load                    | Result                                                                                                                                                               | Target met |
| --------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| webhooks  | 200 a second, 1 worker  | 0 refused, but receiver p95 3.7 s and p99 10.5 s; k6 dropped 4,303 sends; 13,673 jobs still queued 2 minutes after the end (first run, before the contact fix below) | No         |
| webhooks  | 100 a second, 1 worker  | 0 refused, receiver p95 4.1 ms, p99 25 ms; worker processed about 45 to 50 a second, 1,302 jobs left after 2 minutes                                                 | No (drain) |
| webhooks  | 100 a second, 2 workers | 0 refused, receiver p95 13 ms, p99 166 ms; drained 83 s after the end; no failed job                                                                                 | Yes        |
| webhooks  | 50 a second, 1 worker   | 0 refused, receiver p95 4.2 ms, p99 25 ms; drained 5 s after the end; no failed job                                                                                  | Yes        |
| dashboard | 100 agents              | 0 errors in 14,002 requests; p95: conversations 104 ms, messages 109 ms, contacts 83 ms, dashboard 145 ms, `/auth/me` 116 ms                                         | Yes        |
| send      | 50 a second             | 0 errors, but the API served about 38 a second, so requests queued: p95 5.3 s, 573 dropped. Worker sent everything within 1 s of the end                             | No         |
| send      | 30 a second             | 0 errors, median 42 ms, p95 657 ms                                                                                                                                   | No (p95)   |
| send      | 20 a second             | 0 errors, median 24 ms, p95 40 ms; worker sent everything within 1 s of the end                                                                                      | Yes        |

What limits it here:

- **Inbound**: one worker process handles about 45 to 50 inbound messages a second end to end (store, route, contact, conversation, message, then the automation job). A second worker raised it to about 59 a second; on one machine both share the same CPU and database. Run more worker processes on more hosts to go further.
- **Sends**: each public API send is several short transactions, and each message sent comes back as three status webhooks (sent, delivered, read) that the same API stores and the same worker processes, so 50 sends a second is about 200 requests a second of real work. A larger API pool (`DATABASE_POOL_MAX=20`) changed nothing, so it is CPU, not connections. Add API instances.
- At 200 webhooks a second the API, worker, Postgres and k6 (400 virtual users) were all on one 8 GB machine.

Found and fixed by these runs:

- Two first messages from a new number handled at the same moment failed one job on the contact's unique key (it then succeeded on retry), and both could report `contact.created`. Contacts from WhatsApp are now created with `INSERT ... ON CONFLICT DO NOTHING` (`packages/db/src/channels.ts`), with a test in `apps/worker/test/pipeline.test.ts`.
- Rate-limit counters were not namespaced, so two environments on one Redis shared login and signup limits. They are now under `QUEUE_PREFIX`.
- Under heavy load two inbound transactions ran past Prisma's 5-second limit and were retried successfully; nothing was lost.
