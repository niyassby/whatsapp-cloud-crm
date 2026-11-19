# Redis

Alerts: `RedisDown`, `RedisMemoryHigh`.

Redis holds the BullMQ queues (every job not yet run), rate-limit counters, OAuth states and the Socket.IO adapter. It is not a cache here: **never flush it**, and run it with persistence (AOF `appendfsync everysec`) and `maxmemory-policy noeviction`. With any eviction policy, Redis silently drops queued jobs under memory pressure.

## Down

- API: webhooks still store their event in Postgres, then fail to queue and answer 5xx; providers retry. Sending from the inbox fails fast and the message is marked failed. Request rate limits fail open. Realtime stops: browsers reconnect on their own when Redis is back.
- Worker: stops taking jobs; reconnects on its own.
- When Redis comes back with its data (AOF), everything resumes. If Redis came back **empty** (no persistence, or a new instance):
  1. Webhook and billing events stored but not processed: `pnpm events:requeue 48` (the last 48 hours; uses `DIRECT_URL` and `REDIS_URL`). Safe to repeat.
  2. Outbound messages still `queued` are re-queued by the outbound sweep within a minute (it looks back a day).
  3. Campaigns: the 30-second campaign tick restarts any running campaign with no progress for 2 minutes.
  4. Flows: the 15-second flow tick runs due and stuck runs.
  5. Repeatable schedules are re-created when the worker starts.
  6. Webhook deliveries live on their rows and are picked up by the 5-second dispatcher.

## Memory high

- `INFO memory` and `--bigkeys`. Usual growth: a large backlog (see [queue-backlog.md](queue-backlog.md)) or many kept completed or failed jobs.
- BullMQ keeps a bounded number of completed jobs per queue (`DEFAULT_JOB_OPTIONS`); failed jobs are kept for inspection and can be cleaned ([queue-backlog.md](queue-backlog.md)).
- Raise `maxmemory` before it is reached: with `noeviction`, a full Redis refuses new jobs, and the API then answers 5xx to webhooks.
