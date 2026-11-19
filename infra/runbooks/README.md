# Runbooks

What to do when something breaks in production. Every alert in `infra/observability/alerts.yml` names one of these pages.

| Page                                     | Covers                                                          |
| ---------------------------------------- | --------------------------------------------------------------- |
| [api-down.md](api-down.md)               | `ApiDown`, `WebDown`: the API or web app is not answering       |
| [worker-down.md](worker-down.md)         | `WorkerDown`: nothing is sent or received                       |
| [api-errors.md](api-errors.md)           | 5xx rate, slow requests, 429s, event loop lag, memory           |
| [webhooks.md](webhooks.md)               | Meta, Instagram, Stripe and Razorpay webhooks failing or silent |
| [queue-backlog.md](queue-backlog.md)     | Queues growing, jobs failing                                    |
| [database.md](database.md)               | Postgres down, slow, out of connections or disk                 |
| [redis.md](redis.md)                     | Redis down or full                                              |
| [deploy-rollback.md](deploy-rollback.md) | A release went wrong                                            |
| [incidents.md](incidents.md)             | How to run an incident, and the customer-facing side            |

Related: backups and restore `infra/backup-restore.md`, rotating secrets `infra/key-rotation.md`, deployment `infra/deployment.md`.

## First five minutes, whatever the alert

1. Acknowledge the alert so nobody else starts on it alone, and open an incident note ([incidents.md](incidents.md)).
2. Check the three health endpoints, from outside and from the server:
   - `GET https://api.example.com/health` (API process) and `/health/ready` (API and Postgres)
   - `GET http://<worker host>:4001/health` (worker)
   - `GET https://app.example.com/health` (web)
3. Look at the dashboard (`infra/observability/grafana-dashboard.json`): request rate and 5xx, queues waiting, jobs failing.
4. Read the last logs of the failing process (`journalctl -u wacrm-api -n 200`, or `docker compose logs --tail 200 api`). Logs are JSON (pino); `level` 50 is an error.
5. Ask "what changed?": a deploy, a migration, a config change, a Meta or provider incident (https://metastatus.com).

## Safe actions at any time

- Restarting the API or web app: stateless, a restart is always safe. Sessions survive (they are in Postgres).
- Restarting the worker: it stops taking jobs and waits for running ones (`SIGTERM`, up to the stop timeout). An outbound send interrupted mid-call is marked failed and refunded rather than resent (at-most-once), so a restart never sends a message twice.
- Adding API or worker instances: both scale horizontally. Jobs are claimed through Redis; repeatable schedules are deduplicated by BullMQ.

## Never do these under pressure

- Do not connect the app as the database owner, or grant `BYPASSRLS`, to "get it working". Tenancy depends on it.
- Do not flush Redis. It holds every queued job, including outbound messages and webhook events still to process.
- Do not delete rows from `webhook_events`, `wallet_ledger` or `messages` by hand.
- Do not roll back a migration by editing `_prisma_migrations`. See [deploy-rollback.md](deploy-rollback.md).
