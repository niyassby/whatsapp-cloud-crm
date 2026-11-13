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
  billing/    PaymentProvider interface + Stripe and Razorpay adapters (platform billing)
  connectors/ Integration connectors (shopify, woocommerce, ...)
  ui/         Shared React components
infra/        Docker, CI, deployment notes
```

## Commands

Package manager: pnpm 9 (`packageManager` pinned in root package.json). Packages are named `@wacrm/*`.

```
pnpm install
pnpm services:up       # no Docker: starts SeaweedFS S3 (:9000) and Mailpit (SMTP :1025, inbox http://localhost:8025) from .tools/, checks Postgres (:5433) and Redis (:6379) services. See infra/native-setup.md
pnpm services:status   # check all four answer
pnpm services:down
pnpm docker:up          # alternative: the same services in Docker (Postgres 16 + pgvector). Not both at once
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
pnpm rates:import <file.csv>                       # add rate cards: country,category,currency,rate,valid_from
pnpm wallet:credit <org slug or id> <amount> "<reason>"   # manual balance adjustment
pnpm plans:import prisma/sample-plans.json         # plans and prices; path is relative to packages/db
pnpm admin:grant <email> [--revoke]                # make an existing account a platform admin (/admin)
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

## Contacts and consent (Phase 2.1)

- Contacts are soft-deleted and soft-merged (`deleted_at`, `merged_into_id`; the app role has no DELETE). The row keeps the number and consent, so an opt-out survives a delete and re-import. `liveContactWhere` is the definition of a visible contact. A message from a deleted contact brings it back; a message from a merged number goes to the primary.
- `wa_id` is E.164 digits without the plus. `normalizePhone` (`@wacrm/shared/server`, libphonenumber-js) is used for manual entry and imports. Numbers from Meta webhooks are stored as sent.
- Inbound names: the WhatsApp profile name only fills an empty name.
- Consent: `contacts.opt_in_*` is the current state; `contact_consent_events` is the append-only proof (no UPDATE or DELETE grant). Always change it through `setContactConsent` (`@wacrm/db`), or the bulk and import paths that also write events. Opting in needs a source and proof. There is no bulk opt-in. An import can attest consent for a file, but only moves `unknown` to `opted_in`, never `opted_out`.
- Marketing block: `canReceiveMarketing` + `isMarketingCategory` (shared). Enforced in the API (`CONTACT_NOT_OPTED_IN`, 409), again by the worker at send time (the template's category is stored in the message content), and in the template picker. Utility templates and replies still reach opted-out contacts. Section 2.4 campaigns must use the same check.
- Opt-out keywords: `isOptOutMessage` matches the whole message, ignoring case and punctuation, on `text`, `button` and `interactive` messages only. `organizations.opt_out_keywords` overrides `DEFAULT_OPT_OUT_KEYWORDS` (Settings > Contacts). It runs in the inbound transaction, after the wamid claim, so a replay cannot repeat it.
- Custom fields: definitions in `contact_fields`, values in `contacts.custom_fields` (JSONB), checked by `coerceFieldValue`. Deleting a definition keeps stored values, so adding the key back restores them.
- Segments: `segments.filter` (`segmentFilterSchema`) compiles to a Prisma `where` in `segmentFilterToWhere` (`@wacrm/db`). No stored counts; counts run on request. Not-equal includes contacts with no value.
- Import and export: `contact_jobs`, queue `contact-jobs` (concurrency 2, separate from inbox queues), processor `apps/worker/src/processors/contact-jobs.ts`. The API only stores the file (50 MB limit) and checks the mapped headers. The worker streams with csv-parse, one set-based upsert per 1000 rows in its own transaction, and publishes `contact-job:updated` per batch. A retry re-runs the file safely. Per-row errors go to a CSV report. Exports resolve the segment when started and neutralize spreadsheet formulas (`csvCell`). Starting and downloading exports are audited.
- Merge (`ContactsService.merge`): primary values win, an opt-out on any contact wins. A moved thread loses its 24-hour window, because the window belongs to the number that wrote in and replies go to the primary's number. Emptied threads stay, hidden from the inbox.
- Permissions: `CONTACTS_WRITE` covers single contacts, tags and notes (agents). `CONTACTS_MANAGE` covers import, export, bulk, delete, merge, fields, keywords and saving segments (owners and admins).
- Web: `/contacts` (virtualized table, filters, bulk bar, jobs panel), `/contacts/[id]`, `/contacts/segments`, Settings > Contacts.
- Tests: `apps/worker/test/contacts.test.ts` (import rules, 50k import, keywords, send-time block), `apps/api/test/contacts.test.ts`, `packages/db/test/contacts-tables.test.ts` (isolation, append-only), `contacts-filter.test.ts` (every rule type), `e2e/contacts.spec.ts`.

## Templates (Phase 2.2)

- `message_templates`: one row per WABA, name and language. Meta is the authority. Status and category are strings, since Meta adds values. `definition` is our own `TemplateDefinition` (`packages/shared/src/templates.ts`), with `toMetaComponents` and `fromMetaComponents` converting to and from Meta's shape, and `templateIssues` holding Meta's documented rules. The builder, API and worker share all of it.
- Editing: a draft changes locally. A submitted template changes at Meta first, and nothing is saved unless Meta accepts it, so the local copy never differs from what Meta reviewed. Name and language are fixed once submitted. Meta accepts edits when approved, rejected or paused; an approved template keeps its category. Changing only `variable_mapping` stays local and needs no review. Compare stored JSON with `sameJsonValue`: Postgres reorders jsonb keys.
- Sending: the inbox reads the local copy (no Meta call per send) and sends by `templateId` plus `variables`. Keys are `header.<name>`, `body.<name>`, `button.<index>.<name>`, `button.<index>.code`. The API builds the components with `buildSendComponents` and stores them on the message; the worker only adds a media header. Values have whitespace collapsed, because Meta refuses line breaks in parameters. Link values are percent-encoded. The picker fills values from `variable_mapping` with `resolveVariable`, and agents can change them.
- Media headers: `POST /templates/:id/header-media` stores the file (`header_media_key`). It is both the sample for review, uploaded through Meta's Resumable Upload API on each submit, and what customers receive. A send copies the key onto the message, and the worker uploads it to Meta once per message.
- Status sync: `applyTemplateEvent` handles `message_template_status_update`, `template_category_update`, `message_template_quality_update` and `message_template_components_update`. `status_at` stops an older event moving a template backwards. An unknown template, or a change the payload does not fully describe, queues a sync. `applyTemplateSync` compares with Meta's full list: queue `template-sync`, hourly for every WABA from `template_sync_targets()`, after connecting a number, on first use of the picker, and from the Sync button. It keeps the local mapping and header file, and marks templates gone from Meta as `deleted`, with a 5-minute grace after submitting.
- Delete: `gateway.deleteTemplate({ name, templateId })` uses `hsm_id`, because the name alone deletes every language. It goes through Graph directly, as does listing, since the SDK cannot ask for `rejected_reason` or `quality_score`.
- Templates Meta holds that this app cannot represent (authentication, carousels, flows, location headers, other buttons) sync as `supported: false`: visible, not editable or sendable.
- Permissions: `TEMPLATES_READ` (agents), `TEMPLATES_MANAGE` (owners and admins).
- Web: `/templates`, `/templates/new`, `/templates/[id]` (`TemplateForm` with live `TemplatePreview`). Status updates arrive over `template:updated`.
- Tests: `packages/shared/src/templates.test.ts`, `apps/api/test/templates.test.ts` (scripted Graph), `apps/worker/test/templates.test.ts`, `packages/db/test/templates-tables.test.ts`, `e2e/templates.spec.ts`. The fake Meta approves templates by webhook, and rejects names ending in `_rejected`.

## Wallet and rate cards (Phase 2.3)

- Money is whole micro-units (1 unit = 1,000,000) in BIGINT, never floats. `decimalToMicros`, `microsToDecimal` and `formatMoney` are in `packages/shared/src/wallet.ts`. DTOs carry `*Micros` numbers.
- `wallet_ledger` is the record of every movement: append-only (no UPDATE or DELETE grant), with the rate, country and category copied onto each entry. `wallets.balance_micros` is its running total. CHECK constraints refuse a negative balance, a hold above the balance, and a negative `balance_after`, even if the code were wrong.
- All money moves through `packages/db/src/wallet.ts`, inside the transaction of what it pays for: `creditWallet`, `debitWallet`, `refundDebit`, `reserveFunds`, `releaseReservation`, `chargeMessage`. Each takes the row lock first (`SELECT ... FOR UPDATE`), so changes to one wallet happen one at a time. Each has an idempotency key, unique per org. No workspace can add money to its own wallet over HTTP; only a partner (for its client) or a platform admin can, audited (Phase 4.1).
- Charging: `chargeMessage` runs in the transaction that creates the message, after the client-key claim, so a message and its charge exist together or not at all. A refused send rolls back and the same key can retry. `messageDebitKey(messageId)` is the debit's key.
- What is charged: templates, at the rate for the recipient's country from the wa_id, falling back to `*`. Marketing and authentication always. Utility only outside the 24-hour window. Free-form replies are free, and keep working at zero balance. A chargeable send with no rate is refused (`RATE_NOT_CONFIGURED`), never given away. A zero rate is free.
- Refunds: `refundDebit`, once per debit, carrying its rate and category. Triggered by any failure in `outbound.ts` (including an interrupted send and marketing refused at send time), a `failed` status webhook, `pricing.billable: false` on any status, and a failure to queue. Retries keep the charge until the last attempt.
- Reservations (for 2.4 campaigns): `reserveFunds` lowers what is available without changing the balance; `debitWallet` with `reservationId` spends from it; `releaseReservation` returns the rest. Holds past `expires_at` are released on the next reservation, so a crashed campaign cannot strand money.
- Rate cards: `rate_cards` has no org_id, since prices are the same for every org, and the app role can only read it. A new price is a new row with a later `valid_from`. `findRate` takes the newest in force. Load with `pnpm rates:import <file.csv>`. `packages/db/prisma/sample-rate-cards.csv` is sample data, not Meta's prices.
- Manual credit: `pnpm wallet:credit <org slug or id> <amount> "<reason>"`, an operator tool using the owner connection, recorded as an `adjustment`, or from `/admin` (4.1). Top-ups through payments arrive in 2.5.
- Low balance: `debitWallet` reports `crossedLowBalance` once per crossing (`low_balance_alerted_at`, cleared when the balance recovers). The API emails people with `BILLING_MANAGE` in the background, and the web shows `LowBalanceBanner`. The threshold starts at `WALLET_LOW_BALANCE_DEFAULT`.
- Permissions: `WALLET_READ` (owners, admins), `BILLING_MANAGE` (owners) for settings.
- Web: `/wallet`. Updates arrive over `wallet:updated`.
- Tests: `packages/db/test/wallet.test.ts` (the acceptance test, 200 parallel debits with funds for 50. Removing the row lock makes it fail, which was checked), `apps/api/test/wallet.test.ts` (the same over HTTP), `apps/worker/test/wallet.test.ts` (refunds), `e2e/wallet.spec.ts`.

## Campaigns and dashboard (Phase 2.4)

- Tables: `campaigns`, `campaign_recipients` (one per contact, no DELETE grant), `messaging_tier_limits` (config, read-only to the app), `drip_sequences`, `drip_steps`, `drip_enrollments` (no DELETE grant). Rules and DTOs in `packages/shared/src/campaigns.ts`, database helpers in `packages/db/src/campaigns.ts`, the engine in `apps/worker/src/processors/campaigns.ts` and `drips.ts`.
- Queue: `campaigns`, with its own worker (concurrency 4), separate from the inbox queues. Jobs are `prepare`, `dispatch` and `drip`. A campaign is a chain of short `dispatch` jobs, one per batch, so a pause or cancel takes effect by the next batch. `campaign-tick` runs every 30 seconds: `campaign_tick_targets` finds scheduled campaigns that are due, and running ones with no progress for 2 minutes (a lost job chain), and `drip_due_targets` finds due drips. Both are definer functions returning only ids.
- Life of a campaign: `draft` -> `scheduled` -> `preparing` (recipients written in batches, skip reasons recorded, funds held) -> `running` -> `completed`. Also `paused`, `cancelled` and `failed`. Launch copies a segment's filter onto the campaign (`filterSnapshot`), so editing the segment later changes nothing. CSV files are read at prepare, and new numbers become contacts with no consent.
- Who is skipped: `broadcastSkipReason`. Opted-out contacts get no broadcast at all, even utility. Marketing also needs recorded consent. It runs again when each batch is prepared, so a STOP after the list was built still counts. A missing variable value is a skip too.
- Claims: `claimRecipients` uses `WITH picked AS MATERIALIZED (... LIMIT n FOR UPDATE SKIP LOCKED)`. Keep the CTE: with a plain `WHERE id IN (SELECT ... LIMIT n)` Postgres re-ran the subquery and claimed 120 rows with a limit of 50, which breaks throttling. A test pins this.
- Money: `holdCampaignFunds` holds what unsent recipients could cost, replacing any earlier hold in one transaction, before anything sends. Too little pauses with `insufficient_funds` and sends nothing. Each batch creates its messages and charges in one transaction, then sends through the same `sendOutboundMessage` as the inbox, so refunds and the send-time consent check are shared. Finish and cancel release what is left. Costs in reports are read from the ledger (`campaignCostMicros`), and counts by grouping recipients, so there are no stored counters to drift.
- Throttling: `acquireCampaignSlots` shares the inbox's per-second Redis counter, with a lower limit (`CAMPAIGN_MPS_PER_NUMBER`), so replies always find room. The daily limit is `dailyRemaining`, from the number's tier in `messaging_tier_limits`; an unknown tier gets 250. At the limit the campaign keeps `running`, sets `waiting_until`, and retries in 15 minutes.
- Auto-pause, checked before every batch: quality `RED` or `LOW` (`phone_number_quality_update`: `FLAGGED` -> RED, `UNFLAGGED` -> GREEN), failure rate above `CAMPAIGN_MAX_FAILURE_RATE` after at least 50 attempts, template no longer approved, number disconnected. Resume holds funds again and refuses, with the reason, if the wallet still cannot cover it.
- Retries and crashes: retryable errors put the recipient back to `pending` with a growing delay, 3 attempts at most, keeping the same message and charge. A recipient stuck in `sending` for 5 minutes is reclaimed, and the existing at-most-once rule fails it rather than sending blind, with a refund.
- Inbox: threads a broadcast creates are `closed`, so it does not flood the team. A reply reopens them as usual.
- Statuses and replies: `applyStatus` calls `applyRecipientStatus` (forward only), `applyInbound` calls `applyContactReply` (credits the latest broadcast within 72 hours and exits drips set to stop on a reply) and `exitDripsOnOptOut`. All in the same transaction as the message, so replays change nothing.
- Drips: ordered steps with a delay in minutes. Exit on reply, on a tag, on opt-out (always), or when marketing has no consent. An enrollment moves to the next step in the transaction that creates its message, so two runs cannot send a step twice. Too little money or a paused template waits an hour rather than losing the step. Steps cannot change once anyone is enrolled. A step with no mapping uses its template's.
- Dashboard: `GET /analytics/dashboard?days=`, computed on request from `messages` with `created_at` bounded so only partitions in range are read. Days follow the organization's time zone. Response time is the median from a customer's message to the next message from a person; broadcasts have no sender, so they do not count.
- Live updates: `campaign:updated` fires per batch, status and credited reply. The web refetches at most once a second per campaign, and refreshes the recipient list on its own timer.
- Permissions: `CAMPAIGNS_MANAGE` and `ANALYTICS_READ` (owners and admins).
- Web: `/campaigns`, `/campaigns/new` (saves a draft), `/campaigns/[id]` (review and launch as a draft, then the live report), `/campaigns/drips`, `/dashboard`. The volume chart is hand-written SVG in `components/dashboard/volume-chart.tsx`, with colors checked by the dataviz validator in both modes.
- Tests: `apps/worker/test/campaigns.test.ts` (includes the 10k acceptance test), `apps/api/test/campaigns.test.ts`, `packages/db/test/campaigns-tables.test.ts`, `packages/shared/src/campaigns.test.ts`, `e2e/campaigns.spec.ts`.

## Plans, subscriptions and payments (Phase 2.5)

- Tables: `plans`, `plan_prices`, `tax_rates` (config, no org_id, read-only to the app), `subscriptions` (one per org), `wallet_topups`, `invoices` (no UPDATE or DELETE grant), `billing_events` (written only through definer functions), `invoice_counter` (no app access). Billing details live on `organizations`.
- Plans are config: `pnpm plans:import <file.json>`, sample in `packages/db/prisma/sample-plans.json` (not real prices). The migration inserts Free, Starter, Growth and Scale with no prices. A plan can only be bought once it has a `plan_prices` row with the provider's price or plan id. Prices are what the provider charges, tax included.
- Trial: `startTrial` at signup and when creating an org, on the plan with `is_trial` (Growth, 14 days). The migration gave existing orgs one too. `effectiveStatus` works out expiry when read, so no job has to run: an ended trial or cancelled period means the Free plan. Nothing is deleted when a plan drops; only adding more stops. `past_due` keeps the plan while the provider retries.
- `packages/billing`: `PaymentProvider` interface, `StripeProvider`, `RazorpayProvider`, built on fetch with no SDK. `createPaymentProviders(env)` only creates a provider whose values are all set. Stripe's API version is pinned in `STRIPE_API_VERSION`. `providersForCurrency`: INR prefers Razorpay, everything else is Stripe. `test/providers.test.ts` pins requests, signatures and event parsing; payloads follow the docs and have not been checked against live traffic.
- Webhooks: `POST /webhooks/stripe` and `/webhooks/razorpay` verify the signature on the raw bytes (Stripe also checks a 5-minute tolerance), store through `billing_event_ingest` (unique on provider and event id), enqueue on `billing-events`, answer 200. Any failure answers 5xx so the provider redelivers. The worker handles them in `apps/worker/src/processors/billing.ts`.
- Wallet credits: only from a verified `topup.paid` event (Stripe `checkout.session.completed` or `async_payment_succeeded` with `payment_status: paid`; Razorpay `payment_link.paid` with a captured payment), never from a browser redirect. The idempotency key is `topup:<id>`, so the same event twice, or two different events about one payment, credit once. The credit, invoice and status change share a transaction. An amount or currency that differs from the top-up credits nothing and marks it `failed` for someone to look at.
- Subscription state: both providers say events can arrive out of order, so a subscription event carries no state. The worker asks the provider for the current subscription (`getSubscription`) and sets the row to it, outside any transaction. Running it again or in any order lands in the same place. The cancellation of an old subscription cannot cancel its replacement. A price no plan knows marks the event `failed` and leaves the plan alone. Razorpay does not report a pending cancel, so `cancelAtPeriodEnd` is set locally once it accepts the request.
- Finding the org: from metadata or notes we put on the checkout (trustworthy after the signature check, and RLS still confines the work), or `billing_org_for_ref`. A webhook can beat the API saving the provider's reference, so that case throws and retries.
- Top-ups add tax on top: 1000 at 18% costs 1180, and 1000 reaches the wallet. Tax comes from `tax_rates` by `organizations.billing_country`. Subscriptions split the tax out of the price. Each is copied onto the invoice.
- Invoices: `recordInvoice`, unique on provider and payment reference, gapless numbers (`INV-2026-000123`) from `next_invoice_number()`, buyer details copied on so they never change. `GET /billing/invoices/:id/pdf` renders from the stored row with pdfkit. Seller details come from `BILLING_SELLER_*`.
- Limits: `assertWithinLimit` / `roomLeft` (`@wacrm/db`), error `PLAN_LIMIT_REACHED` (402). Seats count active members plus pending invites. Enforced at invite, connecting a number (before any Meta call), adding a contact, CSV import (rows past the limit go in the error report) and CSV audiences (counted as invalid rows). A customer writing in is never refused. Counts are not locked, so concurrent adds can overshoot slightly.
- Features: `@RequireFeature('campaigns')` on actions, checked by `PlanFeatureGuard` after `AccessGuard`, error `PLAN_FEATURE_UNAVAILABLE` (402). Reading stays open, so past work stays visible after a downgrade. New features go in `PLAN_FEATURES`. A campaign already running finishes.
- Permissions: `BILLING_READ` (owners and admins), `BILLING_MANAGE` (owners) for paying and changing anything.
- Web: `/settings/billing` (current plan, usage, plan picker, billing details, invoices), Add funds on `/wallet`, `TrialBanner` in the shell. Updates arrive over `billing:updated`.
- Tests: `packages/billing/test/providers.test.ts`, `apps/worker/test/billing.test.ts` (the exactly-once acceptance tests), `apps/api/test/billing.test.ts`, `packages/db/test/billing-tables.test.ts`, `packages/shared/src/billing.test.ts`, `e2e/billing.spec.ts` with `e2e/support/fake-payments.mjs`, a fake Stripe that sends every signed webhook twice.

## Public API and outgoing webhooks (Phase 2.6)

How to use it, for customers: `infra/public-api.md`. Reference: `GET /v1/docs`, `GET /v1/openapi.json`.

- API keys: `api_keys`, format `wak_<16 hex prefix>_<secret>`. Stored as the same keyed hash as other tokens, shown once. Looked up through `api_key_lookup(prefix)` since no org is known yet, then the hash is compared in constant time. Revoking and expiry apply at once, because the key is read on every request. Every failure is the same 401.
- `AccessGuard` handles `@ApiKeyRoute(scope)` first. Those routes take only a key, and everything else takes only a session, so a key can never manage keys, reach the dashboard API or be used by a browser session. Scopes are `API_SCOPES` in `packages/shared/src/public-api.ts`. The plan needs the `public_api` feature.
- A key acts for whoever created it, for attribution (`request.auth.userId`, with `apiKeyId` set). Access is decided by its scopes, not that person's role. It stops if that user row goes away.
- Rate limit: `API_RATE_LIMIT_PER_MINUTE` per key, fixed window in Redis, reported in `X-RateLimit-*`, with `Retry-After` on 429. `last_used_at` is written at most once a minute.
- `/v1` controllers are in `apps/api/src/public-api`, thin over the same services as the dashboard, so window, consent, wallet, queue and plan rules are the same. Responses are their own shapes (`publicContactSchema`, `toPublicContact` and so on), so an internal DTO change cannot break an integration. Add fields there deliberately.
- `POST /v1/messages` finds or creates the contact and thread from a phone number. `actor.automated` means no `senderUserId` (not counted as a person replying) and the thread status is left alone (bulk API sends must not fill the inbox). `idempotencyKey` hashes to the inbox's client message id.
- OpenAPI: `@nestjs/swagger` over the `PublicApiModule` only, with schemas from the same Zod objects that validate requests (`Documented` in `public-api/openapi.ts`). Add `Documented` to every new /v1 route.
- Webhook events: `emitWebhookEvent(tx, ...)` writes one `webhook_deliveries` row per subscribed endpoint, in the transaction of the change itself, so an event cannot be lost or reported for something that rolled back. A workspace with no endpoints pays one indexed read. Events are `WEBHOOK_EVENTS`: new ones go there, with an emit at the change.
- Delivery: `webhook-dispatch` runs every 5 seconds, reads due rows through `webhook_due_deliveries`, and queues them on `webhook-deliveries` (concurrency 10, its own queue). `deliverWebhook` takes a 2-minute lease by moving `next_attempt_at`, which also stops two jobs sending one delivery, and covers a crash. Retries are on the row, not BullMQ: 8 retries from 30 seconds to 24 hours, about two days in all, then `failed`. Delivery is at least once, and the event id is the same across retries and replays.
- Signing: `X-Wacrm-Signature: t=<seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`. The secret is `SecretBox` ciphertext (`webhookSecretAad`), shown once, included in `pnpm secrets:reencrypt`. Rotating takes effect at once.
- SSRF: customers choose these URLs, so `webhookUrlProblem` refuses non-https, internal names and private IP literals when saving, and `createWebhookPoster` checks every resolved address in the socket's own `lookup`, so a name cannot pass a check and then resolve somewhere internal. Redirects are not followed, 10-second timeout, 1 KB of the answer kept. `WEBHOOK_ALLOW_PRIVATE_URLS` is for local tests and refused in production.
- Replay makes a new row with `replay_of_id` and the same event id, so the log keeps what happened. The log is not deleted by the app; `webhook_deliveries_purge` runs daily with `WEBHOOK_RETENTION_DAYS` and skips pending rows.
- Permissions: `API_KEYS_MANAGE` (owners and admins) for keys and endpoints. Both are audited.
- Web: `/settings/api-keys`, `/settings/webhooks` (the delivery log polls while open).
- Tests: `apps/api/test/public-api.test.ts`, `apps/worker/test/webhooks.test.ts` (includes the real HTTP client against a local server), `packages/db/test/developer-tables.test.ts`, `packages/shared/src/server/webhook-signing.test.ts`, `e2e/public-api.spec.ts` (the acceptance flow, with its own receiver).

## Rules and routing (Phase 3.1)

- Tables: `automation_settings` (one per org, missing means all off), `auto_reply_rules`, `assignment_rules`, `notifications` (per person, no DELETE grant). `memberships` gained `available` and `skills`; `conversations` gained `awaiting_reply_since`, `sla_due_at` and `sla_stage`. Pure logic (matching, business hours, picking an agent, schemas) is in `packages/shared/src/automation.ts`.
- Where it runs: after the inbound pipeline saves a message it queues an `automation` job (its own queue, concurrency 10, job id `auto-<messageId>`). `runInboxAutomation` (`apps/worker/src/processors/automation.ts`) claims the message in `message_refs` (kind `automation`) in the same transaction as everything it does, so a redelivered webhook, a retried job or a replay acts once. A redelivered webhook queues the job again, in case the first queueing failed. Webhook handling never waits on a rule.
- Order per inbound message: replies, then assignment, then the SLA clock. Replies are a welcome (first inbound message of a conversation), the first matching keyword rule by priority, then an away message outside business hours (only if no keyword answered, once per `awayCooldownMinutes`). At most `MAX_AUTOMATED_REPLIES_PER_HOUR` (3) per conversation, so two bots cannot loop. Nothing automatic goes to an opted-out contact. Replies are `text` messages with `content.automation` set and no sender, sent through the outbound queue, so the per-number limit and retries apply and they are free (the customer just opened the window).
- Matching: exact (whole message), contains (whole words, any script), regex (case-insensitive). Text is normalized and capped at 1000 characters. `regexProblem` refuses backreferences and nested repetition such as `(a+)+`, because patterns run in a shared worker; a stored pattern that fails the check never matches.
- Assignment (`chooseAgent`): only open, unassigned conversations. Active rules by priority: all set conditions must match (contact tag, number, keywords), then candidates are named agents or everyone with a skill, filtered to active and available members. A rule with nobody available falls through to the next, then to `defaultAssignment` (none, round_robin, load_based). Round-robin keeps its place on the rule row (or the settings row), locked with `FOR UPDATE`, so concurrent conversations alternate fairly. Load-based counts open assigned conversations.
- SLA: starts at the first unanswered customer message (later ones do not move it); a person's reply or closing the thread clears it; automated and API sends do not. `sla-check` runs every minute through `sla_due_conversations` (definer, ids only) and `checkSla`, which locks the row: stage 1 notifies the assignee (or owners and admins when unassigned) and schedules escalation if set; stage 2 notifies owners and admins and can reassign through `chooseAgent`, skipping the current assignee. Turning the SLA off clears every clock.
- Notifications: RLS lets anyone in the org insert one (the worker has no user), but only that person, in that org, can read or mark it. Realtime sends `notification:new` with just the user id to the org room, and only that person refetches. The bell is in the shell header; availability is a checkbox in the account menu.
- Permissions: `AUTOMATION_MANAGE` (owners and admins) for settings, rules and skills; anyone with `INBOX_REPLY` sets their own availability. Changes are audited as `automation.changed`.
- Web: `/settings/automation` (auto-replies, messages, business hours, SLA, default assignment, assignment rules, team skills), the bell, the availability checkbox, and an Overdue mark in the conversation list.
- Tests: `packages/shared/src/automation.test.ts`, `apps/worker/test/automation.test.ts`, `apps/api/test/automation.test.ts`, `packages/db/test/automation-tables.test.ts`, `e2e/automation.spec.ts`.

## Flow engine (Phase 3.2)

- Tables: `flows` (draft JSON, published trigger copied out, soft delete), `flow_versions` (published definitions, append-only), `flow_runs` (current node, variables, what it waits for, `wake_at`, step counters), `flow_run_steps` (history, append-only). The app role cannot delete flows or runs. A partial unique index allows one run under way (`running` or `waiting`) per conversation.
- Definitions: `packages/shared/src/flows.ts` is the one module for the graph (React Flow shape: nodes with id, type, position, data; edges from a named `sourceHandle`), its Zod schema, `flowIssues` (ids, edges, handles, reachability; errors block publishing, warnings do not), `nodeHandles`, variables (`interpolate`: `{{contact.name}}`, `{{contact.phone}}`, `{{contact.fields.x}}`, `{{vars.x}}`, `{{trigger.x}}`), conditions, answer checks and trigger matching. The builder in 3.3 uses the same module.
- Versions: the draft saves with problems; publishing checks it, plus what it points at (templates, tags, members, contact fields, files), and freezes it as a new version. A run keeps the version it started on. Only flows that are published and on start runs.
- Triggers: keyword, new contact (first inbound message ever), template quick-reply button (matched through the message it replies to), ad referral (`referral.source_id`), tag added, integration event (3.4 emits these), manual (API). Inbound messages now keep `context`, `referral` and the tapped `reply` id in `content`.
- Where it runs: inside the automation job's transaction (`handleInboundForFlows`), after its message claim, so a redelivery cannot answer twice. It locks the conversation row. A run waiting for a reply takes the message; otherwise message triggers are tried in `MESSAGE_TRIGGER_ORDER`. A keyword replaces a run that is only in a delay; nothing else interrupts a run. When a flow takes a message, 3.1's auto-replies, assignment and SLA clock leave it alone; a handoff node starts them. Events (tags, manual, connectors) go through the `flows` queue (`startFlowsForEvent`). The API queues tag events after commit; a Redis outage loses the trigger, not the tag.
- Engine (`apps/worker/src/processors/flows.ts`): one node per transaction, under `FOR UPDATE` on the run row, with the history row and the pointer move in the same commit. A crash resumes at the node that had not committed. HTTP, connector and AI steps call out between two transactions and apply only if the run has not moved (steps and node unchanged), so they are at least once. Messages are created in the step's transaction and queued after commit through the normal outbound queue (per-number limit, retries, wallet charge for templates, send-time consent check).
- Lost sends: `outbound-sweep` (every minute, `outbound_stuck_messages`, definer, ids only) re-queues outbound messages still `queued` a minute after creation, a day back at most. The job id is the message id, so a message whose job exists is untouched. Campaigns and drips are left out: they send inline and recover their own.
- Waits: buttons, lists, questions and wait-for-reply park the run with `awaiting` and `wake_at` (their timeout, or 7 days). Delays park it too. A delayed `wake` job runs on time; `flow-tick` every 15 seconds runs `flow_due_runs` (definer, ids only) for due runs and runs left `running` for over a minute, so a lost job or a restart costs at most a tick. The waiting node runs again with the reply or a timeout as input and picks its exit.
- Guards: `FLOW_MAX_STEPS_WITHOUT_WAIT` (50) catches loops with no wait, `FLOW_MAX_STEPS_PER_RUN` (500) caps a run, `FLOW_MAX_STARTS_PER_HOUR` (5 per contact per flow) stops two bots triggering each other, `reentry: once` limits a flow to one run per contact. An opted-out, deleted or merged contact cancels the run at its next step and starts none.
- Errors: HTTP and connector steps have `success`/`failure` exits. Any other failure (window closed, template not approved, no balance, missing tag) rolls the step back and follows the flow's `onError`: end the run as `failed`, or hand over to a person first. Free-form steps need the 24-hour window; templates do not.
- HTTP step: https only, the host cannot come from a variable, values are percent-encoded in the URL and JSON-escaped in a JSON body, same SSRF guard as webhooks (`createSafeHttp`, checks every resolved address), no redirects, 10 seconds, 64 KB kept. Response values are saved with dotted paths.
- Plan feature `flows` (Starter, Growth, Scale). Permission `FLOWS_MANAGE` (owners and admins). Changes are audited as `flow.changed`.
- API: `/flows` CRUD, `POST /flows/:id/publish`, `PATCH /flows/:id/active`, `GET /flows/:id/versions`, `GET /flows/:id/runs`, `POST /flows/:id/runs` (start for one contact), `GET /flows/runs/:runId` (with history), `POST /flows/runs/:runId/cancel`, `POST /flows/media` (files for media steps, `orgs/<org>/flows/<id>`).
- Web: `/flows` (list, new flow, import) and `/flows/[id]` (the 3.3 builder, publish, on/off, runs with variables and step history, stop a run, versions).
- Tests: `packages/shared/src/flows.test.ts`, `apps/worker/test/flows.test.ts` (the acceptance test: 10 nodes, delays, branching, restarts between and inside steps), `apps/api/test/flows.test.ts`, `packages/db/test/flows-tables.test.ts`.

## Flow builder (Phase 3.3)

- Canvas: `@xyflow/react` (React Flow 12) in `apps/web/src/components/flows/builder`. `flow-builder.tsx` keeps its own copy of the draft and saves it 800 ms after a change (only if it parses; the save status says why not). `step-node.tsx` draws a step with one labelled exit per handle and its problems; the trigger is a pseudo-node above the first step, and joining it to a step sets `startNodeId`. Positions are written back when a drag ends.
- Editing without dragging lines: the side panel (`node-form.tsx`) has a form per step type and a "Then" choice per exit, so a flow can be built with clicks and keyboard. A step added while another is selected goes under it and joins its first free exit. Below the `xl` breakpoint the step list becomes an "Add step" menu on the canvas.
- Shared helpers: `packages/shared/src/flow-builder.ts` (step names and groups, valid defaults, `newNode`, `addNode`, `updateNode` drops edges from exits a step no longer has, `removeNode`, `duplicateNode`, `connect`, `handleLabel`, `nodeSummary`, `variableOptions`). New template and tag steps hold `UNSET_ID`, and an empty media step `mediaKey: 'unset'`; `flowIssues` reports them as "Choose a template" and so on, on the step.
- Variables: `VariableField` inserts `{{...}}` at the cursor from `variableOptions`: contact details, custom fields, every `saveAs` and saved HTTP value in the flow, and the trigger text.
- Simulator: `packages/shared/src/flow-simulator.ts` runs a definition in memory (`startSimulation`, `simulateReply`, `simulateTimeout`, `simulateHttp`) with the same decision helpers and loop guards as the worker. Nothing is sent, stored or charged; the person testing answers HTTP steps with a sample JSON or a failure, and skips delays. The Test panel shows the conversation and highlights the path on the canvas. It runs the unsaved draft.
- Draft and published: the header shows the version, "unpublished changes" and the save status. Publish saves first. "Discard unpublished changes" is `POST /flows/:id/revert`. "Duplicate flow" is `POST /flows/:id/duplicate` (a new, unpublished copy). Export downloads `{ format: 'wacrm-flow', version: 1, name, definition }`; Import on the flows list takes that or a bare definition and creates a new flow. Ids from another workspace (templates, tags, people) show as problems until chosen again. "Edit as JSON" stays in the menu.
- Tests: `packages/shared/src/flow-simulator.test.ts` (the order-status flow end to end, builder helpers), `apps/api/test/flows.test.ts` (duplicate, revert), `e2e/flows.spec.ts` (the 3.3 acceptance: build an order-status flow with clicks, test it, publish it, then a real message runs it; also problems, export, import and duplicate).

## Connector framework (Phase 3.4)

How to add a connector: `infra/connectors.md`.

- `packages/connectors`: the `ConnectorDefinition` interface (auth `api_key` | `oauth2` | `webhook_secret` | `none`, settings, triggers, actions, `webhook.verify` / `deliveryId` / `map`, `healthCheck`, `sync`), `ConnectorRegistry` (checks definitions at start-up, `toDto` for the web), generic OAuth 2 (`authorizeUrl`, `exchangeCode`, `refreshTokens`, `{settings.x}` in provider URLs), signing helpers, and the Demo Store connector (`INTEGRATIONS_DEMO=true`). `buildRegistry()` is shared by API and worker; `BUILT_IN_CONNECTORS` is empty until 3.5. Adding a connector is adding a definition: no migration, route or page.
- Tables: `integration_connections` (credentials as one `SecretBox` JSON with AAD `integrationCredentialsAad`, plain settings, `webhook_token` in the webhook address, token expiry, health, sync cursor; disconnected, never deleted), `integration_events` (inbound and outbound log: unique on connection, direction and dedupe key; status, attempts, payload, result, error), `integration_event_claims` (append-only; one per outside event per connection). Definer functions: `integration_connection_by_token` (tokens of 32+ characters), `integration_due_work` (refresh, health, sync; ids and kind only), `secrets_list_integration_connections` (for `pnpm secrets:reencrypt`).
- Webhooks: `POST /integrations/hooks/:token` (public). Finds the connection through the definer function, verifies the signature on the raw bytes with the connection's secret, stores one row per delivery (dedupe on the provider's delivery id, else the body hash; signature and auth headers are not kept), queues `integrations` job `event` (job id = event id), answers 200. Bad signature 401, unknown or disconnected 404.
- Processing (`apps/worker/src/processors/integrations.ts`, queue `integrations`, concurrency 5): `processIntegrationEvent` locks the event, maps it with the connector, claims each mapped event's `externalId`, finds or makes the contact, and starts flows with `startFlowsForEventTx`, all in one transaction, then queues the runs. A second arrival of the same outside event (another delivery id, a sync, a retry) is logged as "Already handled". Failures retry with backoff and end `failed`; failed or ignored events can be replayed.
- Actions: flow step `integration_action` (`connector`, `action`, `input` with variables, `connectionId` or the first working connection, `saveResponse`) calls `runConnectorAction`, which refreshes an expiring token, runs the action through `ctx.http` (the shared SSRF guard, https only unless `WEBHOOK_ALLOW_PRIVATE_URLS`), and logs an outbound event. It never throws: a failure takes the step's Failed exit.
- OAuth: `POST /integrations/oauth/start` keeps a random state in Redis (10 minutes, `GETDEL` on use) with the org, user, settings and an optional connection to reconnect; `GET /integrations/oauth/callback` (public) exchanges the code and redirects to the web. Client ids come from the env variables a connector names. `API_PUBLIC_URL` is the address providers reach.
- Background: `integration-tick` (every minute) runs `integration_due_work`: refresh tokens expiring within 10 minutes, health checks older than an hour, syncs past their interval. A refused grant or `ConnectorError({ reconnect: true })` sets `needs_reconnect` and notifies owners and admins once (`integration_needs_reconnect`); actions on such a connection fail clearly. Syncs store each event as an inbound row (dedupe `sync:<hash of externalId>`) and process it like a webhook.
- Plan feature `integrations` (Growth, Scale). Permission `INTEGRATIONS_MANAGE` (owners and admins). Changes audited as `integration.changed`. Realtime `integration:updated`.
- Web: `/integrations` (connections, reconnect prompts, marketplace by category, connect dialog: API key form or OAuth redirect, webhook address and secret shown once), `/integrations/[id]` (details, test, reconnect, disconnect, event log with details and Try again), a reconnect banner in the shell, and in the flow builder an app, connection, action and inputs for integration steps, an app and event for integration triggers, and `{{trigger.data...}}` variables from the trigger's sample.
- Tests: `packages/connectors/test/framework.test.ts`, `apps/worker/test/integrations.test.ts` (the acceptance: a connector defined in the test only, through webhooks, claims, syncs, flow actions, OAuth refresh and health), `apps/api/test/integrations.test.ts`, `packages/db/test/integrations-tables.test.ts`, `e2e/integrations.spec.ts` (connect the Demo Store against a fake store, a signed order webhook, a flow looks the order up).

## Commerce connectors (Phase 3.5)

Setup for each store: `infra/connectors.md` (Built-in commerce connectors).

- `BUILT_IN_CONNECTORS` = Shopify (`connectors/shopify.ts`, OAuth app), WooCommerce (`woocommerce.ts`, REST key pair) and Custom store (`custom-store.ts`, signed JSON plus a generic `request` action). All emit the shared commerce events and data shapes in `packages/connectors/src/commerce.ts` (`order.created`, `order.paid`, `order.fulfilled`, `order.cancelled`, `shipment.updated`, `checkout.started`, `customer.created`), so one flow fits any store and template variables come from `{{trigger.data.order.*}}`.
- Framework additions: `map` can be async and gets the connector context; a mapped event can carry `contact.consent`, `correlation`, `cancels` and `effect` (`disconnect` / `erase` / `notify`); `webhook.secretEnv` (one app secret for every connection); `appWebhook` for app-wide webhooks at `POST /integrations/apps/:key/hooks`, routed by a setting through the definer `integration_connections_by_setting`; `setup` (worker job `setup` after every connect, registers webhooks, must be repeatable); `normalizeSettings`.
- Shopify: `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (API and worker); the secret verifies every webhook (`X-Shopify-Hmac-SHA256`). Admin API `SHOPIFY_API_VERSION` (2026-07). Fulfillment webhooks fetch their order. Privacy webhooks: uninstall disconnects, shop redact also blanks stored payloads, customer redact and data requests notify owners and admins (`integration_request`).
- Abandoned carts are flows: `checkout.started` (only with a phone, not completed) carries correlation `checkout:<token>`, stored on the run as `trigger.correlation`; the order with that checkout token `cancels` it, so a run still waiting ends `cancelled_by_event`.
- Consent at checkout: applied with `setContactConsent` only while the contact's state is `unknown`, never over an opt-out. Shopify counts only `sms_marketing_consent.state: subscribed`.
- Processing order in `processIntegrationEvent`: map outside the transaction, then under the event lock: cancels, effects (claimed), contact, claim (only once a contact exists, so a checkout without a phone can start later when the phone arrives), consent, flows.
- WooCommerce: statuses map to events once per order (`processing` paid, `completed` fulfilled, `cancelled`); a created order also emits `order.created`. Setup lists existing webhooks and adds only what is missing.
- Tests: `packages/connectors/test/commerce.test.ts` (mapping, signatures, setup), `apps/worker/test/commerce.test.ts` (the acceptance: a Shopify order sends the confirmation template, its fulfillment the shipping update; abandoned cart cancel; consent; privacy; WooCommerce), `apps/api/test/integrations.test.ts` (Shopify OAuth on the named shop, app-secret signatures, privacy route).

## Payments, Zapier and Make, Sheets, HubSpot (Phase 3.6)

How to set each up: `infra/connectors.md` (Payments, Sheets and HubSpot), `infra/integrations-zapier-make.md`.

- Payment links on the business's own account: `razorpay` (key pair; webhooks added by hand in the Razorpay dashboard with our address and secret) and `stripe` (secret or restricted key; one-time Checkout Sessions; `setup` registers the webhook endpoint and stores Stripe's signing secret). Shared shapes and helpers in `packages/connectors/src/payments.ts`: `Payment`, `PAYMENT_TRIGGERS` (`payment.paid`, `payment.failed`, `payment.expired`), `toMinorUnits` / `fromMinorUnits` (exact decimal strings, zero-decimal currencies), `paymentReference`, `paymentCorrelation`.
- Reminders until paid: `ConnectorAction.correlation(output)` ties the run that made a link to `payment:<connector>:<linkId>`, appended to `flow_runs.trigger.correlations`. `cancelCorrelatedRuns` matches `trigger.correlation` or `trigger.correlations`, so a paid or expired event cancels the run waiting to remind, in the same transaction that starts the paid flow.
- Repeat-safe actions: flow steps pass `ctx.idempotencyKey` = `flow:<runId>:<nodeId>:<steps>` (stable when a step repeats after a crash). Razorpay uses it as `reference_id` and fetches the existing link on a duplicate; Stripe as `Idempotency-Key`, with `expires_at` counted from a 10-minute slot so a repeat sends identical parameters.
- Framework: `setup` may return `{ credentials }` (merged into the encrypted credentials under a row lock); `webhook.secretBySetup` stops the API generating a secret.
- Google Sheets (`google_sheets`, `GOOGLE_CLIENT_ID` / `_SECRET`, offline access): add a row (RAW, so values never become formulas), find a row by heading. HubSpot (`hubspot`, `HUBSPOT_CLIENT_ID` / `_SECRET`): create or update a contact (email, then phone), add a note (association type 202). Both are actions only; sync is built with flows.
- Zapier and Make: REST hooks on the public API. Scope `hooks:manage`; `GET|POST /v1/hooks`, `DELETE /v1/hooks/:id`, `GET /v1/hooks/samples/:event` (recent real events, else `WEBHOOK_EVENT_SAMPLES`). A subscription is a `webhook_endpoints` row with `api_key_id`: same signing, retries and SSRF checks; `emitWebhookEvent` skips it while its key is revoked or expired; revoking the key deletes it. Keys see and delete only API-made subscriptions; the dashboard shows them as "Via API key". `MAX_API_HOOKS` (100) apart from `MAX_WEBHOOK_ENDPOINTS`. Sample Zapier CLI app: `infra/zapier/index.js` (not built).
- Tests: `packages/connectors/test/payments.test.ts` (amounts, Razorpay and Stripe requests, mapping, signatures, Stripe setup, Sheets, HubSpot), `apps/worker/test/payments.test.ts` (the acceptance: an order makes and sends a link; paying cancels the reminders and runs the thank-you flow; an unpaid link reminds; a failed link takes the failure exit; Stripe setup stores its secret), `apps/api/test/public-api.test.ts` (hooks: scope, delivery, samples, isolation, expiry, revoke).

## AI assistant and knowledge base (Phase 3.7)

- `packages/ai` (`@wacrm/ai`): `ChatProvider` and `EmbeddingProvider` interfaces; `AnthropicChatProvider` (official `@anthropic-ai/sdk`, default `claude-opus-5-5`, cached system prompt, structured outputs for JSON answers, server-side refusal fallback `fallbacks: 'default'`, low effort for these short tasks); `VoyageEmbeddingProvider` and `OpenAiCompatibleEmbeddingProvider` (fetch, 1024 dimensions); deterministic `FakeChatProvider` / `FakeEmbeddingProvider` for tests, e2e and local runs. `createAiProviders(env)` picks them from `AI_PROVIDER` and `AI_EMBEDDINGS_PROVIDER`; a provider missing its key is left out; fakes are refused in production. Features only see the interfaces.
- Prompts (`prompts.ts`): customer text and passages go in the user turn inside tags, described as material, never instructions (prompt-injection guard; a test pins it). The reply schema is `answer`, `confidence`, `sources` (passage labels mapped back to chunk ids), `handoff_reason`; `readReply` cleans it. An answer citing no passage is capped at 0.3 confidence.
- `assistant.ts`: `knowledgeReply`, `summarizeConversation`, `rewriteText`. They read and call, but do not write: callers record the log and charge in their own transaction.
- Tables: `ai_settings` (one per org; missing = off), `knowledge_documents` (text in object storage at `orgs/<org>/knowledge/<id>`, soft delete, status pending/indexing/ready/failed), `knowledge_chunks` (`vector(1024)` via `Unsupported`, written and searched with reviewed raw SQL, exact cosine search filtered by org and embedding model; no ANN index yet), `ai_logs` (append-only: every call, what it was given and said, tokens, cost, whether sent). All under tenant RLS. The migration runs `CREATE EXTENSION IF NOT EXISTS vector`.
- Indexing: queue `ai` (concurrency 2), job `index` (`processAiJob`): read, `chunkText` (paragraphs, about 1,600 characters, 200 overlap), check affordability, embed, then in one transaction replace passages, mark ready, charge and log. Reindex is the same job. Retryable provider errors retry; money, price and refusal errors mark the document failed with the reason.
- Metering: rate cards `ai_input`, `ai_output`, `ai_embedding` in micros per million tokens (`aiCostMicros`), loaded with `pnpm rates:import` like message rates. `assertAiAffordable` before a call (no hold), `chargeAi` after (ledger entries `ai:<logId>:<part>` with the rate copied on). No rate refuses the call (`RATE_NOT_CONFIGURED`); no balance refuses it (`INSUFFICIENT_BALANCE`). Failed calls are logged at no cost.
- Flow AI step (`ai_reply`): the call runs between transactions (`askAssistant`); the step (`aiStep`) charges, logs and acts in the step's transaction. It answers only when the plan has `ai`, AI is on, confidence is at least the higher of the step's and the workspace's threshold, the workspace allows automatic replies (`ai_settings.auto_reply`, off by default) and the window is open. Otherwise it takes the `handoff` exit, keeping any draft as an internal note ("AI suggestion, not sent") with the reason. Variables `ai_answer`, `ai_confidence`.
- Inbox: `POST /ai/conversations/:id/suggest` (answer, confidence, sources, note), `/summarize`, `POST /ai/rewrite` (`AI_TONES`). They fill the composer or show a dialog; nothing is sent automatically.
- API: `/ai/settings` (GET for anyone with `INBOX_READ`, PATCH with `AI_MANAGE`), `/ai/knowledge` (list, add text, `upload` for .txt/.md/.csv/.json up to 5 MB, `search`, `:id/reindex`, delete), `/ai/log` (cursor). Plan feature `ai` (Growth, Scale) on everything that calls a model; reading stays open. Audited as `ai.changed` (instructions are recorded as "changed", not their text). Realtime `knowledge:updated`.
- Web: Settings > AI assistant (`/settings/ai`: switches, threshold, instructions, knowledge base with upload, test search and status, activity log) and the AI menu (sparkles) in the composer.
- Tests: `packages/ai/test` (chunking, prompts, reply parsing, fake providers, embedding adapters, provider selection), `apps/worker/test/ai.test.ts` (the acceptance: an AI step answers from the knowledge base and hands off when unsure; indexing with real pgvector; notes when automatic replies are off; refusals, AI off, empty wallet; prompt-injection framing), `apps/api/test/ai.test.ts`, `packages/db/test/ai-tables.test.ts`, `e2e/ai.spec.ts`.

## Resellers and the platform console (Phase 4.1)

How it works for an operator: `infra/reseller.md`.

- Hierarchy: platform admin > partner > client organization > its members. `partners` and `organizations.partner_id` are reused. New tables: `platform_admins` (the app role only reads; rows come from `pnpm admin:grant`), `partner_members` (one partner per person), `partner_clients` (per-client caps and the partner's own price), `wholesale_plan_prices`, `partner_ledger` (append-only), `partner_statements`, `impersonation_sessions`, `platform_audit_logs` (append-only). `wallet_ledger` gained `partner_id` and `wholesale_micros`; `audit_logs` gained `impersonation_id`.
- Contexts: `withDbContext` also takes `partnerId` and `platformAdmin`. `app_is_platform_admin()` is true only when `app.platform_admin = 'on'` AND the current user has a `platform_admins` row, so the flag alone opens nothing and an admin in their own workspace is an ordinary member. A partner context sees its own row, its clients' `organizations`, `partner_clients`, and their `wallets` and `subscriptions` read-only. Tenant tables stay closed to both: they are reached only by naming one workspace.
- Routes: `@PartnerRoute()` (`/partner/*`) and `@PlatformAdminRoute()` (`/admin/*`) in `AccessGuard` load the partner membership or admin row fresh on every request and drop the org from the request. `TenantPrismaService.runAsOperator` runs in that context; `runInWorkspace(orgId, fn)` first finds the workspace under RLS (a partner only finds its own clients, so anything else is 404) and then runs with that org set. All partner and admin work on a workspace goes through `WorkspacesService` (`apps/api/src/reseller`), which writes the workspace's own audit log in the same transaction.
- Billing model: the partner is invoiced at wholesale and collects from clients itself. A client's subscription has `provider = 'partner'`, status active, no period (`setPartnerManagedPlan`). The client cannot check out or top up (`MANAGED_BY_PARTNER`, 409); its billing page says who manages it. The partner adds wallet funds for it (`POST /partner/clients/:id/wallet/credit`, caller's idempotency key), which is a `credit` entry in the client's ledger.
- Markup: `partners.wallet_markup_bps` (0 to 20000). `findRate` reads the partner of the transaction's own org (`clientPartnerPricing`, from `app_current_org_id()`) and returns `rateMicros` with the markup (`applyMarkup`, rounded up) plus `wholesaleMicros`, so estimates, campaign holds, charges and the client's price list all show the client's price. Message and AI charges pass `wholesale` to `debitWallet`, which writes the client's ledger entry and the partner's `partner_ledger` row (`usage`: wholesale, retail, commission = retail - wholesale) in one transaction; `refundDebit` reverses both. The client can insert that row (RLS checks it is for its own org and partner) but never read it. A new markup applies to new charges only.
- Limits: `effectiveLimits` is the plan's limits lowered by `partner_clients` caps (a partner can only restrict). `roomLeft`, `assertWithinLimit` and the billing summary use it. `partners.max_clients` caps client workspaces (`PARTNER_LIMIT_REACHED`, 402), counted under a row lock on the partner.
- Statements: `closePartnerMonth(db, partnerId, period)` writes a `plan_fee` row per client on a partner-managed plan (wholesale price, and the partner's client price or wholesale if unset; a whole month, no proration), then copies the ledger totals onto a `partner_statements` row. Unique per partner and period, never rewritten, refuses the current month. The worker's daily `partner-statements` job closes last month for every partner through `partner_statement_targets()` (definer, ids only). A platform admin records the payment (`POST /admin/statements/:id/paid`); the money moves outside the system.
- Impersonation: `POST /partner/clients/:id/impersonate` or `/admin/orgs/:id/impersonate` with a reason creates an `impersonation_sessions` row and returns an access token with claim `imp`, valid 30 minutes, never refreshed. `AuthenticatorService` checks on every request that the row is open and that the person still works for the workspace's partner (or is still a platform admin), then acts as `admin` in that org. `IMPERSONATION_DENIED` permissions (API keys, changing or removing members, billing, delete) are refused, as are the consoles. `AuditService.record` stamps `impersonation_id` on everything from the request context; start (with the reason) and end are their own entries. `POST /impersonation/end` closes it.
- Suspend and delete: `organizations.status = suspended` blocks every non-`@SkipTenant` route (`ORG_SUSPENDED`, 403), API keys and sockets, and `/auth/me` reports `suspended` so the web shows a notice. Delete is soft (`deleted_at`): numbers are disconnected with `disconnectWabaTx`, keys and pending invitations revoked, history kept, and the partner's slot freed. A suspended partner loses its console; its clients keep working.
- Platform admin: partners and their staff (added from existing accounts), every workspace (suspend, set plan, credit as an `adjustment`, impersonate), plan limits and features (the per-plan feature flags; column-level UPDATE grant, so prices with provider ids stay CLI-only), wholesale prices, rate cards (insert only), statements, the platform audit log, and `GET /admin/system` (database, Redis, counts of every BullMQ queue). `plans`, `rate_cards` and `wholesale_plan_prices` have RLS enabled but not forced, so the owner's import scripts still work.
- Web: `(console)` route group outside the workspace shell: `/partner` (month so far, markup, clients with create, edit, add funds, view, suspend, delete; ledger; statements) and `/admin` (partners, workspaces, plans, rate cards, statements, system). The impersonation token is held beside the person's own in the auth store (`activeToken()`), `ImpersonationBanner` shows in the shell with an Exit button, and a 401 while impersonating closes the view rather than refreshing. Settings > Audit log marks entries made by a non-member.
- Tests: `apps/api/test/reseller.test.ts` (the acceptance: two clients, wallets, limits, commissions, impersonation trail, isolation between partners and from clients, suspend and delete, the admin console), `packages/db/test/reseller-tables.test.ts` (RLS on every new table, the admin flag, markup rounding, closing a month), `packages/shared/src/reseller.test.ts`, `e2e/reseller.spec.ts`.

## Troubleshooting

- Local services run without Docker on the development PC (`infra/native-setup.md`): PostgreSQL 18 as a Windows service on 5433, Memurai (Redis) on 6379, and SeaweedFS and Mailpit from `.tools/` via `pnpm services:up`. If a test or the app cannot reach one, run `pnpm services:status`; logs are in `.tools/logs`.

- Dev page reloads forever, with the terminal repeating `Compiled in Xms` and the browser getting `HMR hash mismatch`: the Turbopack dev cache is stale, which `next build` beside a dev server can cause. Stop the dev server and delete `apps/web/.next/dev`.
- Prisma `P1001`, or the app hanging on Postgres or Redis while `docker ps` shows them healthy: Docker Desktop's port forwarding has stuck. Restart Docker Desktop, then `pnpm docker:up`.
- API flapping on port 4000 after an interrupted `pnpm dev`: old watchers may still be running. Check `Get-NetTCPConnection -LocalPort 4000` and stop that process.

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
- `WALLET_DEFAULT_CURRENCY` (INR), `WALLET_LOW_BALANCE_DEFAULT` (100)
- `API_RATE_LIMIT_PER_MINUTE` (600, per key). `WEBHOOK_ALLOW_PRIVATE_URLS` (local tests only, refused in production; API and worker)
- `CAMPAIGN_MPS_PER_NUMBER` (40, below `OUTBOUND_MPS_PER_NUMBER` on purpose), `CAMPAIGN_MAX_FAILURE_RATE` (0.2). Worker only
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: API and worker both need them, and a provider exists only with all its values. `STRIPE_API_BASE`, `RAZORPAY_API_BASE` for local fakes only (refused in production)
- `BILLING_SELLER_NAME` (defaults to `APP_NAME`), `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_TAX_ID`: printed on invoices
- `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` (API and worker): the Shopify app; the secret also verifies Shopify webhooks
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` (API and worker): the Google Sheets and HubSpot OAuth apps. A connector is offered as available only with both set
- `AI_PROVIDER` (`anthropic` | `fake`, unset = AI off), `ANTHROPIC_API_KEY`, `AI_MODEL` (default `claude-opus-5-5`), `AI_EMBEDDINGS_PROVIDER` (`voyage` | `openai` | `fake`), `AI_EMBEDDINGS_MODEL`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (API and worker). Changing the embedding provider or model means reindexing documents
- `API_PUBLIC_URL` (default http://localhost:4000): this API as providers reach it, for integration webhooks and OAuth callbacks. `INTEGRATIONS_DEMO` (API and worker) adds the Demo Store connector. OAuth connectors read their own client id and secret variables (see `infra/connectors.md`)
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
- [ ] Section 2: Contacts, templates, campaigns, billing, public API (2.1 contacts and consent DONE; 2.2 template manager code DONE, real Meta approval not verified; 2.3 wallet DONE, real rate cards not loaded; 2.4 campaigns and dashboard DONE; 2.5 billing code DONE, real sandbox payments not verified; 2.6 public API and webhooks DONE. Gate NOT passed until real sandbox payments are run: wallet concurrency, webhook idempotency, campaign load and OpenAPI all pass). Started with the Section 1 gate still open, by the project owner's decision (2026-11-05).
- [ ] Section 3: Automation, integrations, AI (3.1 rules and routing DONE; 3.2 flow engine DONE; 3.3 flow builder DONE; 3.4 connector framework DONE; 3.5 commerce connectors code DONE, not checked against a real Shopify dev store; 3.6 payments, Zapier/Make, Sheets, HubSpot code DONE, payment links not run in a real sandbox; 3.7 AI assistant and knowledge base DONE with fake providers, not yet run against Claude and a real embedding provider). Started with the Section 2 gate still open (no sandbox payments run), by the project owner's decision (2026-11-09).
- [ ] Section 4: Reseller, extended modules, analytics, security, launch (4.1 reseller module and platform console DONE; 4.2 to 4.5 to do). Started with the Section 3 gate still open (payment links and real AI providers not run), by the project owner's decision (2026-11-13).

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
- 2026-11-05: Contact tags are separate from conversation labels: tags describe a person, labels describe a thread.
- 2026-11-05: Contacts and consent are never hard-deleted by the app, so a re-import cannot erase an opt-out. Honoring erasure requests is a separate feature (see Known gaps).
- 2026-11-05: Opt-out keywords match whole messages only, to avoid opting people out on "stop by tomorrow". STOP does not trigger an automatic reply yet.
- 2026-11-05: Bulk actions work on selected rows (up to 1000 at once), not "everything matching a filter". Filter-wide changes can come with campaigns if needed.
- 2026-11-06: Sends use the local template copy, not a Meta call each time. Reason: faster, works for campaigns, and webhooks plus an hourly comparison keep it current.
- 2026-11-06: No local drafts of a submitted template: an edit goes to Meta straight away, or is not saved. Reason: the stored text must always match what was approved, since it is what gets rendered and sent.
- 2026-11-06: The builder offers Marketing and Utility only. Authentication templates need OTP buttons and are shown as unsupported.
- 2026-11-06: Link buttons always use {{1}}, even in templates with named variables. Meta's documentation of named link variables at creation is unclear, so check this on a real named template.
- 2026-11-06: The header file stored on a template is what customers receive, with no per-send override yet.
- 2026-11-06: Charged when a template is queued, not when Meta reports a billable status. Reason: the zero-balance block has to happen before sending. Meta's `pricing.billable: false` then refunds. The reverse case, Meta billing something estimated as free, is not charged.
- 2026-11-06: Free replies still work at zero balance. "Block sends at zero balance" is applied to sends that cost money: Meta does not charge for replies inside the window, and blocking them would stop a business answering its customers.
- 2026-11-06: A send interrupted by a crash is refunded, although Meta may have delivered it. Reason: when unknown, the customer should not pay. Costs the platform at most that message.
- 2026-11-06: A chargeable send with no rate is refused, not sent for free. Reason: silently free sends lose real money.
- 2026-11-06: One wallet currency per org, set at creation from `WALLET_DEFAULT_CURRENCY` (INR). Rate cards must exist in it.
- 2026-11-06: A hot wallet serializes on its row lock. Checked under campaign load in 2.4: a batch charges in one short transaction, and inbox round trips during the 10k test measured median 88 ms, p95 234 ms, worst 1.5 s, with both in one test process. Sends within a batch are capped at 5 at once, to leave the pool for inbound work.
- 2026-11-06: Broadcasts are stricter than one-to-one sends: an opted-out contact gets no broadcast at all, even utility. Reason: someone who said STOP should not hear from a mass send.
- 2026-11-06: Threads created by a broadcast start closed. Reason: 10,000 new open threads would bury the team's real conversations. A reply opens them.
- 2026-11-06: A chain of short jobs rather than one long campaign job. Reason: pause and cancel take effect by the next batch, deploys are cheap, and BullMQ locks stay simple.
- 2026-11-06: No stored counters on campaigns. Counts are grouped from recipients, cost comes from the ledger. Reason: nothing can drift, at the cost of a query per report.
- 2026-11-06: A reply is credited to the contact's latest broadcast within 72 hours. Reason: simple and explainable. This is attribution, not proof the broadcast caused it.
- 2026-11-06: Unknown messaging tier means 250 a day, the limit Meta starts numbers on. Reason: failing safe protects the number, and the first real connection showed an empty tier.
- 2026-11-06: Automatic pauses appear in the app only, with no email yet.
- 2026-11-06: Provider adapters use fetch, not the Stripe and Razorpay SDKs. Reason: a small surface, one error path, and the same injectable fetch for tests. Stripe's version is pinned per request.
- 2026-11-06: Subscription webhooks are only triggers: the worker reads current state from the provider. Reason: both providers say order is not guaranteed, and Stripe says not to order by `created`. Costs one API call per event.
- 2026-11-06: Top-ups add tax on top, and plan prices include it. Reason: a customer topping up 1000 expects 1000 of credit, and provider plans have a fixed price. Worth a check with an accountant, including whether GST applies to prepaid wallet credit at top-up or at use.
- 2026-11-06: The wallet currency decides the billing currency, so one org has one currency. INR prefers Razorpay.
- 2026-11-06: Missing subscription row means no limits. Reason: signup and the migration create one, and a bookkeeping gap must not stop a business. The billing page creates one if it finds none.
- 2026-11-06: A plan drop keeps everything and only stops adding more. Reason: deleting or disabling a customer's data because a card failed is the wrong failure.
- 2026-11-06: Free replies and the inbox keep working on every plan, including Free.
- 2026-11-07: `invoice_counter` is modelled in Prisma. It was hand-made in 2.5, and the next migration would have dropped it, resetting invoice numbers. Any hand-made table in `public` must be in the schema.
- 2026-11-07: Webhook events are a transactional outbox polled every 5 seconds, not queued directly. Reason: an event is committed with its change, so a Redis outage or crash cannot lose one, and no code path has to enqueue after commit. Costs up to 5 seconds of latency.
- 2026-11-07: Webhook retries are on the delivery row, not BullMQ. Reason: they show in the log, survive a Redis loss, and do not hold delayed jobs for days.
- 2026-11-07: Webhook and API responses use their own public shapes, not internal DTOs. Reason: a versioned API is a promise.
- 2026-11-07: Keys and endpoints are managed only from the dashboard. Reason: a leaked key must not be able to mint more keys or redirect events.
- 2026-11-07: A key acts for its creator for attribution, but access comes only from scopes. Reason: services and audit expect a user, and tying access to a person's role would change a key's power when their role changes.
- 2026-11-07: Internal notes never leave through the API or webhooks.
- 2026-11-09: Section 3 started with the Section 2 gate open: sandbox payments not yet run. The project owner's decision. Run them together with 3.6's payment link check.
- 2026-11-09: Rules run in their own queue after the message is saved, and claim the message in the same transaction as their effects. Reason: the webhook and inbound pipeline never wait on a rule, and no delivery or retry can reply twice.
- 2026-11-09: One keyword rule answers per message: the first by priority. Reason: several replies to one question reads as spam, and order makes it predictable.
- 2026-11-09: A cap of three automated replies per conversation per hour, whatever the rules say. Reason: two auto-responders talking to each other would otherwise loop.
- 2026-11-09: The SLA counts calendar minutes, not business hours. Reason: simpler and predictable; business-hours SLAs can come later.
- 2026-11-09: Notifications are in-app only. Reason: the worker has no mailer, and email for these needs the queued email work that was deferred in 1.5.
- 2026-11-10: Flows run inside the automation job, after its message claim, rather than in their own inbound path. Reason: one claim makes every inbound effect happen once, and the conversation lock orders flows against the rules.
- 2026-11-10: One node per transaction, under a row lock on the run, with timers kept in the database (`wake_at`) and a 15-second tick behind the delayed jobs. Reason: a restart, a lost Redis job or two workers at once all resume at the node that had not committed, which is the 3.2 acceptance.
- 2026-11-10: A run waiting for a reply takes the customer's next message, even when it matches a keyword; a keyword only replaces a run that is in a delay. Reason: an answer such as "order" must not restart the flow asking for it.
- 2026-11-10: HTTP, connector and AI steps are at least once: a crash between the call and its commit repeats the call. Reason: no connection is held while a slow endpoint answers, and endpoints can dedupe on the run id.
- 2026-11-10: Drafts may be invalid; publishing checks shape and references. Reason: a builder saves half-made flows, and only what runs must be right.
- 2026-11-10: Flows are a plan feature on Starter, Growth and Scale, not Free.
- 2026-11-10: The simulator runs in the browser on shared code, not on the server. Reason: a test must never send, charge or call anything, and testing an unsaved draft needs no round trip. The engine and simulator share every decision helper, and a shared test runs the acceptance flow through the simulator.
- 2026-11-10: Steps can be joined from the side panel as well as by dragging. Reason: dragging small handles is hard for many people and impossible by keyboard; it also makes the builder testable.
- 2026-11-10: Exported flows keep their template, tag and member ids. Reason: within one workspace they still work, and across workspaces the problems list names what to choose again.
- 2026-11-11: A connector is a single definition object shared by API and worker; the framework owns credentials, OAuth, tokens, the event log, retries and flows. Reason: the 3.4 acceptance, and connectors stay small and testable without a database.
- 2026-11-11: Outside events are claimed by the connector's own `externalId`, separately from webhook delivery dedupe. Reason: the same order can arrive by webhook, redelivery under a new id, and sync; it must start flows once.
- 2026-11-11: Health checks and action calls run only in the worker, through the SSRF-guarded client; the API only makes the OAuth token exchange. Reason: one network path to guard, and requests stay fast.
- 2026-11-11: OAuth state lives in Redis for 10 minutes and is deleted on first use, rather than a signed token. Reason: one use is enforced, and a leaked callback URL cannot be replayed.
- 2026-11-11: Webhook addresses carry an unguessable token stored in plain text, and the signature is what authenticates. Reason: the address must be shown again on the connection page; the token only routes.
- 2026-11-11: Integrations are a plan feature on Growth and Scale.
- 2026-11-11: Every database connection sets `TimeZone=UTC` (`createPrismaClient`). Reason: a Date bound into raw SQL reaches Postgres without a zone and is read in the session zone; the native Windows Postgres runs in Asia/Calcutta, which moved every cutoff (stale campaign sends, due SLAs, due flow runs, stuck messages) by 5.5 hours. Docker's UTC had hidden it. `packages/db/test/client.test.ts` pins it.
- 2026-11-11: Local development runs without Docker. Reason: Docker Desktop's VM took several GB on the 8 GB development PC and kept crashing mid-test. Native PostgreSQL 18 (port 5433), Memurai for Redis (6379), and SeaweedFS and Mailpit binaries in `.tools/` use about 200 MB on the same ports, so `.env` and the code are unchanged. Docker Compose stays as an option. Odoo's bundled Postgres 12 on 5432 is too old (no core `gen_random_uuid`) and is left alone.
- 2026-11-10: `outbound-sweep` re-queues outbound messages still `queued` a minute after they were made, campaigns and drips aside. Reason: any path that commits a message and then queues it (flows, rules, the inbox) could lose the job in a crash in between.

- 2026-11-11: Store connectors emit one shared set of commerce events and data shapes. Reason: a flow and its template mapping keep working if a business moves from WooCommerce to Shopify, and the builder shows one sample.
- 2026-11-11: Abandoned-cart recovery is a normal flow (delay, then template) that the order cancels by correlation, not a separate job type. Reason: the flow engine already has durable delays, restarts and history; the business edits the wait and message itself.
- 2026-11-11: Checkout consent only moves a contact from unknown to opted in. Reason: an opt-out on WhatsApp outranks a checkbox in a store, and the import rule is the same.
- 2026-11-11: Shopify privacy requests notify owners and admins instead of deleting. Reason: the workspace is the controller of its WhatsApp history, and personal data erasure is not built yet; uninstall and shop redact do act at once.

- 2026-11-11: Payment links use the business's own Razorpay or Stripe account through connectors, separate from platform billing in `packages/billing`. Reason: the money goes to the business, and its keys stay in its connection; billing is ours.
- 2026-11-11: Stripe payment links are one-time Checkout Sessions, not Stripe Payment Links. Reason: Payment Links are reusable and cannot be tied to one customer or one flow run; a session can, and expires on its own.
- 2026-11-11: Reminders until paid are flow steps cancelled by the paid event (an action adds a correlation to the run), not a scheduler of their own. Reason: the 3.5 abandoned-cart mechanism already does this durably, and the business words and times its reminders.
- 2026-11-11: API keys may add webhook endpoints, but only with the separate `hooks:manage` scope, visible in the dashboard and ending with the key. This narrows the 2026-11-07 decision. Reason: Zapier and Make subscribe by REST hooks with the customer's key; a leaked key without that scope still cannot redirect events.
- 2026-11-11: Google Sheets and HubSpot are actions, used from flows; no background sync. Reason: what to sync and when is the business's choice, and flows already give triggers, retries and a log.

- 2026-11-12: pgvector built from the official source (v0.8.7) with Visual Studio 2022 for the native Windows PostgreSQL 18; the project owner's choice over a hosted database or plain arrays. CI and Docker use the pgvector image.
- 2026-11-12: Claude through the official Anthropic SDK in `packages/ai`, behind a provider interface; embeddings from a separate provider (Voyage or OpenAI-compatible) because Anthropic has no embeddings API. Model `claude-opus-5-5` by default, configurable with `AI_MODEL`.
- 2026-11-12: Nothing reaches a customer from AI unless the workspace turns on automatic replies, and then only above the confidence threshold with the window open. Otherwise the draft is a note and the conversation goes to a person. Reason: the brief's "never auto-send without the org enabling it", and a wrong answer to a customer costs more than a handoff.
- 2026-11-12: AI usage is charged from the wallet per token through rate cards (`ai_input`, `ai_output`, `ai_embedding`), checked before the call and charged after. Reason: one balance for everything a workspace spends, prices in config, and the provider's real token counts.
- 2026-11-12: Exact cosine search per workspace, no ANN index. Reason: RLS confines search to one workspace whose passages are few; an HNSW index over every workspace with an org filter would need iterative scans to stay correct. Revisit with real sizes.
- 2026-11-12: Knowledge text is stored in object storage and passages in Postgres; documents are soft-deleted and their passages removed. Reason: reindexing after a provider or chunking change needs the original text.

- 2026-11-13: Section 4 started with the Section 3 gate open. The project owner's decision.
- 2026-11-13: A partner is invoiced at wholesale after the month and collects from clients itself; clients of a partner cannot pay the platform. "Payout tracking" is therefore recording that a partner paid its statement, not paying a partner. Reason: the brief's billing model. Split payments, where the platform collects and pays the margin out, come later.
- 2026-11-13: The markup is applied inside `findRate`, from the org of the transaction's own RLS context. Reason: every caller (send, estimate, campaign hold, AI, price list) gets the client's price without being changed, and a caller cannot price one workspace with another's partner.
- 2026-11-13: Wholesale and partner are copied onto each wallet ledger entry, and the partner's ledger row is written in the same transaction. Reason: a refund reverses exactly what was charged even if the markup or partner changed since, and commissions cannot drift from charges.
- 2026-11-13: A partner's caps only lower a plan's limits. Reason: the plan is what the platform charges the partner for.
- 2026-11-13: Plan fees are a whole month per client that is on a partner-managed plan when the month is closed, with no proration. Reason: simple and predictable for a first version; revisit with real partners.
- 2026-11-13: Platform admin is a context flag that Postgres honours only with a platform_admins row, and admins are made only by a CLI on the owner connection. Reason: neither a bug that sets the flag nor a stolen admin session of the app role can create an admin.
- 2026-11-13: Impersonation is a separate short access token naming a database row, not a membership and not refreshable; impersonators act as admin without keys, team changes or billing. Reason: it ends at once, cannot be extended silently, leaves nothing behind, and the client sees a reasoned trail.
- 2026-11-13: Partner staff are not members of client workspaces, and are added by a platform admin from existing accounts. Reason: clients see exactly who belongs to their workspace, and no new invitation flow is needed.
- 2026-11-13: There are now two HTTP paths that add wallet funds without a payment: a partner crediting its client, and a platform admin adjustment. Both are audited in the workspace and keyed for idempotency. This replaces the 2.3 rule of no such endpoint.
- 2026-11-13: Partner and admin consoles live outside the workspace shell. Reason: they act across workspaces and need none selected.

## Known gaps / TODO

- Resellers: a partner has no credit limit, so it can credit client wallets without bound until a statement goes unpaid; add a limit or prepaid partner balance before real partners. Statements have no PDF, email or tax lines yet. A suspended workspace cannot log in or use keys, but campaigns, drips, flows and auto-replies already running in the worker continue. Deleting a client does not unsubscribe its WABA at Meta (credentials are wiped locally). An impersonation does not survive a page reload (the token is only in memory), and actions made while impersonating are attributed to the outsider's user id (for example a sent message). No per-workspace feature overrides: feature flags are per plan. A client cannot leave its partner, and a workspace cannot be moved to a partner, from the app. The platform audit log has no screen yet (API only: `GET /admin/audit`). Partner staff have one role. Bull Board is still not mounted; `/admin` shows queue counts only.

- Phase 3.7 not run against real providers: set `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`, and `AI_EMBEDDINGS_PROVIDER` with its key, then index a document and try a suggestion and a flow. Real AI rates are not set; `sample-rate-cards.csv` has sample INR rates only.
- AI: PDF and Word documents are not read (text formats only). Exact vector search per workspace; add an HNSW index with filtered iterative scans when a workspace's passages grow large. No hold on funds during a call, so a concurrent spend can leave a call unpaid (logged). Knowledge search from settings is not charged. Flow AI steps call the provider at least once per attempt, so a crash can repeat a (charged-once) call. The simulator hands off at AI steps. No per-plan AI quota beyond the wallet. The AI log is kept forever; add retention.

- Phase 3.6 not verified against live services: a Razorpay and a Stripe test-mode payment link paid end to end (needs test keys in the connection and a tunnel for webhooks), Google and HubSpot OAuth apps, and the Zapier app pushed. Razorpay `payment.failed` is only matched when the link's notes reach its payments; check this in the sandbox. This is the Section 3 gate's payment item, together with the Section 2 sandbox payments.
- Payments: no partial payments, refunds or currency conversion. Reminders are flow steps the business builds; there is no ready-made template. HubSpot has no inbound sync (HubSpot changes do not reach the CRM). Sheets lookups read at most 5,000 rows.

- Phase 3.5 not verified against a real Shopify dev store or WooCommerce site: needs a Partner app, its keys in `.env`, and a tunnel for `API_PUBLIC_URL`. Payloads follow the docs. Confirm Admin API version `2026-07` is offered. Shopify's protected customer data approval is needed before a public listing.
- Shopify customer redact and data requests only notify; nothing erases or exports automatically yet (ties to the personal data erasure gap). No order-level events for refunds or edits. WooCommerce has no abandoned carts (no core webhook for them).

- Section 1 gate still open: Embedded Signup through the Meta popup (needs `META_EMBEDDED_SIGNUP_CONFIG_ID`) and replay of a real event from Settings > WhatsApp.
- Live payloads carry `contacts[].user_id`, `messages[].from_user_id` and `statuses[].recipient_user_id` (format `IN.…`), and `pricing` on statuses. The app ignores all of them and keys contacts on `wa_id`. Decide how to store the user id, and use `pricing` when billing arrives.
- The first connected number has an empty `messaging_tier` and quality `UNKNOWN`. Check that they fill in, since campaign limits in Section 2 depend on them.
- Phase 2.2 not verified against real Meta: a template approved by Meta and sent to a real phone (steps in `infra/whatsapp-setup.md`). The media sample upload is the riskiest part: Meta's guide mentions a user access token, and this uses the WABA's token.
- Templates: no per-send header file, no location headers, no copying a template to another language or account. Old sample files stay in storage until the lifecycle rule below exists.
- Sends on one conversation can reorder under concurrency or retries. No manual retry button on failed messages yet.
- Inbound `system` and `request_welcome` messages are skipped.
- The FB JS SDK popup has never run against Meta; only its message parsing is tested. Inbound media, failed sends, template status and quality events have no live capture yet.
- Data deletion only matches connections with a stored `meta_user_id`; manual connects have none, and FB.login may not report one with `response_type: code`. Check on the first real signup.
- No mobile navigation: the main sidebar is hidden below `md` with no replacement.
- Personal data erasure is not built: deleting a contact hides it but keeps its data. Needs a real erase flow before launch, and a legal check on what consent proof must stay.
- Import source files and job results stay in object storage: `ObjectStorage` has no delete. Needs a bucket lifecycle rule or cleanup job before launch.
- Imports and exports hold the whole file in memory (50 MB cap on imports). Exports of very large lists should move to multipart upload.
- No automatic duplicate detection: people choose contacts to merge. Numbers are normalized, so the same number cannot exist twice unless a webhook stored it differently.
- No START keyword: a customer who opted out can only be opted back in by a person recording proof.
- E2E import and export tests, and the AI knowledge base spec, skip in CI, which has no S3 service.
- Settings > WhatsApp shows the raw event type; friendlier labels can wait for the inbox.

- Campaigns: variables come from the template's mapping or CSV columns, with no per-campaign mapping screen yet (the API accepts one). Tier limits in `messaging_tier_limits` come from Meta's published tiers and need checking against current limits. A real campaign has not run against Meta.
- Campaign throughput measured about 23 messages a second in the 10k test on the dev machine, under the 40 limit: each send takes several transactions. Fine for now, but a large number on a high tier would want this tuned.
- Worker dispatch sends a batch concurrently, so messages within one batch can go out of order. Harmless for a broadcast, since each goes to a different person.
- Phase 2.5 not verified with real sandboxes: run a test top-up and subscription on Stripe and Razorpay test keys (steps in `infra/billing-setup.md`). Real plan prices, provider price ids and seller details are not set. Razorpay's webhook blocks localhost, so it needs a tunnel that is not on its blocklist.
- Refunds and disputes are not handled: `charge.refunded` and Razorpay refund events are stored and ignored, so a refunded top-up leaves its credit. Handle them by hand for now, and decide what happens when the money is already spent.
- Plan changes and renewals are not in the audit log, since only the API writes it and the worker makes these changes. The provider's events are kept in `billing_events`, with no screen or replay yet.
- No trial-ending email, only the banner. No proration preview before switching plans. Razorpay subscriptions authorized by UPI or e-mandate cannot change plan, and the provider's refusal is shown as is.
- Invoice PDFs use a built-in font: non-Latin names (Hindi, for example) will not render. Embed a font before relying on them.
- Invoice wording and fields need a check with an accountant for GST compliance (HSN or SAC code, place of supply, CGST and SGST split).
- Public API: no media send, no `GET` for one message, and no filter for messages since a date. Imports do not emit `contact.created` per row, to avoid flooding endpoints. Only template status changes from webhooks emit `template.status_changed`, not those found by the hourly comparison.
- Webhooks: no automatic switch-off for an endpoint that keeps failing. A slow endpoint can use up the 10 delivery slots and delay other workspaces' webhooks, since there is no per-endpoint limit yet. No per-plan API rate limit: the same limit for everyone.
- `@nestjs/swagger` pulls in `swagger-ui-dist`, whose `@scarf/scarf` postinstall sends install analytics. Set `SCARF_ANALYTICS=false` in CI and deploy builds if that is unwanted.
- Rules and routing: notifications are in-app only, with no email or push. The SLA ignores business hours. No holidays in business hours, and one span per day in the settings screen (the API takes up to four). Auto-reply rules cannot be limited to one number from the screen yet (the API takes it).
- Flows: the simulator answers HTTP steps by hand and does not check the 24-hour window, the wallet or consent. List steps with more than one section are edited as JSON. No undo in the builder yet. Tags added by CSV import do not start flows. Tag triggers are queued after commit, so a Redis outage at that moment loses the trigger. Runs and their history are kept forever; add retention before launch.
- Integrations: failed outbound actions are logged but not retried outside a flow. Events and claims are kept forever; add retention before launch. Per-connection rate limits are not enforced. Webhooks need `API_PUBLIC_URL` reachable by the provider (a tunnel in development).
- Real rate cards are not loaded. `sample-rate-cards.csv` is not Meta's pricing. Before charging anyone: build a CSV from Meta's current rate card with your margin, and run `pnpm rates:import`. Check how Meta's market groups map to countries.
- Meta bills by its own rules, such as volume tiers, which flat per-country rates do not model. Reconcile against Meta's invoices.
- Verify current Meta messaging limits and partner requirements.
- Confirm pgvector is available on the chosen production Postgres host (the native Windows dev Postgres has it, built from source; see `infra/native-setup.md`).
- Start Meta Business Verification and App Review early (needed for Embedded Signup at scale).
