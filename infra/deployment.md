# Deployment guide

How to run WhatsApp Cloud CRM in production, on whichever hosting you choose, and how to release new versions without downtime. The step-by-step server install (Ubuntu, systemd, Nginx) and the Docker Compose stack are in the [README](../README.md#deploying-to-a-server); this guide adds the choices around them and the rules for operating it.

Contents:

1. [What runs where](#1-what-runs-where)
2. [PostgreSQL: self-hosted, Neon or RDS](#2-postgresql)
3. [Redis](#3-redis)
4. [Object storage](#4-object-storage)
5. [Running the processes: VM, Docker, container platforms](#5-running-the-processes)
6. [Configuration](#6-configuration)
7. [Monitoring, dashboards and alerts](#7-monitoring-dashboards-and-alerts)
8. [Releasing: zero-downtime deploys and migrations](#8-releasing-zero-downtime-deploys-and-migrations)
9. [Verify a deployment (staging acceptance)](#9-verify-a-deployment)
10. [Launch checklist](#10-launch-checklist)

---

## 1. What runs where

| Process | Command (from the repo root after `pnpm build`) | Port | Scales       | Needs inbound traffic                    |
| ------- | ----------------------------------------------- | ---- | ------------ | ---------------------------------------- |
| API     | `node apps/api/dist/main.js`                    | 4000 | Horizontally | Yes: browsers, webhooks, public API      |
| Worker  | `node apps/worker/dist/main.js`                 | 4001 | Horizontally | Only `/health` and `/metrics`, privately |
| Web     | `next start` in `apps/web`                      | 3000 | Horizontally | Yes: browsers                            |
| Tools   | `pnpm db:migrate:deploy`, operator scripts      | none | One-off      | No                                       |

All three long-running processes are stateless: everything they keep is in PostgreSQL, Redis and object storage. Two public host names on the same parent domain are needed, for example `app.example.com` (web) and `api.example.com` (API), because the refresh cookie is `SameSite=Lax`.

Starting size for a first launch (hundreds of workspaces, tens of messages a second):

| Piece      | Size                                                             |
| ---------- | ---------------------------------------------------------------- |
| API        | 2 instances, 1 vCPU and 1 GB each                                |
| Worker     | 1 to 2 instances, 1 vCPU and 1 GB each (`WORKER_CONCURRENCY` 10) |
| Web        | 1 to 2 instances, 0.5 vCPU and 512 MB each                       |
| PostgreSQL | 2 vCPU, 4 to 8 GB RAM, SSD, PITR backups                         |
| Redis      | 1 GB, persistence on                                             |

The load tests in [load-testing.md](load-testing.md) give the throughput one instance of each reached; scale out from those numbers.

## 2. PostgreSQL

Requirements, whatever the host:

- PostgreSQL 16 or newer, with the **pgvector** extension (`CREATE EXTENSION vector` must succeed).
- Two roles, as in the README step 3 and 6: an **owner** for migrations (`DIRECT_URL`) and a **runtime login role** that is a member of `app_user`, with no superuser and no `BYPASSRLS` (`DATABASE_URL`). The runtime role is created after the first migration, because `app_user` comes from the migrations:

  ```sql
  CREATE ROLE wacrm_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS IN ROLE app_user;
  ```

- The owner does not need to be a superuser. Migrations create the roles `app_user` and `app_definer`, so the owner needs `CREATEROLE` (or run the first migration as a role that has it).
- Roles belong to the whole server, not one database. If the server already has `app_user` and `app_definer` (another environment's database on the same server, such as staging next to production), a new owner must be given them before its first migration, as a superuser or their admin:

  ```sql
  GRANT app_user, app_definer TO <new owner> WITH ADMIN OPTION;
  ```

  Policies and grants are per database, so the environments stay separate; but a runtime login role of one environment can connect to the other's database if it knows the name, so give each environment its own login role and use `pg_hba.conf` (or separate servers) to keep them apart.

- `DIRECT_URL` must be a direct connection (no transaction pooler): migrations and the operator scripts use session features.

### Self-hosted

Follow the README (Ubuntu packages `postgresql-16` and `postgresql-16-pgvector`). Set up backups with point-in-time recovery (pgBackRest or WAL-G to object storage) as described in [backup-restore.md](backup-restore.md); a nightly `pg_dump` alone loses up to a day.

### Neon

- Create the project in the region closest to your API. pgvector is available: `CREATE EXTENSION vector;` as the project owner.
- Use the project owner role (created with the project) as the migration owner. Connect it through the **direct** host (without `-pooler`) for `DIRECT_URL`.
- Create the runtime role with the SQL above (Neon roles created by SQL work like any Postgres role). Use the **pooled** host (`-pooler`) for `DATABASE_URL`: it is PgBouncer in transaction mode. The app sets its tenant context with `SET LOCAL` inside each transaction, which is what transaction pooling allows.
- Turn off scale to zero (autosuspend) for production computes: the first query after a suspend waits for the compute to start, which delays webhooks.
- Both URLs need `sslmode=require`.
- Branches make good staging copies: a branch of production is a full copy for a migration rehearsal (section 8).

### Amazon RDS / Aurora PostgreSQL

- Engine PostgreSQL 16, with `vector` in the allowed extensions (it is for current RDS versions; `CREATE EXTENSION vector;` as the master user).
- The master user (member of `rds_superuser`) can create the owner role; use a separate owner role rather than the master user for `DIRECT_URL`:

  ```sql
  CREATE ROLE wacrm LOGIN PASSWORD '...' CREATEROLE;
  CREATE DATABASE wacrm OWNER wacrm;
  ```

- TLS: RDS forces SSL on recent versions. Node does not trust the RDS certificate authority by default, so download the RDS CA bundle and point Node at it in every process: `NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem`, and add `sslmode=require` to both URLs.
- RDS Proxy is optional; if used, put only `DATABASE_URL` through it.
- Turn on automated backups (PITR) and Multi-AZ for production.

### Connection budget

Each API instance opens up to `DATABASE_POOL_MAX` (10) connections, and each worker its own pool. Keep the total below 80% of `max_connections`, leaving room for migrations and your own sessions. A pooler (Neon's, PgBouncer, RDS Proxy) raises the ceiling.

## 3. Redis

Redis holds every queued job. It must:

- persist (AOF `appendonly yes`, `appendfsync everysec`), and
- never evict keys: `maxmemory-policy noeviction`. Any other policy can silently drop queued messages.

Options:

| Host                                 | Notes                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| Self-hosted Redis 7                  | `redis.conf` as above. Bind to the private network only.                            |
| AWS ElastiCache (Redis OSS / Valkey) | Parameter group with `maxmemory-policy noeviction`; snapshots on. Cluster mode off. |
| Upstash, Redis Cloud, Memorystore    | Choose a plan with persistence and set no-eviction. Use `rediss://` URLs for TLS.   |

BullMQ needs a single Redis (not cluster mode). One Redis can serve several environments if each has its own `QUEUE_PREFIX`: queues, schedules and rate-limit counters all live under it. Production should still have its own.

## 4. Object storage

Any S3-compatible store works: Cloudflare R2, AWS S3, Backblaze B2, or self-hosted MinIO or SeaweedFS.

- Create one private bucket (`S3_BUCKET`). Nothing in it is public: browsers get 5-minute signed links.
- `S3_ENDPOINT` is the address the API and worker use; `S3_PUBLIC_ENDPOINT` is the address in signed links that browsers open (often the same).
- Set `MEDIA_PUBLIC_ORIGINS` on the **web** app to the origin of those links (for example `https://<account>.r2.cloudflarestorage.com`), or the Content Security Policy blocks images and files.
- Uploads go through the API, so the bucket needs no CORS rules.
- Turn on versioning or replication for recovery, and a lifecycle rule that deletes `orgs/*/privacy/` exports after 7 days as a backstop to the app's own cleanup.

## 5. Running the processes

### One VM or a few (systemd)

The README path: build on the server, three systemd units, Nginx in front. For more than one host, run the same release on each and put a load balancer in front of the API and web instances.

### Docker on one host

`docker-compose.prod.yml` (README, "Deploying with Docker"). Leave out the `postgres` and `redis` services when using managed ones.

### Container platforms (ECS, Kubernetes, Fly.io, Render and similar)

Build the three images from the repo root (`apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`; `--target tools` of the API Dockerfile for migrations), push them with the same tag, and run:

| Service | Health check                                                   | Notes                                                                                                              |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| api     | HTTP `GET /health` (liveness), `GET /health/ready` (readiness) | Behind the load balancer. WebSockets: enable them, idle timeout above 60 s, and sticky sessions or WebSocket-only. |
| worker  | HTTP `GET :4001/health`                                        | No public ingress. Stop timeout (grace period) of at least 60 s so running jobs finish.                            |
| web     | HTTP `GET /health`                                             | `NEXT_PUBLIC_API_URL` is a **build argument**: one image per API address.                                          |
| tools   | none                                                           | One-off task per release: `pnpm db:migrate:deploy`, before the new services start.                                 |

Platform notes:

- **ECS / Fargate**: one service per process; migrations as a one-off task from the tools image in the deploy pipeline; secrets from Secrets Manager into environment variables; an ALB with two target groups (api, web).
- **Kubernetes**: Deployments for api, worker and web, with a `preStop` sleep of a few seconds on the API so the load balancer stops sending before shutdown; migrations as a Job (or a Helm pre-upgrade hook) that must succeed before the rollout; `terminationGracePeriodSeconds: 90` for the worker.
- **Fly.io / Render / Railway**: one app (or service) per process. Run migrations as the release command of the API app only.

The API listens on `0.0.0.0:$API_PORT`. Set `TRUST_PROXY=true` behind any load balancer, or every client appears to share one address and one rate limit.

## 6. Configuration

Every variable is listed in the README ("Environment variables") and `.env.example`. Production refuses to start with the development secrets, without the Meta settings, or with any test double set (`META_GRAPH_BASE_URL`, `STRIPE_API_BASE`, fake AI, `WEBHOOK_ALLOW_PRIVATE_URLS`), unless `STAGING_TEST_DOUBLES` is set (section 9, staging only).

Keep secrets in the platform's secret store, not in images. Back up `ENCRYPTION_KEY` separately from the database: without it, stored tokens cannot be decrypted. Rotation of every secret: [key-rotation.md](key-rotation.md).

Set, in production:

| Variable                     | Why                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `METRICS_TOKEN`              | Same value on API and worker; Prometheus sends it. Without it, `/metrics` is closed in production. |
| `TRUST_PROXY=true`           | Behind a proxy or load balancer.                                                                   |
| `MEDIA_PUBLIC_ORIGINS` (web) | The CSP allows signed media links from there.                                                      |
| `API_PUBLIC_URL`             | The public API address, for integration webhooks and OAuth callbacks.                              |

## 7. Monitoring, dashboards and alerts

Files in [observability/](observability/):

- `prometheus.yml`: scrape configuration for the API, worker, the web health check (blackbox exporter), postgres_exporter and redis_exporter.
- `alerts.yml`: alert rules. Every alert names its runbook in [runbooks/](runbooks/README.md).
- `grafana-dashboard.json`: one overview dashboard (request rate, 5xx, latency by route, webhook receivers, queue depth, job throughput and duration, event loop lag, memory, CPU, Postgres connections). Import it in Grafana and choose the Prometheus data source.

Metrics served by the app (`/metrics` on the API port and on the worker's health port):

| Metric                                | Labels                       |
| ------------------------------------- | ---------------------------- |
| `wacrm_http_requests_total`           | method, route, status        |
| `wacrm_http_request_duration_seconds` | method, route                |
| `wacrm_jobs_total`                    | queue, result                |
| `wacrm_job_duration_seconds`          | queue                        |
| `wacrm_queue_jobs`                    | queue, state                 |
| `wacrm_process_*`, `wacrm_nodejs_*`   | default Node process metrics |

Every series also has `service` (`api` or `worker`). Routes are templates (`/inbox/conversations/:id`), and nothing is labelled by workspace, so series stay few.

Logs are JSON (pino) on standard output. Ship them to your log store (CloudWatch, Loki, Datadog) and keep 30 days. They never contain tokens, cookies or message text.

Uptime checks from outside: `https://api.example.com/health/ready` and `https://app.example.com/health`, every minute, paging after 3 failures.

## 8. Releasing: zero-downtime deploys and migrations

### The release order

1. Build the images (or `pnpm build`) for the new version.
2. Back up, or confirm PITR is healthy.
3. Run `pnpm db:migrate:deploy` once, with the new version's code, **while the old version is still serving**. Prisma takes an advisory lock, so two runs cannot interleave.
4. Roll the API instances one at a time (drain each from the load balancer), then the workers, then the web app.
5. Watch the dashboard for 15 minutes. Roll back the code if needed: [runbooks/deploy-rollback.md](runbooks/deploy-rollback.md).

For a moment the old code runs against the new schema, and old and new code run side by side. Everything below follows from that.

### Rules for migrations (expand, then contract)

Every migration must work with the code before it and the code after it.

| Change                    | Safe way                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a table               | Any time. Include its RLS (`ENABLE` + `FORCE` + policies) in the same migration; `rls-coverage.test.ts` and the isolation sweep enforce it.                                                                               |
| Add a column              | Nullable, or `NOT NULL DEFAULT <constant>` (instant since PostgreSQL 11). Old code ignores it.                                                                                                                            |
| Make a column required    | Release 1: add it nullable, write it in the code, backfill. Release 2: `SET NOT NULL` (add a `CHECK ... NOT VALID`, `VALIDATE` it, then set NOT NULL to avoid a long lock).                                               |
| Rename a column or table  | Never in one step. Add the new one, write both, backfill, read the new one, and drop the old one a release later.                                                                                                         |
| Drop a column or table    | Only once no running code reads it: stop using it in release N, drop it in N+1.                                                                                                                                           |
| Add an index              | `CREATE INDEX CONCURRENTLY` in a migration of its own (Prisma runs each migration file in a transaction unless it holds only statements that cannot run in one; keep the concurrent index alone in its file).             |
| Index on `messages`       | It is partitioned: `CREATE INDEX ... ON ONLY messages`, then `CREATE INDEX CONCURRENTLY` on each partition in `message_partitions`, then `ALTER INDEX ... ATTACH PARTITION` for each.                                     |
| Add an enum value         | `ALTER TYPE ... ADD VALUE` in its own migration; do not use the value in the same migration. Old code must tolerate the new value if it can read it.                                                                      |
| Change a definer function | `CREATE OR REPLACE FUNCTION` with the same signature, keeping `GRANT CREATE ON SCHEMA public TO app_definer` around it as the earlier migrations do. A new signature is a new function; drop the old one a release later. |
| Change a policy           | Create the new policy before dropping the old one in the same transaction; add the change to `REVIEWED` in `isolation-sweep.test.ts` if it is not the plain org match.                                                    |
| Large backfill            | Not in a migration. A script that updates in batches of a few thousand rows, each in its own transaction, run after the deploy.                                                                                           |

Every migration should set short lock waits so it fails fast instead of queueing behind traffic:

```sql
SET lock_timeout = '5s';
SET statement_timeout = '60s';
```

A migration that fails on the lock timeout can simply be run again at a quieter moment.

### Rules for code

- **Queue jobs**: a new worker may receive jobs queued by the old API, and an old worker (still draining) jobs from the new API. Add fields to job payloads as optional, and never change a field's meaning; remove a field a release after nothing sends it.
- **API responses**: the web app may be on the old or new version for a few minutes. Add fields; do not remove or rename fields the web uses within one release. The public API (`/v1`) never removes fields.
- **Webhooks during restarts**: Meta and the payment providers retry refused deliveries, and the API only answers after storing the event, so rolling restarts lose nothing.
- **Realtime**: sockets reconnect to another instance and the web refetches on reconnect.
- **Sessions**: kept in Postgres; a restart logs nobody out.

### Rehearse risky migrations

On a copy of production (a Neon branch, an RDS snapshot restore, or `infra/scripts/backup-restore-check.mjs`'s restored database), run `pnpm db:migrate:deploy` and time it. Anything over a few seconds of lock needs the expand-and-contract treatment above.

## 9. Verify a deployment

A fresh environment is accepted when the whole e2e suite passes against it. Real Meta and payment accounts cannot be driven by tests, so this is done on a **staging** copy deployed exactly as production, with one difference: `STAGING_TEST_DOUBLES=true` lets its production build talk to the e2e fakes (a fake Meta and a fake Stripe that the suite runs).

> Never set `STAGING_TEST_DOUBLES` where real customers are. It is what lets the test doubles past the production checks, and both processes log a warning at start while it is on.

1. Deploy as for production (this guide and the README), on its own database, Redis prefix and bucket, and point the app at the fakes. Use the e2e fakes' fixed values from `e2e/support/config.mjs`; `<runner>` is the machine that will run the tests (`127.0.0.1` when it is the same machine):

   ```ini
   NODE_ENV=production
   STAGING_TEST_DOUBLES=true
   META_APP_ID=e2e-app
   META_APP_SECRET=e2e-app-secret
   META_WEBHOOK_VERIFY_TOKEN=e2e-verify-token
   META_GRAPH_BASE_URL=http://<runner>:4199
   INSTAGRAM_APP_ID=e2e-ig-app
   INSTAGRAM_APP_SECRET=e2e-instagram-secret
   INSTAGRAM_BASE_URL=http://<runner>:4199/ig
   STRIPE_SECRET_KEY=sk_test_e2e
   STRIPE_WEBHOOK_SECRET=whsec_e2e
   STRIPE_API_BASE=http://<runner>:4198
   AI_PROVIDER=fake
   AI_EMBEDDINGS_PROVIDER=fake
   INTEGRATIONS_DEMO=true
   WEBHOOK_ALLOW_PRIVATE_URLS=true
   ALLOW_MANUAL_CONNECT=true
   TRUST_PROXY=true
   # The suite logs in many browsers from one address, faster than a person.
   RATE_LIMIT_IP_PER_MINUTE=100000
   RATE_LIMIT_USER_PER_MINUTE=100000
   RATE_LIMIT_LOGIN_PER_IP=100000
   API_RATE_LIMIT_PER_MINUTE=100000
   # Reports are checked seconds after the messages they count.
   ANALYTICS_ROLLUP_EVERY_MS=3000
   # The worker's metrics are read by the load tests' drain checks.
   METRICS_TOKEN=<a long random value>
   ```

   Over plain `http` on a host other than `localhost`, also set `COOKIE_SECURE=false`, since browsers drop secure cookies there; staging over https needs nothing.

   The suite reads invitation and report emails from Mailpit, so point `SMTP_URL` at a Mailpit the runner can reach.

   Quote any value with spaces or `<` `>` (`MAIL_FROM="Staging CRM <no-reply@staging.test>"`): the same file is loaded by the shell (`set -a; . file`) for the build and by systemd or `node --env-file` for the processes, and the shell refuses unquoted ones.

2. Load the sample configuration the suite expects (the README's step 6 commands):

   ```bash
   pnpm plans:import prisma/sample-plans.json
   pnpm rates:import prisma/sample-rate-cards.csv
   ```

3. Run the suite from a checkout of the same version, naming the deployment:

   ```bash
   E2E_EXTERNAL=1 \
   E2E_WEB_URL=https://staging-app.example.com \
   E2E_API_URL=https://staging-api.example.com \
   E2E_DIRECT_URL='postgresql://<owner>:<password>@<host>:5432/<db>' \
   E2E_MAILPIT_API=http://<mailpit host>:8025/api/v1 \
   E2E_FAKES_HOST=<runner> \
   pnpm test:e2e
   ```

   `E2E_DIRECT_URL` is the owner connection, used by two operator scripts the suite runs (adding wallet credit and granting platform admin). The fakes start on the runner, on ports 4198 and 4199; the deployment must reach them, and they must reach the deployment's API to deliver signed webhooks.

   The suite expects a **fresh** environment: specs connect the same fake number and Instagram account, and some limits count per hour. To run it again, reset first: a new empty database (step 1 onwards) and a new `QUEUE_PREFIX`.

4. Run the load tests against the same environment ([load-testing.md](load-testing.md)).

5. Then remove `STAGING_TEST_DOUBLES` and the fake settings, or tear the staging environment down.

## 10. Launch checklist

- [ ] Production env complete; app starts without warnings; `STAGING_TEST_DOUBLES` not set.
- [ ] `ENCRYPTION_KEY` and the env file backed up outside the server.
- [ ] Runtime database role is not owner, superuser or `BYPASSRLS` (`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '<app role>';`).
- [ ] PITR backups on; a restore drill done ([backup-restore.md](backup-restore.md)).
- [ ] Redis persistence on and `noeviction`.
- [ ] Bucket private, versioning on, `MEDIA_PUBLIC_ORIGINS` set on web.
- [ ] TLS on both host names; ports 3000, 4000, 4001, 5432 and 6379 closed to the internet.
- [ ] Prometheus scraping with `METRICS_TOKEN`; alerts routed to someone on call; dashboard imported.
- [ ] Outside uptime checks on `/health/ready` and the web `/health`.
- [ ] Meta webhook, data deletion and deauthorize URLs registered; payment provider webhooks registered.
- [ ] Real plans, prices and rate cards loaded (not the samples).
- [ ] Staging acceptance passed for this version (section 9) and load test targets met.
- [ ] The open items in [security-checklist.md](security-checklist.md) reviewed and accepted or done.
