# Queue backlog and failing jobs

Alerts: `OutboundBacklog`, `WebhookEventBacklog`, `QueueBacklog`, `JobFailureRateHigh`, `FailedJobsAccumulating`.

Queues and what waits on them (`packages/shared/src/queues.ts`):

| Queue                 | If it backs up                                            |
| --------------------- | --------------------------------------------------------- |
| `webhook-events`      | Inbound messages and statuses reach the inbox late        |
| `outbound-messages`   | Replies and template sends go out late                    |
| `automation`, `flows` | Auto-replies, assignment and flows run late               |
| `campaigns`           | Broadcasts slow down (they throttle themselves anyway)    |
| `media-download`      | Images show late; Meta's media links expire after a while |
| `webhook-deliveries`  | Customers' webhooks arrive late                           |
| `analytics`           | Reports fall behind (they read aggregates)                |
| others                | Background work only                                      |

## Is the worker keeping up?

In the dashboard: "Jobs waiting" growing while "Jobs finished per second" is flat means the worker is saturated or stuck. "Jobs finished" near zero: see [worker-down.md](worker-down.md).

## Outbound backlog

1. Per-number limits park jobs on purpose: `OUTBOUND_MPS_PER_NUMBER` (80 per second) and the campaign limit (`CAMPAIGN_MPS_PER_NUMBER`, 40). A large campaign on one number shows as many `delayed` jobs: expected.
2. Meta throttling: logs show error code `131056` (pair rate limit) or `130429` (throughput). Nothing to fix on our side; jobs retry.
3. Many `failed` with one error code: look it up in the logs (`outbound job failed`). A token error (`190`) means a WABA's token was revoked; the number shows as disconnected and the customer must reconnect.
4. Saturated: run another worker process (`WORKER_CONCURRENCY`, default 10, is per process).

## Webhook events backlog

Each event takes a few short transactions. A sustained backlog with a healthy worker usually means Postgres is slow ([database.md](database.md)). A sudden spike after an outage drains on its own.

## Failed jobs

- Failed jobs stay in Redis for inspection. Most queues record failures on their own rows too (webhook events, deliveries, integration events, contact jobs) where the UI shows a reason and offers Try again; prefer that over retrying in Redis.
- A queue whose jobs all fail with the same error after a deploy is a bug: roll back ([deploy-rollback.md](deploy-rollback.md)).
- To clear old failed jobs from Redis once understood (example, `analytics`, older than 7 days), from the API host:

  ```sh
  node -e "const {Queue}=require('bullmq');const q=new Queue('analytics',{connection:{url:process.env.REDIS_URL},prefix:process.env.QUEUE_PREFIX||'wacrm'});q.clean(7*864e5,10000,'failed').then(r=>{console.log(r.length);return q.close()})"
  ```
