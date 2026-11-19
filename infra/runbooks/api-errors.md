# API errors, latency and resources

Alerts: `ApiErrorRateHigh`, `ApiLatencyHigh`, `ApiRateLimiting`, `EventLoopLagHigh`, `ProcessMemoryHigh`.

## 5xx rate above 2%

1. Which routes: in Prometheus, `topk(10, sum by (route, status) (rate(wacrm_http_requests_total{status=~"5.."}[5m])))`.
2. The logs for those requests: `journalctl -u wacrm-api | grep '"statusCode":5'`. Errors carry a stable `code` (from `packages/shared/src/errors.ts`).
3. Usual causes:
   - Postgres slow or out of connections: many routes at once, `/health/ready` slow. Go to [database.md](database.md).
   - Redis down: sending, uploads and realtime fail (the producers fail fast by design). Go to [redis.md](redis.md).
   - Object storage unreachable: only uploads and media routes fail. Check the provider's status and the `S3_*` settings.
   - One route after a deploy: a bug. Roll back ([deploy-rollback.md](deploy-rollback.md)).

## p95 above 1 second

- One route: look at its queries. `pg_stat_statements` (enable it on the database) shows the slowest; compare with the indexes the code expects (migrations).
- All routes: the pool is exhausted (`DATABASE_POOL_MAX`, default 10 per API instance) or the host is CPU-bound. Add an API instance before raising the pool; the total across instances must stay below Postgres `max_connections` with room for the worker and migrations.
- Report routes read aggregate tables and should stay under 1 second (checked on 5 million messages in Phase 4.3). If they are slow, the rollup may have stopped: check the `analytics` queue.

## Sustained 429s

The per-address limit (`RATE_LIMIT_IP_PER_MINUTE`, 1200) and per-person limit (`RATE_LIMIT_USER_PER_MINUTE`, 600) answer 429. Find who: the API logs carry the address. A single address hammering the API is abuse: block it at the proxy or the edge. Many customers behind one office address can hit the per-address limit legitimately: raise it. Check that `TRUST_PROXY` is set when behind a proxy, or every request appears to come from the proxy's address and everyone shares one limit.

## Event loop lag or memory

- Lag above 500 ms means one request or job is doing too much synchronous work (a huge CSV, a big PDF, a large JSON body). Find the slow route or queue in the dashboard at that moment.
- Memory that only grows is a leak; memory that jumps is a large file in memory (imports cap at 50 MB, uploads at 25 MB). Restart to recover, and take a heap snapshot on a staging copy (`node --inspect`) if it repeats.
