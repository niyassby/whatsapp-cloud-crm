# Worker down

Alert: `WorkerDown`.

**Impact.** Webhooks are still accepted and stored by the API (nothing is lost), but no inbound message reaches the inbox, nothing is sent, campaigns, flows and automations stop, and scheduled work (SLA checks, report rollups, privacy ticks, partition creation) pauses. Everything resumes from Redis and the database when a worker comes back.

## Check

1. `systemctl status wacrm-worker` or `docker compose ps worker`; `GET http://<host>:4001/health`.
2. Logs: `journalctl -u wacrm-worker -n 300`. Start-up failures are the same kinds as the API's ([api-down.md](api-down.md)): environment, Postgres, Redis.
3. A worker that is up but stuck: `/health` answers, yet `wacrm_jobs_total` stops increasing while queues grow. Look for a job that never finishes (`active` stays above zero on one queue in the dashboard) and the last log lines for that queue.

## Fix

- Restart: `systemctl restart wacrm-worker`. On `SIGTERM` the worker finishes running jobs first; a send interrupted mid-call is failed and refunded, never resent.
- If one queue is stuck behind a slow external call (an integration, an AI provider), the job's own timeout ends it; a restart moves the stalled job back to waiting after BullMQ's stall check (30 seconds).
- Run a second worker if the backlog is large ([queue-backlog.md](queue-backlog.md)).

## After

- Queues drain on their own. The 15-second flow tick and the 30-second campaign tick pick up everything due while the worker was down; delayed jobs that passed their time run at once.
- Message partitions: the worker creates them at start, so a worker down across a month boundary catches up on its own. Check: `SELECT count(*) FROM message_partitions.messages_default;` should be 0. Rows there mean partitions were missing; see [database.md](database.md).
