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
pnpm docker:up          # Postgres 16 + pgvector (host :5433), Redis 7 (:6379), SeaweedFS S3 (:9000), Mailpit (SMTP :1025, inbox http://localhost:8025)
pnpm docker:down
cp .env.example .env    # first time only
pnpm db:setup           # first time: migrate:deploy + roles + seed
pnpm dev                # web :3000, api :4000, worker health :4001 (builds packages first)
pnpm lint               # eslint flat config at root, --max-warnings 0
pnpm format             # prettier write;  pnpm format:check in CI
pnpm typecheck
pnpm test               # vitest per package; db + api suites need Postgres + Redis up (they create *_test DBs)
pnpm test:e2e           # Playwright: real stack + fake Meta, own DB and ports. Needs docker:up and a build
pnpm build
pnpm db:migrate         # prisma migrate dev (DIRECT_URL); creates + applies migrations
pnpm db:migrate:deploy  # apply pending migrations only (CI / prod)
pnpm db:roles           # dev/CI: create the DATABASE_URL login role as a member of app_user
pnpm db:seed            # demo org "demo" with owner + agent (credentials in packages/db/prisma/seed.ts)
pnpm db:studio
pnpm --filter @wacrm/db run migrate:create -- --name <name>   # empty migration to hand-edit (RLS!)
pnpm --filter @wacrm/api dev   # run a single app
pnpm secrets:reencrypt  # key rotation: rewrite secrets still under an old ENCRYPTION_KEY
```

Health checks: `GET :4000/health` (api liveness), `GET :4000/health/ready` (api + DB), `GET :4001/health` (worker), `GET :3000/health` (web).

## Database and tenancy (Phase 1.2)

- Roles: migrations/seed/studio use the owner (`DIRECT_URL`). Runtime uses a separate login role in `DATABASE_URL` that is a member of the NOLOGIN group `app_user` (no superuser, no BYPASSRLS, owns nothing). Never run the app as the owner. On Neon/RDS create it by hand: `CREATE ROLE wacrm_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS IN ROLE app_user;`
- Context: `withTenant(client, { orgId, userId }, fn)` / `withDbContext` in `@wacrm/db` open a transaction and `set_config('app.org_id' | 'app.user_id' | 'app.partner_id', v, true)` (= SET LOCAL). Unset context sees nothing (fail closed). Ids are validated as UUIDs.
- Nest: `request.auth` (set by `AccessGuard`) -> `TenantContextInterceptor` puts it in AsyncLocalStorage -> `TenantPrismaService.run(tx => ...)` (needs org) / `runAsUser(...)` (org switcher). `AccessGuard` requires an org unless `@SkipTenant()`.
- Policies (`packages/db/prisma/migrations/*_rls`): tenant tables match `org_id = app_current_org_id()`; `memberships` also visible by `user_id`; `organizations` visible if current org or the user is an active member; `users` visible as self or member of current org; `partners` read-only; `audit_logs` append-only (SELECT/INSERT grants only).
- New tenant table checklist: `org_id uuid not null`, migration with `ENABLE` + `FORCE ROW LEVEL SECURITY` + policies. `rls-coverage.test.ts` fails the build if any table with `org_id` lacks RLS.
- Inserting a row Prisma reads back (`create`) also needs the SELECT policy to pass: e.g. create users with `app.user_id` set to the new id (generate UUIDs app-side).
- Lookups before any context exists (login by email, API key by prefix, webhook phone -> org) must go through reviewed `SECURITY DEFINER` SQL functions, added in the phase that needs them. Never connect as the owner to dodge RLS. Pattern (see `*_auth` migration): function owned by NOLOGIN role `app_definer`, `SET search_path = public, pg_temp`, read-only, keyed by email or an unguessable token hash, minimal columns, `EXECUTE` granted to `app_user` only; `app_definer` gets `FOR SELECT TO app_definer USING (true)` policies. Existing: `auth_lookup_user_by_email`, `auth_lookup_refresh_token`, `auth_lookup_auth_token`, `auth_lookup_invitation`.

## Auth and roles (Phase 1.3)

- One global guard, `AccessGuard` (apps/api/src/auth): bearer JWT -> live-session check (refresh family not revoked) -> user active -> role loaded FRESH from `memberships` each request -> org required unless `@SkipTenant()` -> `@RequirePermission(...)`. `@Public()` skips auth; `@Public({ optionalAuth: true })` parses a token if present.
- Roles/permissions: `packages/shared/src/permissions.ts` is the single map (`rolePermissions`, `hasPermission`, `canManageRole`). Never check role names in feature code. Owners manage everyone; admins manage admins + agents, never owners; nobody changes their own role or removes themselves; `LAST_OWNER` guards the last owner. Membership changes take a per-org `pg_advisory_xact_lock`.
- Tokens: access JWT HS256, 15 min, claims `sub`, `org`, `sid` (= refresh family id), `jti`; kept in memory on the web (Zustand), never localStorage. Refresh token: opaque 256-bit, stored as HMAC-SHA256 (pepper `JWT_REFRESH_SECRET`), httpOnly cookie `wacrm_rt` (Path=/auth, SameSite=Lax, Secure in prod), rotated on every refresh. Presenting a _rotated_ token again revokes the whole family (`REFRESH_REUSE_DETECTED`, audited). Logout and password reset revoke immediately (the guard checks the session on every request). `/auth/refresh` and `/auth/logout` also reject foreign `Origin` headers.
- Web refresh is single-flight within a tab and queued across tabs with a Web Lock (`refreshSession()` in `apps/web/src/lib/api.ts`), because rotating the same token twice looks like theft.
- Rate limits (Redis fixed window, `RateLimiter`): login 30/15 min per IP and 5 failures/15 min per email; 2FA 5 failures per user; signup 10/h per IP; forgot-password 10/h per IP and 3/h per email; invites 50/h per org.
- 2FA: own RFC 6238 TOTP (`@wacrm/shared/server`, verified against RFC vectors), secret envelope-encrypted with AAD `users:<id>:totp`, replay-protected via `users.totp_last_step`. Login with 2FA returns `{ mfaRequired, mfaToken }` (5 min JWT, separate audience), then `/auth/2fa/verify`.
- Emails (verify 24 h, reset 1 h, invite 7 d): single-use hashed tokens, links `${WEB_URL}/<page>?token=`. Sent in the background via `Mailer` (SMTP, Mailpit locally); failures are logged, not thrown. TODO: BullMQ queue (job data must not hold one-time links in plain text).
- Audit: `AuditService.record(tx, orgId, ...)` inside the same transaction as the change; user-level security events go to every org the user belongs to. Actions are the `AuditAction` constants. Settings > Audit log reads them with cursor pagination.
- Encryption: `SecretBox` (`@wacrm/shared/server`): per-value data key, KEK from `ENCRYPTION_KEY`, format `v1.<kid>...`. Rotation: put the new key in `ENCRYPTION_KEY`, the old one in `ENCRYPTION_KEY_PREVIOUS`, restart, run `pnpm secrets:reencrypt` (it reports rows it could not rewrite), then drop the old key.
- Web routes: `(auth)` login/signup/forgot-password/reset-password/verify-email/invite; `(app)` protected by `AuthGuard` (silent refresh, else `/login?next=`), shell with org switcher, user menu, verify-email banner, no-org state; settings: general, team, security (2FA), audit. UI gating uses `useCan(permission)`; the API is the authority.
- Tests: `apps/api/test/auth.test.ts` (flows), `team.test.ts` (role guards, invitations, owner safeguards, instant revocation, cross-tenant), `tenancy.test.ts`; `packages/db/test/auth-tables.test.ts` (auth table RLS + definer functions). Test helpers in `apps/api/test/helpers.ts` (`buildApp`, `Client` with cookie jar, `tokenFromMail`).
- Tests: `packages/db/test/isolation.test.ts` (cross-tenant suite, must always pass) and `apps/api/test/tenancy.test.ts` (both layers over HTTP). Shared helpers: `@wacrm/db/testing` (`prepareTestDatabase`, `testDbUrls`), test-only.

## WhatsApp (Phase 1.4)

Setup steps for a real number: `infra/whatsapp-setup.md`.

- `packages/whatsapp`: `WhatsAppGateway` (per-number client, returns `{ data, error }` with internal `WhatsAppErrorCode`s), `WapiCloudGateway` (SDK, `maxRetries: 0` because BullMQ owns retries), `GraphClient` (code exchange, WABA subscribe, phone and WABA details), `WhatsAppClientFactory` (LRU + 15 min TTL by `phone_number_id`; a cache hit must also match the org, otherwise it goes through the RLS-checked loader), webhook helpers. `test/contract.test.ts` pins requests, results and parsed event shapes. Fixtures in `test/fixtures.ts` are masked to fake values; its header says which follow captured traffic and which still follow Meta's docs.
- Webhook flow: `POST /webhooks/meta` verifies the signature on the raw bytes -> `webhook_event_ingest` stores one row per change (a delivery can span WABAs, so a row belongs to one tenant; its payload is itself a valid webhook body) -> job id = event id -> 200. Any failure answers 5xx so Meta redelivers; redelivery dedupes on the payload hash and re-enqueues only events still `received`.
- Event statuses: `received` -> `routed` (org assigned by the worker) / `ignored` (no live number) / `failed` (out of attempts). Phase 1.5 adds message handling and `processed`. Replay: `POST /whatsapp/webhook-events/:id/replay` resets to `received` and queues a new job; a routed event keeps its original org. Retention: daily job, `WEBHOOK_RETENTION_DAYS` (30).
- Worker also applies account events: `phone_number_quality_update` -> tier; `account_update` with `PARTNER_APP_UNINSTALLED` / `PARTNER_REMOVED` -> disconnect.
- Connect order: read WABA numbers with the token (proves access; a client cannot claim another customer's WABA) -> details -> subscribe -> register -> persist. All Meta calls are outside transactions. Nothing is stored unless subscribe succeeds. A failed registration keeps the connection as `registration_failed`, with a retry that accepts the existing 2-step PIN.
- Secrets: `phone_numbers.access_token_enc` and `registration_pin_enc` are `SecretBox` ciphertext with row-bound AAD (`phoneTokenAad`, `phonePinAad`). The token is per WABA, so reconnecting updates sibling numbers. DTOs are whitelist-mapped so they can never leak.
- Uniqueness: a WABA or number is live in at most one org (partial unique indexes, `WHATSAPP_ALREADY_CONNECTED`). Disconnect is soft: wipes credentials, keeps history; a disconnected number can reconnect anywhere.
- Pre-tenant functions (same pattern as auth, but some write): `webhook_event_ingest`, `webhook_event_load`, `webhook_route_lookup`, `webhook_event_mark`, `webhook_events_purge` (never touches events under a day old), `meta_connections_by_user`, `data_deletion_create` / `_status` / `_complete`, `secrets_list_phone_numbers`, `secrets_list_totp_users`. None returns a credential (tested). Migrations must `GRANT CREATE ON SCHEMA public TO app_definer` before taking function ownership and revoke it after.
- Meta callbacks: `POST /meta/deauthorize`, `POST /meta/data-deletion` (verified `signed_request`, form encoded), public status at `GET /meta/data-deletion/:code` and web `/data-deletion?code=`. Matched on `waba_accounts.meta_user_id`, which is only set when the JS SDK reports a user id.
- Queues: names and payloads in `packages/shared/src/queues.ts`; `QUEUE_PREFIX` (`wacrm`). Producers have the offline queue off, so a Redis outage fails fast.
- Local checks without Meta: `META_GRAPH_BASE_URL` points Graph calls at a fake (refused in production).
- Tests: `packages/whatsapp/test`, `apps/api/test/whatsapp.test.ts` (fake Graph, real DB and Redis), `apps/worker/test/processors.test.ts`, `packages/db/test/whatsapp-tables.test.ts`.

## Pipeline and inbox (Phase 1.5)

- Inbound: webhook -> `routeWebhookEvent` -> `processMessagesChange` (`apps/worker/src/processors/inbound.ts`): claims the wamid in `message_refs`, upserts contact and conversation, saves the message, sets `window_expires_at` (never backwards), reopens closed threads, publishes, queues media. Replays and redeliveries change nothing twice.
- Statuses: found through `biz_opaque_callback_data` (`<messageId>|<createdAt>`), so they work even before the send call returns; fall back to the wamid ref. Ticks only move forward; failed applies unless already read. Unknown wamids (other tools on the number) are ignored.
- Outbound: API checks window and number, saves `queued` with a client idempotency key, enqueues (job id = message id); if the queue is down the message is marked failed. Worker (`outbound.ts`) claims `sending` before calling Meta. A job that finds `sending` already set means a crash mid-send: it is failed with a clear message, never resent blind. Retryable errors go back to `queued` and throw so BullMQ retries; on the last attempt they become visible failures. Per-number limit: Redis 1-second counter, `OUTBOUND_MPS_PER_NUMBER`; over the limit parks the job without using an attempt.
- Window: `WINDOW_CLOSED` (409) from the API for text and media when `window_expires_at` is missing or past. Templates and internal notes are exempt. The UI locks too, including when the window lapses while open.
- `messages` is range-partitioned on `created_at`. PK is `(id, created_at)`, so reaching a row needs both: pass them around, or go through `message_refs`. **Partitions live in schema `message_partitions` with no grants to `app_user`**, because a partition queried directly skips the parent's RLS. A default partition catches rows if the job stops; `ensure_message_partitions` runs at worker start and daily, creating this month plus 3.
- Media: inbound bytes are copied to S3 by a `media-download` job; outbound uploads go through the API (allowlist and per-type size limits in `packages/shared/src/inbox.ts`), stored, then uploaded to Meta once by the worker. Keys: `orgs/<org>/messages/<id>`. Browsers get 5-minute signed links; non-media types download rather than render.
- Realtime: `RealtimeGateway` (Socket.IO + Redis adapter). Auth in middleware using the same `AuthenticatorService` as HTTP; a socket joins one org room from its verified token. The worker publishes with `@socket.io/redis-emitter`. Sockets close at token expiry and the client reconnects with a fresh token. Removal, logout and password reset disconnect immediately. Presence comes from the adapter's `fetchSockets`, so it needs no separate state. Clients refetch on every reconnect, since events are not replayed.
- Web: `RealtimeProvider` keeps the socket and cache in sync; `upsertMessage` is keyed by id because the HTTP response and socket event arrive in either order. Conversation list is virtualized; the chat pages older messages with a button.
- Permissions: agents can reply, add notes, self-assign unassigned conversations and release their own. `INBOX_ASSIGN` covers assigning others and managing labels and canned replies (Settings > Inbox).
- Tests: `apps/worker/test/pipeline.test.ts`, `apps/api/test/inbox.test.ts` (real sockets), `packages/db/test/inbox-tables.test.ts` (partition RLS bypass), `e2e/inbox.spec.ts` (two separate logged-in browsers).

## Environment

Validate with Zod at startup. Never commit real secrets. Keep `.env.example` current.

- `DATABASE_URL` pooled connection (runtime, non-owner app role), `DIRECT_URL` direct owner connection (migrations, seed)
- `TEST_DATABASE_URL`, `TEST_DIRECT_URL` (optional) base URLs for integration tests; each suite swaps in its own `*_test` database name
- `DATABASE_POOL_MAX` (api, default 10)
- `REDIS_URL`
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (min 32 chars; the refresh secret is also the HMAC pepper for stored opaque tokens), `ACCESS_TOKEN_TTL_SECONDS` (900), `REFRESH_TOKEN_TTL_DAYS` (30), `COOKIE_SECURE` (default true in production), `TRUST_PROXY`
- `ENCRYPTION_KEY` (base64 32-byte AES-256-GCM KEK), `ENCRYPTION_KEY_PREVIOUS` (comma-separated, rotation; see Auth section)
- `.env.example` ships DEV-ONLY secrets; the API refuses to start with `NODE_ENV=production` while any of them are still in use
- `SMTP_URL` (default `smtp://localhost:1025` = Mailpit), `MAIL_FROM`, `APP_NAME` (TOTP issuer, email copy)
- `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (required in production), `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_GRAPH_API_VERSION` (pinned, v25.0), `ALLOW_MANUAL_CONNECT` (default on outside production), `META_GRAPH_BASE_URL` (local fakes only)
- `QUEUE_PREFIX`, `WORKER_CONCURRENCY` (10), `WEBHOOK_RETENTION_DAYS` (30). An empty `KEY=` counts as unset
- `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (address browsers use for signed links), `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `OUTBOUND_MPS_PER_NUMBER` (80). The worker also needs `ENCRYPTION_KEY` and `META_GRAPH_API_VERSION`
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

- [ ] Section 1: Foundation, WhatsApp connection, live inbox (1.1 tooling DONE, 1.2 DB/tenancy DONE, 1.3 auth DONE, 1.4 gateway/onboarding/webhooks code DONE, 1.5 pipeline/inbox code DONE. CI green; real number connected by token; real inbound, outbound and ticks verified. Gate NOT passed: Embedded Signup and replay of a real event not verified)
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
- 2026-11-04: JWT via `jsonwebtoken` (HS256 pinned on verify), not `jose`: jose 6 is ESM-only and the API builds to CommonJS on Node 20.
- 2026-11-04: Own TOTP and base32 on node:crypto instead of otplib (small, RFC-vector tested, no dependency risk).
- 2026-11-04: Refresh tokens are opaque + hashed in Postgres (not JWTs) so they can be revoked and reuse can be detected. No grace window for concurrent refreshes; clients must single-flight.
- 2026-11-04: The guard reloads role and session from Postgres on every request (two indexed lookups) so removal, demotion, logout and password reset take effect immediately instead of at token expiry.
- 2026-11-04: Web auth is client-side (in-memory access token + silent refresh in `AuthGuard`), no Next middleware/BFF. Reason: the refresh cookie is scoped to the API's `/auth` path; keeps one source of truth for sessions.
- 2026-11-04: Local email via Mailpit (`axllent/mailpit:v1.27`) + nodemailer SMTP; prod uses any SMTP provider through `SMTP_URL`.
- 2026-11-04: Invited users who create their account through the invite link count as email-verified (the link proves inbox access). Invites for existing accounts require logging in as that email.
- 2026-11-04: No 2FA recovery codes yet (owners/admins cannot reset another user's 2FA either). TODO before launch: recovery codes.
- 2026-11-04: Server-side local service URLs use `127.0.0.1`, not `localhost`: on Windows `localhost` resolves to `::1` first and each new connection to Docker stalled 2-12 s (measured: SMTP 12.5 s vs 0.5 s). Browser-facing URLs stay on `localhost` so the API and web stay same-site for the refresh cookie.
- 2026-11-04: Emails are sent fire-and-forget (logged on failure) so SMTP latency never blocks a request; the BullMQ email queue replaces this in 1.5.
- 2026-11-04: CORS methods are set explicitly in `configureApp` (`@fastify/cors` defaults to GET/HEAD/POST, which silently broke every PATCH/DELETE from the browser; `inject()` tests cannot see CORS, so `tenancy.test.ts` asserts the preflight).
- 2026-11-04: API dev watcher is scoped with `--watch-path` (src + packages' dist). Plain `node --watch` restart-looped on files touched under node_modules.
- 2026-11-04: `prisma generate` is its own Turbo task (`generate`) that build/typecheck/dev/test depend on, so it runs once; parallel generates race on Windows.
- 2026-11-04: shadcn/ui components live in `apps/web/src/components/ui` (CLI-managed). The CLI wrote `import { cn } from "cn"` and added an unrelated npm package `cn`; imports were pointed at `@/lib/utils` and the package removed. Check this after every `shadcn add`.

- 2026-11-05: wapi-cloud pinned to exactly 1.1.0. It now also ships Embedded Signup, WABA subscribe, Calling and Groups, unlike the SDK rules above; 1.4 still follows those rules (code exchange and subscribe go directly to Graph). Whether to switch later is an open call for the project owner.
- 2026-11-05: One `webhook_events` row per change, not per delivery. Reason: one delivery can span several WABAs, and a row must belong to one tenant.
- 2026-11-05: Workers and webhooks use the same app role; pre-tenant steps go through narrow SECURITY DEFINER functions rather than the owner connection or BYPASSRLS.
- 2026-11-05: `messaging_tier` and `quality_rating` are plain strings: Meta changes these values, and limits belong in config. `messaging_limit_tier` is requested with a fallback, since Meta is migrating it.
- 2026-11-05: A data deletion request wipes Meta credentials and the Facebook user id, and disconnects; conversation data stays with the workspace as data controller. Worth a legal check before launch.
- 2026-11-05: Fixed the 1.3 auth migration for non-superuser owners (function ownership needs CREATE on the schema). Verified by deploying all migrations and the seed as a non-superuser on a clean container. Migrations had never been run on a real host, so editing it in place was safe.
- 2026-11-05: BullMQ job schedulers for repeatable work (`upsertJobScheduler`), so restarts and multiple workers keep one schedule.

- 2026-11-05: Partitions in a separate schema with no app-role grants: direct partition queries skip the parent's RLS, and Prisma only inspects `public`, so monthly partitions are not drift.
- 2026-11-05: `message_refs` table for wamid and client-key uniqueness, since unique indexes on a partitioned table must include the partition key.
- 2026-11-05: At-most-once for interrupted sends: a crash mid-call marks the message failed rather than risk a duplicate to the customer. BullMQ retries still apply to errors Meta reports as retryable, per the SDK rules; a timeout after Meta accepted can therefore still duplicate, because Graph has no idempotency key.
- 2026-11-05: One conversation per (number, contact), reopened by new messages; unread count is shared by the team, not per agent.
- 2026-11-05: Own per-number rate limit (Redis counter + `moveToDelayed`): BullMQ's per-group limits are Pro-only.
- 2026-11-05: Uploads are buffered in the API and capped at 25 MB (Meta allows 100 MB for documents). Revisit with direct-to-S3 presigned uploads.
- 2026-11-05: Playwright e2e runs a production web build with its own DB, ports and queue prefix; on this drive `next dev` route compilation is too slow to wait on. Fake Meta in `e2e/support/fake-graph.mjs` sends signed status webhooks back.
- 2026-11-05: BullMQ email queue deferred from 1.5: bodies hold one-time links, so it needs encrypted job data. Background sends remain.
- 2026-11-05: Code lives in the private repo `niyassby/whatsapp-cloud-crm`; CI runs on pushes to `main`.
- 2026-11-05: Embedded Signup targets v4 (`extras: { setup: {} }`, the version Meta serves by default). v5 exists, but its page was not reviewed. WhatsApp Business app numbers are refused until connecting can skip registration.

## Known gaps / TODO

- Section 1 gate still open: Embedded Signup through the Meta popup (needs `META_EMBEDDED_SIGNUP_CONFIG_ID`) and replay of a real event from Settings > WhatsApp.
- Live payloads carry `contacts[].user_id`, `messages[].from_user_id` and `statuses[].recipient_user_id` (format `IN.…`), and `pricing` on statuses. The app ignores all of them and keys contacts on `wa_id`. Decide how to store the user id, and use `pricing` when billing arrives.
- The first connected number has an empty `messaging_tier` and quality `UNKNOWN`. Check that they fill in, since campaign limits in Section 2 depend on them.
- Template picker only sends body variables; templates with media headers, header variables or button variables are hidden until Section 2.
- Sends on one conversation can reorder under concurrency or retries. No manual retry button on failed messages yet.
- Inbound `system` and `request_welcome` messages are skipped. Opt-out keywords arrive in Section 2.
- The FB JS SDK popup has never run against Meta; only its message parsing is tested. Inbound media, failed sends, template status and quality events have no live capture yet.
- Data deletion only matches connections with a stored `meta_user_id`; manual connects have none, and FB.login may not report one with `response_type: code`. Check on the first real signup.
- No mobile navigation: the main sidebar is hidden below `md` with no replacement.
- Settings > WhatsApp shows the raw event type; friendlier labels can wait for the inbox.

- Verify current Meta pricing, messaging limits and partner requirements before finalizing billing logic.
- Confirm pgvector is available on the chosen production Postgres host before Phase 3.7 (local image has pgvector 0.8.7).
- Start Meta Business Verification and App Review early (needed for Embedded Signup at scale).
