# WhatsApp Cloud CRM

A multi-tenant SaaS CRM built on the official WhatsApp Cloud API, in the same space as Wati or Gallabox.
Businesses connect their own WhatsApp Business number through Meta Embedded Signup, then work from
a shared team inbox, send template broadcasts, build chatbot flows, manage contacts and connect
their store or payment provider. Resellers (partners) can create and manage client workspaces.

## Features

| Area                 | What it does                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Team inbox           | Live shared inbox (Socket.IO), assignment, labels, notes, canned replies, 24-hour window rules  |
| Contacts and consent | Custom fields, tags, segments, CSV import and export, opt-in proof, STOP keywords, merge        |
| Templates            | Builder with live preview, submitted to Meta, status synced by webhook                          |
| Campaigns and drips  | Broadcasts with throttling, tier limits, auto-pause on low quality, reply attribution           |
| Wallet               | Prepaid balance on an append-only ledger, per-country rate cards, refunds on failed sends       |
| Billing              | Plans, trials and top-ups through Stripe and Razorpay, GST-style invoices as PDF                |
| Automation           | Auto-replies, business hours, assignment rules, SLA alerts                                      |
| Flow builder         | Drag-and-drop chatbot flows (React Flow) with a simulator, versions and run history             |
| Integrations         | Shopify, WooCommerce, custom store, Razorpay and Stripe payment links, Google Sheets, HubSpot   |
| Developer            | Public REST API with API keys and OpenAPI docs, signed outgoing webhooks, Zapier and Make       |
| AI assistant         | Knowledge base (pgvector), reply suggestions, summaries, an AI step in flows (Claude)           |
| Channels             | WhatsApp, Instagram DM and a website chat widget in one inbox; QR codes, catalog, groups, calls |
| Resellers            | Partner console, wholesale pricing and markup, client limits, impersonation, monthly statements |
| Reports              | Conversation, agent, campaign, template and ad reports, CSV and PDF, scheduled emails           |

## Architecture

```
                 ┌──────────────┐
  Browser ──────▶│  apps/web    │  Next.js dashboard (port 3000)
     │           └──────────────┘
     │ REST + WebSocket
     ▼
 ┌──────────────┐   enqueue    ┌──────────┐   jobs    ┌──────────────┐
 │  apps/api    │─────────────▶│  Redis   │──────────▶│  apps/worker │  BullMQ processors
 │  NestJS      │◀── pub/sub ──│ (BullMQ) │◀──────────│  (port 4001  │  (inbound, outbound,
 │  (port 4000) │              └──────────┘           │   health)    │  campaigns, flows ...)
 └──────────────┘                                     └──────────────┘
     ▲      │                 ┌─────────────────────┐        │
     │      └────────────────▶│ PostgreSQL + RLS    │◀───────┤
 Meta, Stripe,                │ (+ pgvector)        │        │
 Razorpay, Shopify            └─────────────────────┘        ▼
 webhooks                                              S3 / R2 storage, Meta Graph API
```

- **Webhooks are tiny**: the API verifies the signature, stores the raw event, queues it and answers 200. All real work happens in the worker.
- **Tenancy in two layers**: a NestJS guard plus PostgreSQL Row Level Security (`SET LOCAL app.org_id` in every transaction). The app never connects as the database owner.
- **Every outbound message goes through a queue** with per-number rate limits, retries and idempotency keys.

### Repository layout

```
apps/
  web/        Next.js dashboard (App Router, Tailwind, shadcn/ui, TanStack Query)
  api/        NestJS API (Fastify), WebSocket gateway, webhook receivers
  worker/     BullMQ processors and scheduled jobs
packages/
  db/         Prisma schema, migrations, RLS SQL, operator scripts
  shared/     Zod schemas, DTO types, error codes, permission map
  whatsapp/   WhatsAppGateway interface + wapi-cloud implementation
  billing/    Stripe and Razorpay adapters (platform billing)
  connectors/ Integration connectors (Shopify, WooCommerce, ...)
  ai/         Chat and embedding providers
  ui/         Shared React components
infra/        Setup guides (WhatsApp, billing, connectors, channels, reseller, public API)
e2e/          Playwright tests with fake Meta and fake payment providers
```

### Tech stack

Node 20+, pnpm 9 workspaces, Turborepo, TypeScript (strict) · Next.js 16, React, Tailwind 4 · NestJS
(Fastify), Socket.IO with the Redis adapter · BullMQ · PostgreSQL 16+ with pgvector, Prisma 7 · Redis 7
· S3-compatible storage (Cloudflare R2, AWS S3, SeaweedFS locally) · SMTP email · Sentry.

---

## Local development

Requirements: Node 20+, pnpm 9 (`corepack enable`), and either Docker or the native services
described in [infra/native-setup.md](infra/native-setup.md).

```bash
pnpm install
```

```bash
cp .env.example .env
```

Start PostgreSQL, Redis, S3 and Mailpit (pick one):

```bash
pnpm docker:up
```

```bash
pnpm services:up
```

Create the schema, the runtime database role and demo data:

```bash
pnpm db:setup
```

```bash
pnpm dev
```

| Service   | URL                                      |
| --------- | ---------------------------------------- |
| Dashboard | http://localhost:3000                    |
| API       | http://localhost:4000 (`/health`)        |
| API docs  | http://localhost:4000/v1/docs            |
| Worker    | http://localhost:4001/health             |
| Mailpit   | http://localhost:8025 (all local emails) |

Demo login credentials are in [packages/db/prisma/seed.ts](packages/db/prisma/seed.ts).

Useful commands:

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm test:e2e
```

```bash
pnpm build
```

---

## Deploying to a server

This guide deploys everything on one Linux server (Ubuntu 22.04/24.04) with Nginx and systemd. The
same steps work across several servers: run the API and worker anywhere that can reach PostgreSQL
and Redis, and run as many worker processes as you need.

### 1. What you need

- A Linux server with at least 2 vCPU and 4 GB RAM (the build itself needs about 3 GB).
- Two domains on the **same parent domain**, for example `app.example.com` (dashboard) and
  `api.example.com` (API). They must share the parent domain because the refresh-token cookie is
  `SameSite=Lax`.
- **PostgreSQL 16 or newer with the pgvector extension** (self-hosted, AWS RDS or Neon all work).
- **Redis 7** (self-hosted, or a managed Redis with persistence on; BullMQ needs `maxmemory-policy noeviction`).
- **S3-compatible bucket** (Cloudflare R2 or AWS S3) with an access key.
- **SMTP provider** (Amazon SES, Postmark, SendGrid, Mailgun, ...).
- A Meta developer app with WhatsApp set up: see [infra/whatsapp-setup.md](infra/whatsapp-setup.md).

### 2. Install system packages

```bash
sudo apt update && sudo apt install -y git nginx certbot python3-certbot-nginx build-essential
```

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
```

```bash
sudo corepack enable
```

If you host the database and Redis on the same server:

```bash
sudo apt install -y postgresql-16 postgresql-16-pgvector redis-server
```

(If `postgresql-16` is not in your Ubuntu release, add the official repository from
[postgresql.org/download/linux/ubuntu](https://www.postgresql.org/download/linux/ubuntu/) first.)

In `/etc/redis/redis.conf` set `maxmemory-policy noeviction` and `appendonly yes`, then restart Redis.

### 3. Create the database and its two roles

The app uses **two roles**:

- an **owner** role that owns the schema; used only for migrations and operator scripts (`DIRECT_URL`);
- a **runtime login role** that is a member of `app_user` (created by the migrations); no superuser,
  no `BYPASSRLS`, owns nothing. The API and worker always use this one (`DATABASE_URL`), so Row Level
  Security applies.

```bash
sudo -u postgres psql
```

```sql
CREATE ROLE wacrm LOGIN PASSWORD 'CHANGE-ME-owner-password';
CREATE DATABASE wacrm OWNER wacrm;
\c wacrm
CREATE EXTENSION IF NOT EXISTS vector;
\q
```

The runtime role is created **after** the first migration (step 6), because `app_user` comes from the migrations.

### 4. Get the code and a system user

```bash
sudo useradd --system --create-home --home-dir /opt/wacrm --shell /bin/bash wacrm
```

```bash
sudo -u wacrm git clone https://github.com/<your-org>/<your-repo>.git /opt/wacrm/app
```

### 5. Write the production environment file

Production does **not** read the repo's `.env` (the API and worker only load it outside production).
Put the variables in one file that systemd passes to every process:

```bash
sudo mkdir -p /etc/wacrm && sudo cp /opt/wacrm/app/.env.example /etc/wacrm/wacrm.env
```

```bash
sudo chown root:wacrm /etc/wacrm/wacrm.env && sudo chmod 640 /etc/wacrm/wacrm.env
```

Edit it as described in [Environment variables](#environment-variables) below. At minimum change
`NODE_ENV`, the URLs, both database URLs, `REDIS_URL`, the JWT secrets, `ENCRYPTION_KEY`, the S3
settings, `SMTP_URL` / `MAIL_FROM` and the `META_*` values. Generate secrets with:

```bash
openssl rand -hex 32
```

```bash
openssl rand -base64 32
```

(the first for `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `META_WEBHOOK_VERIFY_TOKEN`, the second
for `ENCRYPTION_KEY`). The API refuses to start in production while any dev-only value is still in use.

> **Keep `ENCRYPTION_KEY` safe and backed up.** WhatsApp tokens, 2FA secrets, webhook secrets and
> integration credentials are encrypted with it. Losing it means every connected number and
> integration must be reconnected.

### 6. Build, migrate and create the runtime role

Run as the `wacrm` user, with the environment loaded (Next.js inlines `NEXT_PUBLIC_API_URL` into the
dashboard at **build time**, so it must be set before `pnpm build`):

```bash
sudo -iu wacrm
```

```bash
cd /opt/wacrm/app && set -a && . /etc/wacrm/wacrm.env && set +a
```

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

```bash
pnpm db:migrate:deploy
```

Now create the runtime role (the `pnpm db:roles` script is for development only and refuses to run
in production):

```sql
-- sudo -u postgres psql -d wacrm
CREATE ROLE wacrm_app LOGIN PASSWORD 'CHANGE-ME-app-password' NOSUPERUSER NOBYPASSRLS IN ROLE app_user;
```

Load your configuration data (plans, prices and rate cards) and make yourself a platform admin:

```bash
pnpm plans:import prisma/sample-plans.json
```

```bash
pnpm rates:import /path/to/your-rate-cards.csv
```

```bash
pnpm admin:grant you@example.com
```

`sample-plans.json` and `sample-rate-cards.csv` are samples, not real prices: build your own from
Meta's current rate card and your margin before charging anyone. Sign up in the dashboard first,
then run `admin:grant` with that email. **Do not run `pnpm db:seed` in production**: it creates a
demo workspace with known passwords.

### 7. Run the three processes with systemd

Create `/etc/systemd/system/wacrm-api.service`:

```ini
[Unit]
Description=WhatsApp CRM API
After=network.target postgresql.service redis-server.service

[Service]
User=wacrm
WorkingDirectory=/opt/wacrm/app/apps/api
EnvironmentFile=/etc/wacrm/wacrm.env
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/wacrm-worker.service` the same way, with
`Description=WhatsApp CRM worker`, `WorkingDirectory=/opt/wacrm/app/apps/worker` and
`ExecStart=/usr/bin/node dist/main.js`.

Create `/etc/systemd/system/wacrm-web.service` with `Description=WhatsApp CRM web`,
`WorkingDirectory=/opt/wacrm/app/apps/web` and
`ExecStart=/opt/wacrm/app/apps/web/node_modules/.bin/next start -p 3000`.

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now wacrm-api wacrm-worker wacrm-web
```

```bash
curl -s localhost:4000/health/ready && curl -s localhost:4001/health && curl -s localhost:3000/health
```

Logs: `journalctl -u wacrm-api -f` (same for `wacrm-worker`, `wacrm-web`). The API and worker log
JSON with pino.

You can run more than one worker (on this or other servers) for more throughput: BullMQ shares the
work, and scheduled jobs are registered once. Several API instances also work, because Socket.IO
uses the Redis adapter; put them behind the load balancer with sticky sessions or WebSocket-only transport.

### 8. Nginx and HTTPS

`/etc/nginx/sites-available/wacrm`:

```nginx
server {
    server_name app.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    server_name api.example.com;
    client_max_body_size 60m;            # CSV imports go up to 50 MB

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket (live inbox, website chat widget)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wacrm /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot --nginx -d app.example.com -d api.example.com
```

Because the API is behind Nginx, set `TRUST_PROXY=true` so rate limits see the real client IP. Do
not expose ports 3000, 4000, 4001, 5432 or 6379 to the internet (`ufw allow 'Nginx Full'` and `ufw allow OpenSSH` only).

### 9. Point the outside services at your API

| Service                               | Address to register                                   | Guide                                              |
| ------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Meta WhatsApp webhook                 | `https://api.example.com/webhooks/meta`               | [infra/whatsapp-setup.md](infra/whatsapp-setup.md) |
| Meta data deletion                    | `https://api.example.com/meta/data-deletion`          | [infra/whatsapp-setup.md](infra/whatsapp-setup.md) |
| Meta deauthorize                      | `https://api.example.com/meta/deauthorize`            | [infra/whatsapp-setup.md](infra/whatsapp-setup.md) |
| Instagram webhook                     | `https://api.example.com/webhooks/instagram`          | [infra/channels.md](infra/channels.md)             |
| Stripe (platform)                     | `https://api.example.com/webhooks/stripe`             | [infra/billing-setup.md](infra/billing-setup.md)   |
| Razorpay (platform)                   | `https://api.example.com/webhooks/razorpay`           | [infra/billing-setup.md](infra/billing-setup.md)   |
| OAuth apps (Shopify, Google, HubSpot) | `https://api.example.com/integrations/oauth/callback` | [infra/connectors.md](infra/connectors.md)         |

Other guides: [public API](infra/public-api.md), [Zapier and Make](infra/integrations-zapier-make.md),
[resellers](infra/reseller.md).

### 10. Updating to a new version

```bash
sudo -iu wacrm
```

```bash
cd /opt/wacrm/app && git pull && set -a && . /etc/wacrm/wacrm.env && set +a
```

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm db:migrate:deploy
```

```bash
sudo systemctl restart wacrm-api wacrm-worker wacrm-web
```

Always run migrations before restarting. Webhooks that arrive during the restart are redelivered by
Meta and the payment providers, and queued jobs wait in Redis.

### 11. Backups and operations

- **PostgreSQL**: daily `pg_dump` (or your provider's point-in-time recovery). This holds everything
  that matters, including the wallet ledger and invoices.
- **Redis**: keep AOF persistence on; queued jobs live there.
- **S3 bucket**: media, imports, knowledge base files. Turn on versioning or replication.
- **`/etc/wacrm/wacrm.env`**: store a copy (especially `ENCRYPTION_KEY`) in a password manager or secrets vault.
- **Rotating the encryption key**: put the new key in `ENCRYPTION_KEY`, the old one in
  `ENCRYPTION_KEY_PREVIOUS`, restart, run `pnpm secrets:reencrypt`, then remove the old key.
- **Manual wallet credit**: `pnpm wallet:credit <org slug or id> <amount> "<reason>"`, or from `/admin`.
- Health checks for your monitoring: `GET /health/ready` on the API (checks the database),
  `GET :4001/health` on the worker, `GET /health` on the web.

---

## Deploying with Docker

Instead of the systemd setup above, you can run everything in containers. Each app has its own
Dockerfile, built from the repository root:

| Image          | Dockerfile                                       | Port | Notes                                                     |
| -------------- | ------------------------------------------------ | ---- | --------------------------------------------------------- |
| `wacrm-api`    | [apps/api/Dockerfile](apps/api/Dockerfile)       | 4000 | API, WebSocket gateway, webhooks                          |
| `wacrm-worker` | [apps/worker/Dockerfile](apps/worker/Dockerfile) | 4001 | Health port only; run as many as you need                 |
| `wacrm-web`    | [apps/web/Dockerfile](apps/web/Dockerfile)       | 3000 | Needs `--build-arg NEXT_PUBLIC_API_URL=...` at build time |
| `wacrm-tools`  | `apps/api/Dockerfile`, `--target tools`          |      | Migrations and operator scripts (`pnpm ...`)              |

The images run as the unprivileged `node` user with `NODE_ENV=production`, and each has a
`HEALTHCHECK`. They read their settings from the environment only.

[docker-compose.prod.yml](docker-compose.prod.yml) runs the whole stack on one host: PostgreSQL with
pgvector, Redis, API, worker and web. Object storage and SMTP stay external. The API and web are
published on `127.0.0.1` only, so put Nginx in front exactly as in step 8 above.

1. Install Docker Engine with the compose plugin, clone the repository, and create the env file:

   ```bash
   cp .env.example .env.production
   ```

   Fill it in as described in [Environment variables](#environment-variables), with these differences:
   add `POSTGRES_PASSWORD` (the database owner's password), and use the service names as hosts:

   ```ini
   POSTGRES_PASSWORD=<owner password>
   DIRECT_URL=postgresql://wacrm:<owner password>@postgres:5432/wacrm
   DATABASE_URL=postgresql://wacrm_app:<app password>@postgres:5432/wacrm
   REDIS_URL=redis://redis:6379
   ```

2. Build the images and start the database:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production --profile tools build
   ```

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres redis
   ```

3. Run the migrations, then create the runtime role (same rules as step 6 above):

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm tools
   ```

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production exec postgres psql -U wacrm -d wacrm -c "CREATE ROLE wacrm_app LOGIN PASSWORD '<app password>' NOSUPERUSER NOBYPASSRLS IN ROLE app_user;"
   ```

4. Start the apps:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```

5. Load plans and rate cards, and make yourself a platform admin (after signing up). Paths are inside
   the image, so put your own rate card CSV in `packages/db/prisma/` before building, or mount it:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm tools pnpm plans:import prisma/sample-plans.json
   ```

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm tools pnpm admin:grant you@example.com
   ```

To update: `git pull`, build again (step 2), run `tools` (migrations), then `up -d`. Back up the
`pgdata` volume (or `pg_dump` through `exec postgres`) and the `.env.production` file.

To use a managed PostgreSQL or Redis instead, point the URLs at them and leave out the `postgres` and
`redis` services. A managed database still needs pgvector and the runtime role. The
[Docker workflow](.github/workflows/docker.yml) builds the images and boots this stack on every push.

---

## Environment variables

[.env.example](.env.example) lists every variable with comments. Locally, copy it to `.env` in the repo
root. In production, set them in the process environment (step 5 above). An empty value (`KEY=`)
counts as unset. Variables are validated with Zod at start-up, and a process with a wrong or missing
required value refuses to start with a clear message.

"Apps" says which processes read a variable. When in doubt, give the API and the worker the same file.

### Core

| Variable              | Apps        | Required in prod | Description                                                                           |
| --------------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------- |
| `NODE_ENV`            | all         | yes              | `production` on a server. Turns on production checks and secure cookies.              |
| `LOG_LEVEL`           | api, worker |                  | pino level: `info` (default), `debug`, `warn`, `error`.                               |
| `APP_NAME`            | api, worker |                  | Product name in emails and as the 2FA issuer.                                         |
| `API_PORT`            | api         |                  | API port (4000).                                                                      |
| `WORKER_HEALTH_PORT`  | worker      |                  | Worker health check port (4001).                                                      |
| `WEB_URL`             | api, worker | yes              | Dashboard address, e.g. `https://app.example.com`. Used for CORS and email links.     |
| `NEXT_PUBLIC_API_URL` | web (build) | yes              | API address the browser uses, e.g. `https://api.example.com`. Baked in at build time. |
| `API_PUBLIC_URL`      | api, worker | yes              | API address outside services reach (integration webhooks, OAuth callbacks).           |
| `TRUST_PROXY`         | api         |                  | `true` behind Nginx or a load balancer, so client IPs are correct.                    |
| `SENTRY_DSN`          | —           |                  | Reserved for Sentry error reporting; not read by the code yet.                        |

### Database and Redis

| Variable                               | Apps                | Required | Description                                                                                    |
| -------------------------------------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | api, worker         | yes      | Runtime connection as the **non-owner** role in `app_user` (e.g. `wacrm_app`). Pooled is fine. |
| `DIRECT_URL`                           | migrations, scripts | yes      | Direct (not pooled) connection as the **schema owner**. Never give it to the running apps.     |
| `DATABASE_POOL_MAX`                    | api                 |          | Pool size per API process (10).                                                                |
| `REDIS_URL`                            | api, worker         | yes      | e.g. `redis://:password@127.0.0.1:6379`. Use `rediss://` for TLS.                              |
| `QUEUE_PREFIX`                         | api, worker         |          | Prefix for queue keys (`wacrm`). Change it to share one Redis between environments.            |
| `TEST_DATABASE_URL`, `TEST_DIRECT_URL` | tests               |          | Only for running the test suites.                                                              |

### Security

| Variable                   | Apps        | Required | Description                                                                                                                  |
| -------------------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`        | api         | yes      | At least 32 characters (`openssl rand -hex 32`). Signs 15-minute access tokens.                                              |
| `JWT_REFRESH_SECRET`       | api         | yes      | At least 32 characters, different from the above. Pepper for stored refresh and other tokens. Changing it logs everyone out. |
| `ACCESS_TOKEN_TTL_SECONDS` | api         |          | Access token lifetime (900).                                                                                                 |
| `REFRESH_TOKEN_TTL_DAYS`   | api         |          | Session lifetime (30).                                                                                                       |
| `COOKIE_SECURE`            | api         |          | Defaults to `true` in production. Needs HTTPS.                                                                               |
| `ENCRYPTION_KEY`           | api, worker | yes      | Base64 of 32 random bytes (`openssl rand -base64 32`). Encrypts all stored credentials. Back it up.                          |
| `ENCRYPTION_KEY_PREVIOUS`  | api, worker |          | Comma-separated old keys, only while rotating (see Backups and operations).                                                  |

### WhatsApp (Meta)

| Variable                         | Apps        | Required  | Description                                                                     |
| -------------------------------- | ----------- | --------- | ------------------------------------------------------------------------------- |
| `META_APP_ID`                    | api         | yes       | Meta app id.                                                                    |
| `META_APP_SECRET`                | api         | yes       | Meta app secret. Verifies webhook signatures.                                   |
| `META_WEBHOOK_VERIFY_TOKEN`      | api         | yes       | Any long random string; enter the same one in Meta's webhook settings.          |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | api         |           | Facebook Login for Business configuration id, for Embedded Signup.              |
| `META_GRAPH_API_VERSION`         | api, worker |           | Pinned Graph version (`v25.0`).                                                 |
| `ALLOW_MANUAL_CONNECT`           | api         |           | Show the "connect with a system-user token" form. Off by default in production. |
| `OUTBOUND_MPS_PER_NUMBER`        | worker      |           | Messages per second per number (80).                                            |
| `WEBHOOK_RETENTION_DAYS`         | worker      |           | Days to keep raw webhook events and delivery logs (30).                         |
| `WORKER_CONCURRENCY`             | worker      |           | Jobs at once per inbox queue (10).                                              |
| `META_GRAPH_BASE_URL`            | api, worker | **never** | Local fakes only. Refused in production.                                        |

### Storage and email

| Variable                                   | Apps        | Required | Description                                                                               |
| ------------------------------------------ | ----------- | -------- | ----------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`                              | api, worker | yes      | e.g. `https://<account>.r2.cloudflarestorage.com` or `https://s3.<region>.amazonaws.com`. |
| `S3_PUBLIC_ENDPOINT`                       | api         |          | Address browsers use for signed media links, if different from `S3_ENDPOINT`.             |
| `S3_REGION`                                | api, worker |          | `auto` for R2, the bucket region for S3.                                                  |
| `S3_BUCKET`                                | api, worker | yes      | Bucket name. Keep it private; the app hands out 5-minute signed links.                    |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | api, worker | yes      | Key with read and write on the bucket.                                                    |
| `SMTP_URL`                                 | api, worker | yes      | e.g. `smtps://user:pass@smtp.example.com:465`. Password must be URL-encoded.              |
| `MAIL_FROM`                                | api, worker | yes      | e.g. `"WhatsApp CRM <no-reply@example.com>"`, on a domain with SPF and DKIM set.          |

### Wallet, campaigns and billing

| Variable                                                                 | Apps        | Description                                                               |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------- |
| `WALLET_DEFAULT_CURRENCY`                                                | api         | Wallet currency for new workspaces (`INR`). Rate cards must exist in it.  |
| `WALLET_LOW_BALANCE_DEFAULT`                                             | api         | Low-balance alert threshold for new workspaces (100).                     |
| `CAMPAIGN_MPS_PER_NUMBER`                                                | worker      | Broadcast speed per number (40). Keep it below `OUTBOUND_MPS_PER_NUMBER`. |
| `CAMPAIGN_MAX_FAILURE_RATE`                                              | worker      | Auto-pause a campaign above this failure rate (0.2).                      |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                             | api, worker | Platform billing with Stripe. Both needed, or Stripe is off.              |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`      | api, worker | Platform billing with Razorpay. All three needed.                         |
| `BILLING_SELLER_NAME`, `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_TAX_ID` | api         | Your company details printed on invoices.                                 |
| `STRIPE_API_BASE`, `RAZORPAY_API_BASE`                                   | api, worker | Local fakes only. Refused in production.                                  |

### Public API

| Variable                     | Apps        | Description                                                                    |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `API_RATE_LIMIT_PER_MINUTE`  | api         | Requests per minute per API key (600).                                         |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | api, worker | Lets webhooks reach private addresses, for local tests. Refused in production. |

### Integrations and channels (all optional)

Each connector is offered only when all its values are set. Redirect URL for OAuth apps:
`<API_PUBLIC_URL>/integrations/oauth/callback`.

| Variable                                     | Apps        | Description                                                                           |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | api, worker | Shopify app. The secret also verifies its webhooks.                                   |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`   | api, worker | Google Sheets connector.                                                              |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | api, worker | HubSpot connector.                                                                    |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`   | api, worker | Instagram messaging channel.                                                          |
| `INTEGRATIONS_DEMO`                          | api, worker | `true` adds a Demo Store connector for trying things out. Keep `false` in production. |

### AI (optional)

| Variable                                               | Apps        | Description                                                                                 |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`                                          | api, worker | `anthropic` to turn AI on; empty = AI off. (`fake` is for tests and refused in production.) |
| `ANTHROPIC_API_KEY`                                    | api, worker | Claude API key.                                                                             |
| `AI_MODEL`                                             | api, worker | Model id, default `claude-opus-5-5`.                                                        |
| `AI_EMBEDDINGS_PROVIDER`                               | api, worker | `voyage` or `openai` (any OpenAI-compatible endpoint), for the knowledge base.              |
| `AI_EMBEDDINGS_MODEL`                                  | api, worker | Embedding model (must produce 1024 dimensions). Changing it means reindexing.               |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY`, `OPENAI_BASE_URL` | api, worker | Key for the chosen embeddings provider.                                                     |

AI usage is charged to the workspace wallet, so load `ai_input`, `ai_output` and `ai_embedding` rate
cards with `pnpm rates:import` before turning it on.

### Reports

| Variable                    | Apps   | Description                                                  |
| --------------------------- | ------ | ------------------------------------------------------------ |
| `ANALYTICS_ROLLUP_EVERY_MS` | worker | How often recent report data is recomputed (300000 = 5 min). |

### Minimal production example

```ini
NODE_ENV=production
LOG_LEVEL=info
APP_NAME="WhatsApp CRM"
API_PORT=4000
WORKER_HEALTH_PORT=4001
WEB_URL=https://app.example.com
NEXT_PUBLIC_API_URL=https://api.example.com
API_PUBLIC_URL=https://api.example.com
TRUST_PROXY=true

DATABASE_URL=postgresql://wacrm_app:APP-PASSWORD@127.0.0.1:5432/wacrm
DIRECT_URL=postgresql://wacrm:OWNER-PASSWORD@127.0.0.1:5432/wacrm
REDIS_URL=redis://127.0.0.1:6379

JWT_ACCESS_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -base64 32>

META_APP_ID=<from Meta>
META_APP_SECRET=<from Meta>
META_WEBHOOK_VERIFY_TOKEN=<openssl rand -hex 24>
META_EMBEDDED_SIGNUP_CONFIG_ID=<from Meta>
META_GRAPH_API_VERSION=v25.0

S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=wacrm-media
S3_ACCESS_KEY_ID=<key id>
S3_SECRET_ACCESS_KEY=<secret>

SMTP_URL=smtps://<user>:<password>@smtp.example.com:465
MAIL_FROM="WhatsApp CRM <no-reply@example.com>"

WALLET_DEFAULT_CURRENCY=INR
```

---

## Project status

The project is built in phases; [CLAUDE.md](CLAUDE.md) has the detailed design notes, decisions and
module status for each one, and the list of known gaps. Before going live with real customers, check
the items under "Known gaps / TODO" there, in particular: real Meta rate cards, sandbox payment
runs, Meta Business Verification and App Review, personal data erasure and 2FA recovery codes.

## License

Private and proprietary. All rights reserved.
