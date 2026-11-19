# Webhooks failing or silent

Alert: `MetaWebhooksFailing`. Also: customers say messages are not arriving, or payments are not credited.

Every webhook receiver verifies the signature on the raw body, stores the event, queues it and answers 200. A 5xx means storing failed (Postgres or Redis), and the provider will retry. A 401 means the signature did not match.

## Meta (`/webhooks/meta`)

1. Refused with 5xx: storage is failing. Fix Postgres or Redis first ([database.md](database.md), [redis.md](redis.md)); Meta redelivers and duplicates are removed by the payload hash.
2. Refused with 401: `META_APP_SECRET` does not match the app that sends the webhooks. After rotating the app secret in Meta, update it in API and worker at once.
3. Silent (no requests at all):
   - Meta's own status: https://metastatus.com.
   - The webhook subscription in the Meta app dashboard (callback URL, verify token, the `messages` field).
   - A single number silent: its WABA subscription. Reconnecting the number from Settings > WhatsApp subscribes again.
4. Stored but not processed: rows stay `received` in Settings > WhatsApp > webhook events. The worker or the `webhook-events` queue is the problem ([worker-down.md](worker-down.md), [queue-backlog.md](queue-backlog.md)). Use Replay on a row to queue it again.

## Instagram (`/webhooks/instagram`)

Same as Meta, with `INSTAGRAM_APP_SECRET`. Instagram tokens last 60 days and are refreshed daily by the worker; a channel showing an expired token must be reconnected by the customer.

## Stripe and Razorpay (`/webhooks/stripe`, `/webhooks/razorpay`)

1. 401: the webhook secret (`STRIPE_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) does not match the endpoint in the provider's dashboard.
2. A top-up paid but not credited: find it in `billing_events` (status and error). A `failed` event with "amount differs" is deliberate: the payment does not match the top-up and needs a person. Otherwise replay it from the provider's dashboard ("resend"); credits are idempotent (`topup:<id>`), so resending is always safe.
3. Both providers retry for days; an outage of a few hours loses nothing.

## Outgoing webhooks (customers' endpoints)

Not an alert: failures there are the customer's endpoint. Deliveries retry 8 times over about two days and are visible in Settings > Webhooks. A slow endpoint uses delivery slots; if `webhook-deliveries` backs up, see [queue-backlog.md](queue-backlog.md).
