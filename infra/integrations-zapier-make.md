# Zapier and Make

Both connect through the public API (`infra/public-api.md`, reference at `GET /v1/docs`). Nothing
in the app is specific to either: triggers are REST hooks on `/v1/hooks`, actions are the normal
`/v1` endpoints.

## What a customer does

1. Settings > API keys: make a key with **Subscribe to events (Zapier, Make)** plus what the
   actions need (Send messages, Create and change contacts, Create tags).
2. Paste the key into Zapier or Make when connecting the app.
3. Turn a Zap or scenario on. It subscribes; Settings > Webhooks then shows it marked
   **Via API key**, with its delivery log. Turning it off removes the subscription. Revoking the
   key removes every subscription made with it.

## The hook endpoints

| Call                           | Scope          | Does                                                                 |
| ------------------------------ | -------------- | -------------------------------------------------------------------- |
| `GET /v1/hooks`                | `hooks:manage` | Subscriptions made through the API (and a key test)                  |
| `POST /v1/hooks`               | `hooks:manage` | `{ url, event }` subscribes; answers `{ id, url, event, createdAt }` |
| `DELETE /v1/hooks/:id`         | `hooks:manage` | Unsubscribes (only API-made subscriptions)                           |
| `GET /v1/hooks/samples/:event` | `hooks:manage` | Up to 3 recent real events, else a documented sample                 |

Events are `WEBHOOK_EVENTS` in `packages/shared/src/public-api.ts`. Each delivery is the same as
for dashboard webhooks: body `{ id, type, createdAt, data }`, signed `X-Wacrm-Signature`, retried
for about two days, at least once. The event `id` is the dedupe key. Subscriptions are https only
and pass the same address checks as dashboard endpoints; a workspace can have 100.

## Zapier

`infra/zapier/index.js` is a sample Zapier Platform CLI app: custom auth with the API key, one REST
hook trigger per event (subscribe, unsubscribe, and samples as `performList`), and actions to send
a template, send text, and create a contact. To publish: copy the folder out, set `BASE_URL`,
`npm i zapier-platform-core`, `zapier push`, then test with a real key.

## Make

Make's custom apps are defined in its web editor. The pieces:

- **Base**: `baseUrl` = the API address; headers `Authorization: Bearer {{connection.apiKey}}`.
- **Connection**: one field, `apiKey` (password); test with `GET /v1/hooks`.
- **Webhook** (shared, dedicated): attach `POST /v1/hooks` with
  `{ "url": "{{webhook.url}}", "event": "{{parameters.event}}" }`, keeping `{{body.id}}` as the
  webhook id; detach `DELETE /v1/hooks/{{webhook.id}}`. Output the body's `data`.
- **Instant triggers**: one per event, using that webhook with `event` fixed.
- **Actions**: `POST /v1/messages`, `POST /v1/contacts`, `POST /v1/contacts/:id/tags`, as in the API
  reference.

## Why keys may add endpoints now

Phase 2.6 kept endpoint management in the dashboard so a leaked key could not redirect events.
REST hooks need a key to subscribe, so this is allowed only with the separate `hooks:manage`
scope, the subscriptions are visible and removable in the dashboard, and they end with the key.
A key without that scope still cannot see or change any endpoint.
