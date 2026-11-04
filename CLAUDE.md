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
| Storage       | S3-compatible (R2 / S3, MinIO locally)                                                                   |
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
pnpm docker:up          # local Postgres (pgvector/pg16), Redis 7, MinIO (console :9001)
pnpm docker:down
pnpm dev                # web :3000, api :4000, worker health :4001 (builds packages first)
pnpm lint               # eslint flat config at root, --max-warnings 0
pnpm format             # prettier write;  pnpm format:check in CI
pnpm typecheck
pnpm test               # vitest per package (unit + integration)
pnpm test:e2e           # Playwright (added later)
pnpm build
pnpm db:migrate         # prisma migrate (uses DIRECT_URL) -- Phase 1.2
pnpm db:seed            # Phase 1.2
pnpm db:studio          # Phase 1.2
pnpm --filter @wacrm/api dev   # run a single app
```

Health checks: `GET :4000/health` (api), `GET :4001/health` (worker), `GET :3000/health` (web).

```

## Environment

Validate with Zod at startup. Never commit real secrets. Keep `.env.example` current.

- `DATABASE_URL` pooled connection (runtime), `DIRECT_URL` direct connection (migrations)
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

- [ ] Section 1: Foundation, WhatsApp connection, live inbox (1.1 tooling DONE, 1.2 DB/tenancy, 1.3 auth, 1.4 gateway/onboarding/webhooks, 1.5 pipeline/inbox)
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

## Known gaps / TODO

- Docker is not installed on the dev machine yet; `docker-compose.yml` is unverified locally (needed from Phase 1.2).
- CI workflow exists but has not run yet (no GitHub remote configured).

- Verify current Meta pricing, messaging limits and partner requirements before finalizing billing logic.
- Confirm pgvector is available on the chosen Postgres host before Phase 3.7.
- Start Meta Business Verification and App Review early (needed for Embedded Signup at scale).
```
