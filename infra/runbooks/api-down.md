# API or web app down

Alerts: `ApiDown`, `WebDown`.

**Impact.** API down: nobody can use the dashboard, the public API refuses requests, and **Meta webhooks fail**. Meta retries deliveries with backoff for some hours, so a short outage loses nothing, but a long one can. Web down: the dashboard is unreachable; messages still flow through the API and worker.

## Check

1. Process state: `systemctl status wacrm-api wacrm-web` or `docker compose ps`.
2. Logs since the last start: `journalctl -u wacrm-api --since "15 min ago"`. Typical start-up failures:
   - `Missing required production settings` or `Refusing to start in production with dev-only values`: the environment file is incomplete. Fix `.env.production` (see `infra/deployment.md`, environment).
   - `... must not be set in production`: a test-only setting (`META_GRAPH_BASE_URL`, `STRIPE_API_BASE`, `WEBHOOK_ALLOW_PRIVATE_URLS`, fake AI) is set on a production host. Remove it.
   - `P1001` / `ECONNREFUSED` on 5432: Postgres is unreachable. Go to [database.md](database.md).
   - `ECONNREFUSED` on 6379: Redis. Go to [redis.md](redis.md).
   - `EADDRINUSE`: an old process still holds the port. Find it (`ss -ltnp | grep 4000`) and stop it.
3. If the process is up but `/health` fails from outside, the proxy is the problem: `nginx -t`, `systemctl status nginx`, certificate expiry (`certbot certificates`).
4. `/health` answers but `/health/ready` does not: the API cannot reach Postgres.

## Fix

- Restart: `systemctl restart wacrm-api` (or `docker compose up -d api`). Safe at any time.
- Crash loop right after a deploy: roll back the release ([deploy-rollback.md](deploy-rollback.md)).
- Out of memory (`JavaScript heap out of memory`, or the kernel OOM killer in `dmesg`): restart, then look at [api-errors.md](api-errors.md) (memory) before it repeats.

## After

- Check Settings > WhatsApp > webhook events for anything left `received` or `failed`, and replay it. A Meta delivery refused for longer than Meta retries is lost; tell affected customers if that may have happened.
- Check the outbound sweep caught up: `outbound-messages` waiting returns to near zero.
