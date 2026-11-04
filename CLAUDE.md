# CLAUDE.md

Project guide for Claude Code. Read this at the start of every session. Keep it updated after each phase (commands, decisions, module status).

## Project

Multi-tenant **WhatsApp Cloud API CRM SaaS** (similar to Wati / Gallabox). Businesses connect their own WhatsApp Business number through Meta Embedded Signup, then use a shared team inbox, template broadcasts, chatbot flows, light CRM, integrations (Shopify, WooCommerce, Razorpay, Stripe, Zapier/Make, etc.) and a public API. Resellers can onboard and manage client workspaces.

**Out of scope for now:** white-label, custom branding, reseller themes, custom domains. Do not build them. Leave a short `TODO(branding)` comment only where they would plug in later.

## Stack (fixed, do not substitute)

| Area          | Choice                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Monorepo      | pnpm workspaces + Turborepo, TypeScript strict, Node 20+                                                 |
| Web           | Next.js (App Router, v16), React (letest), Tailwind (v4), shadcn/ui, TanStack Query, Zustand, React Flow |
| API           | NestJS (Fastify adapter), modular monolith, Socket.IO + Redis adapter                                    |
| Worker        | BullMQ workers, separate entry point in `apps/worker`                                                    |
| Database      | PostgreSQL (self-hosted) via Prisma. Plain Postgres only, no Supabase-specific APIs                      |
| Cache/Queue   | Redis + BullMQ                                                                                           |
| Storage       | S3-compatible (R2 / S3, SeaweedFS locally)                                                               |
| Auth          | Own email+password (argon2id), JWT access + rotating refresh tokens, optional TOTP 2FA                   |
| WhatsApp      | `wapi-cloud` npm SDK, wrapped by `packages/whatsapp`                                                     |
| Observability | pino logs, Sentry, Bull Board (admin only)                                                               |

## Repo layout

```
apps/
  web/        Next.js dashboard
  api/        NestJS API + WebSocket gateway + webhook receivers
  worker/     BullMQ processors (inbound, outbound, campaigns, flows, integrations, sync)
packages/
  db/         Prisma schema, migrations, RLS SQL, TenantPrisma helper
  shared/     Zod schemas, DTO types, error codes, permission map
  whatsapp/   WhatsAppGateway interface + wapi-cloud implementation
  connectors/ Integration connectors (shopify, woocommerce, razorpay, stripe, ...)
  ui/         Shared React components
infra/        Docker, CI, deployment notes
```

## Commands

Package manager: pnpm 9 (`packageManager` pinned in root package.json). Packages are named `@wacrm/*`.

```
pnpm install
pnpm docker:up          # local Postgres 16 + pgvector (host :5433), Redis 7 (:6379), SeaweedFS S3 (:9000)
pnpm docker:down
cp .env.example .env    # first time only
pnpm db:setup           # first time: migrate:deploy + roles + seed
pnpm dev                # web :3000, api :4000, worker health :4001 (builds packages first)
pnpm lint               # eslint flat config at root, --max-warnings 0
pnpm format             # prettier write;  pnpm format:check in CI
pnpm typecheck
pnpm test               # vitest per package; db + api suites need Postgres up (they create *_test DBs)
pnpm test:e2e           # Playwright (added later)
pnpm build
pnpm db:migrate         # prisma migrate dev (DIRECT_URL); creates + applies migrations
pnpm db:migrate:deploy  # apply pending migrations only (CI / prod)
pnpm db:roles           # dev/CI: create the DATABASE_URL login role as a member of app_user
pnpm db:seed            # demo org "demo" with owner + agent (credentials in packages/db/prisma/seed.ts)
pnpm db:studio
pnpm --filter @wacrm/db run migrate:create -- --name <name>   # empty migration to hand-edit (RLS!)
pnpm --filter @wacrm/api dev   # run a single app
```

Health checks: `GET :4000/health` (api liveness), `GET :4000/health/ready` (api + DB), `GET :4001/health` (worker), `GET :3000/health` (web).

## Database and tenancy (Phase 1.2)

- Roles: migrations/seed/studio use the owner (`DIRECT_URL`). Runtime uses a separate login role in `DATABASE_URL` that is a member of the NOLOGIN group `app_user` (no superuser, no BYPASSRLS, owns nothing). Never run the app as the owner. On Neon/RDS create it by hand: `CREATE ROLE wacrm_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS IN ROLE app_user;`
- Context: `withTenant(client, { orgId, userId }, fn)` / `withDbContext` in `@wacrm/db` open a transaction and `set_config('app.org_id' | 'app.user_id' | 'app.partner_id', v, true)` (= SET LOCAL). Unset context sees nothing (fail closed). Ids are validated as UUIDs.
- Nest: `request.auth` (set by the auth guard) -> `TenantContextInterceptor` puts it in AsyncLocalStorage -> `TenantPrismaService.run(tx => ...)` (needs org) / `runAsUser(...)` (org switcher). Global `TenantGuard` requires an org unless `@SkipTenant()`.
- Policies (`packages/db/prisma/migrations/*_rls`): tenant tables match `org_id = app_current_org_id()`; `memberships` also visible by `user_id`; `organizations` visible if current org or the user is an active member; `users` visible as self or member of current org; `partners` read-only; `audit_logs` append-only (SELECT/INSERT grants only).
- New tenant table checklist: `org_id uuid not null`, migration with `ENABLE` + `FORCE ROW LEVEL SECURITY` + policies. `rls-coverage.test.ts` fails the build if any table with `org_id` lacks RLS.
- Inserting a row Prisma reads back (`create`) also needs the SELECT policy to pass: e.g. create users with `app.user_id` set to the new id (generate UUIDs app-side).
- Lookups before any context exists (login by email, API key by prefix, webhook phone -> org) must go through reviewed `SECURITY DEFINER` SQL functions, added in the phase that needs them. Never connect as the owner to dodge RLS.
- Tests: `packages/db/test/isolation.test.ts` (cross-tenant suite, must always pass) and `apps/api/test/tenancy.test.ts` (both layers over HTTP). Shared helpers: `@wacrm/db/testing` (`prepareTestDatabase`, `testDbUrls`), test-only.

## Environment

Validate with Zod at startup. Never commit real secrets. Keep `.env.example` current.

- `DATABASE_URL` pooled connection (runtime, non-owner app role), `DIRECT_URL` direct owner connection (migrations, seed)
- `TEST_DATABASE_URL`, `TEST_DIRECT_URL` (optional) base URLs for integration tests; each suite swaps in its own `*_test` database name
- `DATABASE_POOL_MAX` (api, default 10)
- `REDIS_URL`
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`
- `ENCRYPTION_KEY` (AES-256-GCM key for tokens and credentials; rotation procedure documented)
- `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_API_VERSION` (pinned)
- `S3_*` storage settings
- `RAZORPAY_*`, `STRIPE_*` for platform billing
- `SENTRY_DSN`

## Architecture rules (must follow)

1. **Webhooks are tiny:** verify signature on the RAW body, store raw event in `webhook_events`, enqueue, return 200. All logic runs in workers.
2. **Outbound messages always go through a queue** with per-phone-number rate limiting, retries with backoff and idempotency keys.
3. **Tenancy in two layers:** Nest tenant guard/context AND Postgres Row Level Security via `SET LOCAL app.org_id` in each request transaction. Every tenant table has `org_id`. Never bypass RLS in app code. Review every raw SQL query.
4. **Wallet is an append-only ledger** (`wallet_ledger`). Never store only a balance. Debit in a DB transaction with a row lock. Snapshot the applied rate per entry.
5. **Idempotency everywhere:** payment webhooks, Meta webhooks, Shopify webhooks, campaign sends, wallet credits.
6. **Secrets encrypted at rest** (AES-256-GCM envelope). Never log tokens, never return them from the API.
7. **`messages` is partitioned by month.** Cursor pagination only, never offset.
8. **Validate all input with Zod** from `packages/shared`. Share types between web and api.
9. **Config over code** for Meta pricing, messaging tiers and rate cards. Store in tables or config, never hard-code.
10. **Feature flags per plan** for extended modules (Calling, Groups, catalog, AI, extra channels).

## wapi-cloud SDK rules

The package is young and single-maintainer. Treat it as replaceable.

- Import `wapi-cloud` **only** inside `packages/whatsapp`. The rest of the app uses the `WhatsAppGateway` interface.
- One SDK instance binds one access token / phone number ID / WABA ID. Use the client factory with an LRU cache keyed by `phone_number_id`.
- SDK calls never throw; they return `{ data, error }`. Always check `error`. If `error.isRetryable`, throw inside the BullMQ job so it retries. Otherwise mark failed with a mapped internal error code.
- Webhooks: use only `verifySignature` and `parse`. Do **not** use the one-line Express handler (it processes inline).
- Not covered by the SDK (implement directly against the Graph API inside `packages/whatsapp`): Embedded Signup, WABA webhook subscription, Calling, Groups, catalog/commerce messages.
- Keep contract tests with recorded Meta payload fixtures so swapping or forking the SDK is safe.

## WhatsApp platform rules to respect

- 24-hour customer service window: free-form replies only inside it; otherwise approved templates only. Enforce server-side, not just in the UI.
- Marketing sends require recorded opt-in. Honor STOP/opt-out keywords.
- Respect messaging tier limits and quality rating; auto-pause campaigns on low quality.
- Media URLs from Meta expire: download to object storage in a background job.

## Conventions

- TypeScript strict, no `any` without a comment. ESLint + Prettier enforced by Husky.
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`). One commit per finished phase at minimum.
- Nest: one module per domain (auth, orgs, contacts, conversations, messages, templates, campaigns, wallet, billing, flows, integrations, reseller, ai). Controllers thin, logic in services, DTOs from `packages/shared`.
- Frontend: server components by default, client components only when needed. Data fetching via TanStack Query. Use cursor pagination and list virtualization for inbox and contacts.
- Tests: unit tests for wallet, campaigns, flow engine, tenancy, connectors. Integration tests with a real Postgres. Playwright e2e for critical flows. Cross-tenant isolation tests must always pass.
- Error handling: typed errors with stable codes from `packages/shared`. No silent catches.

## Working agreement

- Work **one phase at a time** following the Master Build Prompt (4 sections, each with phases).
- End of each phase: run lint, typecheck, tests and build; commit; update this file; report what was built and how to verify; then **stop and wait** for "next phase".
- Ask only when blocked by a missing credential or an ambiguous product decision. Otherwise choose a sensible default and record it under Decisions.
- Do not start the next section until the current section's Gate checklist passes.

## Module status

Mark as phases complete.

- [ ] Section 1: Foundation, WhatsApp connection, live inbox (1.1 tooling DONE, 1.2 DB/tenancy DONE, 1.3 auth, 1.4 gateway/onboarding/webhooks, 1.5 pipeline/inbox)
- [ ] Section 2: Contacts, templates, campaigns, billing, public API (2.1 to 2.6)
- [ ] Section 3: Automation, integrations, AI (3.1 to 3.7)
- [ ] Section 4: Reseller, extended modules, analytics, security, launch (4.1 to 4.5)

## Decisions log

Add one line per decision: date, decision, reason.

- Stack fixed: NestJS + Next.js + PostgreSQL (Neon / RDS / self-hosted) + Redis/BullMQ.
- wapi-cloud wrapped behind `WhatsAppGateway`; gaps implemented directly on the Graph API.
- White-label and custom branding deferred until after Section 4.
- Platform billing via Razorpay and Stripe behind a `PaymentProvider` interface.
- 2026-11-04: Workspace packages compile to CommonJS `dist/` with tsc; turbo `dev`/`typecheck`/`test` depend on `^build`. Reason: Nest needs plain JS + decorator metadata, Next consumes them fine.
- 2026-11-04: API dev runs via `node --watch -r @swc-node/register` and tests via vitest + `unplugin-swc` (tsx/esbuild cannot emit decorator metadata needed by Nest DI). Worker uses tsx.
- 2026-11-04: Env validation via `parseEnv(schema)` in `packages/shared` (Zod 4); each app owns its `src/env.ts` schema and adds vars as phases need them. `.env.example` at root lists everything.
- 2026-11-04: Single root ESLint flat config (typescript-eslint + prettier). Rule `no-restricted-imports` blocks `wapi-cloud` outside `packages/whatsapp`.
- 2026-11-04: Worker exposes a tiny HTTP `/health` on `WORKER_HEALTH_PORT`; BullMQ processors arrive in Phase 1.5.
- 2026-11-04: Local S3 is SeaweedFS (`chrislusf/seaweedfs:4.50`) instead of MinIO. Reason: MinIO no longer publishes free images (Docker Hub pull denied, quay.io 401). App code only uses the S3 API, so prod R2/S3 is unaffected. Dev creds live in `infra/seaweedfs/s3.json`; endpoint `http://localhost:9000`.
- 2026-11-04: Prisma pinned to 7.10.1 (npm `latest` tag currently points at an 8.0 RC). Prisma 7 layout: `prisma-client` generator (CJS) into `packages/db/src/generated` (gitignored, built by `prisma generate`), `@prisma/adapter-pg` driver adapter, CLI URL in `prisma.config.ts`.
- 2026-11-04: Docker Postgres is published on host port 5433, because a native Windows Postgres already owns 5432 on the dev machine.
- 2026-11-04: Tenancy = two roles (owner for migrations, `app_user` member for runtime) + FORCE RLS + `set_config(..., true)` per transaction. Context ids are UUIDs (uuid v7 defaults in Prisma). Reason: RLS only works if the runtime role is neither owner nor BYPASSRLS.
- 2026-11-04: `TenantPrismaService.run()` opens one short transaction per unit of work, not one per whole request. Reason: avoids holding pooled connections across external calls (Meta API, S3). Every call still runs under SET LOCAL.
- 2026-11-04: Request context via a global interceptor + AsyncLocalStorage (no nestjs-cls). The auth guard (1.3) sets `request.auth`; guards run before interceptors.
- 2026-11-04: `users` is global (one identity, many orgs via memberships). Emails are stored lower-cased (CHECK constraint). Insert is open (signup/invites); read is self or same-org; update is self only.
- 2026-11-04: Password hashing: `@node-rs/argon2` (argon2id, prebuilt binaries, no node-gyp on Windows). Used by the seed now, by auth in 1.3.
- 2026-11-04: `fastify` in apps/api is pinned to the exact version `@nestjs/platform-fastify` uses, so the `request.auth` type augmentation applies. Bump both together.
- 2026-11-04: ESLint parses apps/api with `emitDecoratorMetadata` so `consistent-type-imports` never turns injected classes into `import type` (that would break Nest DI at runtime).
- 2026-11-04: Turbo `test` is uncached (integration tests depend on live DB state); DB env vars are in `globalPassThroughEnv`.

## Known gaps / TODO

- CI workflow exists but has not run yet (no GitHub remote configured).
- Verify current Meta pricing, messaging limits and partner requirements before finalizing billing logic.
- Confirm pgvector is available on the chosen production Postgres host before Phase 3.7 (local image has pgvector 0.8.7).
- Start Meta Business Verification and App Review early (needed for Embedded Signup at scale).
