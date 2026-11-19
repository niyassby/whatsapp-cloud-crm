# Postgres

Alerts: `PostgresDown`, `PostgresConnectionsHigh`. Also slow requests across all routes.

## Down or unreachable

1. Managed (Neon, RDS): the provider's status page and console. Neon computes can be suspended when idle; the first connection wakes them and takes a few seconds (set the compute to never suspend in production).
2. Self-hosted: `systemctl status postgresql`, then its log (`/var/log/postgresql/`). Disk full is the most common cause: `df -h`.
3. While it is down, the API answers `/health` but not `/health/ready`, webhooks answer 5xx (providers retry), and the worker's jobs retry with backoff. Nothing needs to be replayed by hand once it is back, except webhook events Meta gave up on.

## Out of connections

- Each API process opens up to `DATABASE_POOL_MAX` (10); the worker opens its own pool. Total = instances x pool + worker + migrations + your own sessions. Keep it under 80% of `max_connections`.
- With a pooler (PgBouncer, Neon's pooled endpoint, RDS Proxy): use transaction pooling for `DATABASE_URL` only. The app sets its tenant context with `SET LOCAL` inside each transaction, which is safe with transaction pooling. Migrations and `DIRECT_URL` must use a direct (unpooled) connection.
- Find who holds connections: `SELECT usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;`
- Long idle-in-transaction sessions: `SELECT pid, now() - xact_start, query FROM pg_stat_activity WHERE state = 'idle in transaction' ORDER BY 2 DESC;` End one with `SELECT pg_terminate_backend(<pid>);` if it is not a migration.

## Slow

- Enable `pg_stat_statements` and look at the top queries by total time.
- Autovacuum on the busiest tables (`messages` partitions, `message_refs`, `webhook_events`, `wallet_ledger`): `SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 20;`
- Locks: `SELECT * FROM pg_locks WHERE NOT granted;` A campaign hold or wallet debit waits on the wallet row by design; long waits there mean one transaction is slow, not that locking is wrong.

## Message partitions

`messages` is partitioned by month in schema `message_partitions`. The worker creates this month plus three ahead, daily and at start. Rows in `message_partitions.messages_default` mean a month was missing when they arrived:

```sql
SELECT count(*), min(created_at), max(created_at) FROM message_partitions.messages_default;
```

If any, run `SELECT ensure_message_partitions();` as the owner. Postgres refuses to create a partition whose range overlaps rows in the default partition, so move them first, in a maintenance window: detach the default, create the partition, `INSERT ... SELECT` the rows into the parent, and attach an empty default again.

## Disk

Biggest tables: `SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 20;` Retention jobs (webhook events 30 days, logs `RETENTION_LOG_DAYS`, per-workspace message retention) keep growth bounded; old message partitions can be detached and archived by month.

## Restore

`infra/backup-restore.md`.
