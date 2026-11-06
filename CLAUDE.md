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
pnpm rates:import <file.csv>                       # add rate cards: country,category,currency,rate,valid_from
pnpm wallet:credit <org slug or id> <amount> "<reason>"   # manual balance adjustment
pnpm plans:import <file.json>                      # plans and prices; see packages/db/prisma/sample-plans.json
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
- All money moves through `packages/db/src/wallet.ts`, inside the transaction of what it pays for: `creditWallet`, `debitWallet`, `refundDebit`, `reserveFunds`, `releaseReservation`, `chargeMessage`. Each takes the row lock first (`SELECT ... FOR UPDATE`), so changes to one wallet happen one at a time. Each has an idempotency key, unique per org. There is deliberately no HTTP endpoint that adds or takes money.
- Charging: `chargeMessage` runs in the transaction that creates the message, after the client-key claim, so a message and its charge exist together or not at all. A refused send rolls back and the same key can retry. `messageDebitKey(messageId)` is the debit's key.
- What is charged: templates, at the rate for the recipient's country from the wa_id, falling back to `*`. Marketing and authentication always. Utility only outside the 24-hour window. Free-form replies are free, and keep working at zero balance. A chargeable send with no rate is refused (`RATE_NOT_CONFIGURED`), never given away. A zero rate is free.
- Refunds: `refundDebit`, once per debit, carrying its rate and category. Triggered by any failure in `outbound.ts` (including an interrupted send and marketing refused at send time), a `failed` status webhook, `pricing.billable: false` on any status, and a failure to queue. Retries keep the charge until the last attempt.
- Reservations (for 2.4 campaigns): `reserveFunds` lowers what is available without changing the balance; `debitWallet` with `reservationId` spends from it; `releaseReservation` returns the rest. Holds past `expires_at` are released on the next reservation, so a crashed campaign cannot strand money.
- Rate cards: `rate_cards` has no org_id, since prices are the same for every org, and the app role can only read it. A new price is a new row with a later `valid_from`. `findRate` takes the newest in force. Load with `pnpm rates:import <file.csv>`. `packages/db/prisma/sample-rate-cards.csv` is sample data, not Meta's prices.
- Manual credit: `pnpm wallet:credit <org slug or id> <amount> "<reason>"`, an operator tool using the owner connection, recorded as an `adjustment`. Top-ups through payments arrive in 2.5.
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

## Troubleshooting

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
- `CAMPAIGN_MPS_PER_NUMBER` (40, below `OUTBOUND_MPS_PER_NUMBER` on purpose), `CAMPAIGN_MAX_FAILURE_RATE` (0.2). Worker only
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: API and worker both need them, and a provider exists only with all its values. `STRIPE_API_BASE`, `RAZORPAY_API_BASE` for local fakes only (refused in production)
- `BILLING_SELLER_NAME` (defaults to `APP_NAME`), `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_TAX_ID`: printed on invoices
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
- [ ] Section 2: Contacts, templates, campaigns, billing, public API (2.1 contacts and consent DONE; 2.2 template manager code DONE, real Meta approval not verified; 2.3 wallet DONE, real rate cards not loaded; 2.4 campaigns and dashboard DONE; 2.5 billing code DONE, real sandbox payments not verified; 2.6 to do). Started with the Section 1 gate still open, by the project owner's decision (2026-11-05).
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

## Known gaps / TODO

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
- E2E import and export tests skip in CI, which has no S3 service.
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
- Real rate cards are not loaded. `sample-rate-cards.csv` is not Meta's pricing. Before charging anyone: build a CSV from Meta's current rate card with your margin, and run `pnpm rates:import`. Check how Meta's market groups map to countries.
- Meta bills by its own rules, such as volume tiers, which flat per-country rates do not model. Reconcile against Meta's invoices.
- No platform-admin screen for rate cards or manual credits: CLI only until Section 4.
- Verify current Meta messaging limits and partner requirements.
- Confirm pgvector is available on the chosen production Postgres host before Phase 3.7 (local image has pgvector 0.8.7).
- Start Meta Business Verification and App Review early (needed for Embedded Signup at scale).
