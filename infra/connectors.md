# Connectors: how integrations work, and how to add one

A connector is one object, a `ConnectorDefinition` (`packages/connectors/src/types.ts`). It says
how the app signs in to a service, what events the service can trigger, what actions flows can
run in it, how its webhooks are checked and read, and how it syncs. The framework does the rest,
the same for every connector:

| The framework does                                    | Where                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Marketplace card, connect form, connection page       | `apps/web/src/app/(app)/integrations`                        |
| Encrypted credentials (`SecretBox`, row-bound)        | `integration_connections.credentials_enc`                    |
| OAuth state (random, 10 minutes, one use, in Redis)   | `IntegrationsService.startOAuth` / `finishOAuth`             |
| Token refresh before expiry, reconnect prompts        | `refreshConnection` (worker), `integration-tick`             |
| Webhook address, signature check on the raw bytes     | `POST /integrations/hooks/:token`                            |
| Event log with retry state, replay of failed events   | `integration_events`, `POST /integrations/events/:id/replay` |
| Each outside event acting once (webhook, sync, retry) | `integration_event_claims`, in the transaction that acts     |
| Finding or making the contact, starting flows         | `processIntegrationEvent` (worker)                           |
| Running actions from flow steps, with fresh tokens    | `runConnectorAction` (worker)                                |
| Hourly health checks, syncs on their interval         | `integration-tick` every minute, `integration_due_work`      |
| SSRF guard on every call a connector makes            | `ctx.http`: https only, no internal addresses, 10 s          |

## Adding a connector

1. Write the definition in `packages/connectors/src/connectors/<name>.ts`.
2. Add it to `BUILT_IN_CONNECTORS` in `packages/connectors/src/index.ts`.
3. For OAuth, add the client id and secret variables it names to `.env.example`, and set them on
   the server. Until they are set, the marketplace shows it as not available.

Nothing else changes: no migration, no API route, no page. `apps/worker/test/integrations.test.ts`
proves this with "Acme Tickets", a connector defined in the test file alone.

```ts
export const myShop: ConnectorDefinition = {
  key: 'my_shop', // lower-case, stable: stored on connections and flows
  name: 'My Shop',
  description: 'Orders and customers from My Shop',
  category: 'commerce',
  auth: { type: 'api_key', fields: [{ key: 'apiKey', label: 'API key', type: 'secret' }] },
  // or: { type: 'oauth2', authorizeUrl, tokenUrl, scopes, clientIdEnv, clientSecretEnv }
  // or: { type: 'webhook_secret' } when the service only sends webhooks
  settings: [{ key: 'baseUrl', label: 'Store address', type: 'url' }],
  triggers: [
    {
      key: 'order.created',
      name: 'Order placed',
      description: '...',
      sample: { order: { id: '1' } },
    },
  ],
  actions: [
    {
      key: 'lookup_order',
      name: 'Look up an order',
      description: '...',
      input: [{ key: 'orderId', label: 'Order number' }],
      output: ['status'],
      async run(ctx, input) {
        const res = await ctx.http({
          method: 'GET',
          url: `${ctx.settings.baseUrl}/orders/${input.orderId}`,
        });
        if (res.status === 401) throw new ConnectorError('Key refused', { reconnect: true });
        return { status: (res.json as { status: string }).status };
      },
    },
  ],
  webhook: {
    verify: (req, secret) => verifyHmacSha256(req.rawBody, secret, req.headers['x-signature']),
    deliveryId: (req) => req.headers['x-delivery-id'] ?? null,
    map: (body) => [
      {
        trigger: 'order.created',
        externalId: `order:${body.id}`,
        contact: { phone: body.phone },
        data: { order: body },
      },
    ],
  },
  async healthCheck(ctx) {
    /* throw ConnectorError when the connection no longer works */
  },
  sync: { everyMinutes: 15, run: async (ctx, cursor) => ({ events: [], cursor }) },
};
```

### Rules for a definition

- **Keys are forever.** The connector key and its trigger and action keys are stored on
  connections, events and published flows. Add new ones; do not rename.
- **`externalId` must be stable** for the same real-world event, whether it arrives by webhook,
  a redelivery or a sync. The framework claims it once per connection; a second arrival is logged
  as "Already handled".
- **Errors:** throw `ConnectorError`. `retryable: true` lets the event or sync be tried again;
  `reconnect: true` marks the connection as needing a person and notifies owners and admins.
  Anything else is a plain failure: the flow takes its Failed exit.
- **Calls out** only through `ctx.http`. Do not use `fetch` in a connector: `ctx.http` applies the
  SSRF guard and the timeout. OAuth token requests are made by the framework.
- **Secrets:** fields with `type: 'secret'` and everything OAuth returns are encrypted and never
  shown again. The webhook signing secret is made by the framework (credential `webhookSecret`)
  unless the definition names another credential in `webhook.secretField`.
- **Contacts:** `contact.phone` is normalized with the connection's `defaultCountry` setting, the
  workspace's billing country, or India. Without a usable phone, an email finds an existing
  contact; otherwise the event is logged and skipped. New contacts count against the plan's
  limit and start with no marketing consent.
- **The webhook handler is tiny:** `verify` and `deliveryId` run in the API request; `map` runs in
  the worker. Keep `verify` fast and side-effect free. `map` may be async and gets the connector
  context, so it can fetch what a webhook leaves out (Shopify fulfillments fetch their order).
- **What a mapped event can also carry:** `contact.consent` (`{ source, proof }`, applied only when
  the contact's consent is still unknown, never over an opt-out), `correlation` (stored on the flow
  runs it starts), `cancels` (correlation keys whose waiting runs are cancelled, which is how an order
  stops its abandoned-cart reminder) and `effect` (`disconnect`, `erase` or `notify`, for app
  lifecycle and privacy requests; claimed like any event, so it happens once).
- **App-level secrets:** `webhook.secretEnv` signs every connection's webhooks with one app secret
  (Shopify) instead of a per-connection credential. `appWebhook` adds a route for the whole app,
  `POST /integrations/apps/<key>/hooks`, whose `route` names the setting that finds the connections
  (through the definer function `integration_connections_by_setting`).
- **Setup and settings:** `setup(ctx, { webhookUrl })` runs in the worker after every connect and
  reconnect (job `setup`), and must be safe to repeat. `normalizeSettings` cleans what a person typed,
  or returns a message to refuse it.

## Testing a connector

- Unit-test `verify` and `map` with recorded payloads, as `packages/connectors/test` does.
- The worker test helpers inject `httpRequest` and `fetch`, so actions, health checks, syncs and
  OAuth refreshes run without the network.
- Locally, `INTEGRATIONS_DEMO=true` (API and worker) adds the Demo Store connector, and
  `API_PUBLIC_URL` must be an address the service can reach (a tunnel) for webhooks and OAuth.

## Built-in commerce connectors (Phase 3.5)

All three emit the same commerce events (`packages/connectors/src/commerce.ts`), so one flow works
with any store: `order.created`, `order.paid`, `order.fulfilled`, `order.cancelled`,
`shipment.updated`, `checkout.started` and `customer.created`. Data is `{ order }`, `{ order, shipment }`,
`{ checkout }` or `{ customer }`, in one shape: for example `{{trigger.data.order.name}}`,
`{{trigger.data.order.total}}`, `{{trigger.data.order.itemsSummary}}`,
`{{trigger.data.shipment.tracking.url}}` and `{{trigger.data.checkout.recoveryUrl}}`. Map them to
template variables in a `send_template` step.

### Shopify

1. In the Shopify Partner dashboard create an app. Set its redirect URL to
   `<API_PUBLIC_URL>/integrations/oauth/callback`.
2. Set the three mandatory privacy webhooks (customer data request, customer redact, shop redact)
   to `<API_PUBLIC_URL>/integrations/apps/shopify/hooks`.
3. Put the client id and secret in `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (API and worker).
4. In the app, Integrations > Shopify, enter the shop (`name.myshopify.com`, a full address is
   cleaned up) and approve the install.

The worker then registers the order, fulfillment, checkout, customer and `app/uninstalled` webhooks
on the shop at the connection's own address. Every Shopify webhook is checked with the app secret
(`X-Shopify-Hmac-SHA256`). The Admin API version is `SHOPIFY_API_VERSION` (`2026-07`); scopes are
`read_orders`, `read_customers` and `read_fulfillments`.

- **Consent:** only a customer who ticked SMS marketing at checkout (`sms_marketing_consent.state:
subscribed`) is recorded as opted in, source `shopify_checkout`, with Shopify's details as proof.
- **Abandoned carts:** `checkout.started` fires when a checkout has a phone and is not complete. Its
  correlation is `checkout:<token>`; the order for that checkout cancels any run still waiting. Build
  the reminder as a flow: delay, then a template with `{{trigger.data.checkout.recoveryUrl}}`.
- **Uninstall** disconnects the connection. **Shop redact** also blanks the stored event payloads.
  **Customer redact and data requests** notify owners and admins (`integration_request`), because
  what to erase or export is the workspace's decision.

### WooCommerce

Make a REST API key (WooCommerce > Settings > Advanced > REST API, read/write) and enter it with the
store address. The worker registers `order.created`, `order.updated` and `customer.created`
webhooks, skipping any the address already has, signed with the connection's webhook secret. Order
statuses map to events: `processing` is paid, `completed` is fulfilled, `cancelled` is cancelled;
each fires once per order. Tracking is read from the Shipment Tracking extension when present.

### Custom store

For any other system: `POST` JSON to the connection's webhook address, signed as
`X-Signature: sha256=<hex HMAC-SHA256 of the body with the webhook secret>`:

```json
{
  "event": "order.created",
  "id": "order-1001",
  "customer": {
    "phone": "+919800000000",
    "name": "Asha",
    "marketing_consent": true,
    "consent_text": "Ticked at checkout"
  },
  "data": { "order": { "name": "#1001", "total": "1499.00" } },
  "correlation": "checkout:abc",
  "cancels": ["checkout:abc"]
}
```

A commerce event name keeps its trigger; anything else arrives as `event.received`. `id` is what
makes a repeat count once. The connector's `request` action calls the store's own API (`baseUrl`
setting, bearer `apiToken`), as a generic HTTP action for flows.

## Payments, Sheets and HubSpot (Phase 3.6)

### Payment links (Razorpay, Stripe)

The business's own account, not the platform's billing. Both offer the action **Create a payment
link** (amount as a decimal such as `499.00`, currency, what it is for, the customer's phone) and
**Check a payment link**, and the triggers `payment.paid`, `payment.failed` and
`payment.expired` with `{{trigger.data.payment.*}}` (`amount`, `currency`, `linkId`, `url`,
`status`, `method`, `error`, `customer`).

- **Reminders:** a flow makes the link, sends it, then waits and reminds. The action ties the run
  to `payment:<connector>:<linkId>` (`correlation` on the action, stored in the run's
  `trigger.correlations`). Paid or expired cancels that run, and a `payment.paid` flow can thank
  the customer. A failed payment does not stop reminders, since the customer can try again.
- **Once only:** a flow step passes `ctx.idempotencyKey` (`flow:<run>:<node>:<steps>`), the same
  when the step repeats after a crash. Razorpay gets it as `reference_id` (a repeat finds the link
  it made); Stripe as the `Idempotency-Key` header.
- **Razorpay:** key id and secret. Razorpay has no API to register webhooks: in Dashboard >
  Webhooks add the connection's webhook address and secret, with `payment_link.paid`,
  `payment_link.expired`, `payment_link.cancelled` and `payment.failed`. Links are made with
  Razorpay's own SMS and email notices off, since WhatsApp sends them.
- **Stripe:** a secret or restricted key (Checkout Sessions and Webhook Endpoints: write) and the
  page to show after paying. A link is a one-time Checkout Session (30 minutes to 24 hours). Setup
  registers the webhook endpoint and keeps the signing secret Stripe returns
  (`webhook.secretBySetup`; `setup` may return `{ credentials }`, which the worker merges in
  under a row lock).

### Google Sheets

OAuth with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (offline access, so it keeps working).
Actions: **Add a row** (values separated by `|`, written RAW so nothing becomes a formula) and
**Find a row** (by the heading in row 1, within the first 5,000 rows; saves `row.<Heading>`).

### HubSpot

OAuth with `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`, scopes `crm.objects.contacts.read`
and `.write`. Actions: **Create or update a contact** (matched by email, then phone) and **Add a
note to a contact** (by id, email or phone). To keep HubSpot in step, use flows: a new-contact
trigger with the upsert action, a handoff or end step that adds a note.
