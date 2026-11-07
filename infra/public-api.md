# Using the public API

Full reference: `GET <api>/v1/docs` (browsable), `GET <api>/v1/openapi.json` (OpenAPI document). Both are public and generated from the code.

## Send a template and hear about the reply

1. In Settings > API keys, create a key with `Send messages` and `Read templates`. Copy it: it is shown once.
2. In Settings > Webhooks, add your HTTPS endpoint with the events you want. Copy the signing secret: it is shown once.
3. Find the template and send it:

```bash
curl -H "Authorization: Bearer $KEY" "$API/v1/templates?q=order_update"
```

```bash
curl -X POST "$API/v1/messages" -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"to":"+919812300001","type":"template","templateId":"<id>","variables":{"body.1":"Asha"},"idempotencyKey":"order-1042"}'
```

The answer means the message is queued. Its progress arrives as `message.status` webhooks, and the reply as `message.received`.

## Rules the API keeps

The same rules as the inbox apply. Text needs an open 24-hour window, and marketing templates need recorded consent (`POST /v1/contacts/:id/consent`). Paid sends need wallet balance, and a key needs the scope for each route. Errors are `{ "code", "message", "details" }`, with `code` stable.

Sending the same `idempotencyKey` again returns the first message rather than sending twice. Keep the key unique per message you mean to send.

Requests are limited per key, per minute. See `X-RateLimit-Limit` and `X-RateLimit-Remaining`. A `429` has `Retry-After`.

Lists use cursors: pass `nextCursor` back as `cursor` until it is null.

## Receiving webhooks

Each delivery is a POST with this body:

```json
{ "id": "<event id>", "type": "message.received", "createdAt": "...", "data": {} }
```

And these headers: `X-Wacrm-Signature`, `X-Wacrm-Event`, `X-Wacrm-Event-Id`, `X-Wacrm-Delivery-Id`.

**Check the signature.** The header is `t=<unix seconds>,v1=<hex>`. `v1` is the HMAC-SHA256 of `<t>.<raw body>` with your signing secret. Use the raw bytes, before any JSON parsing. Compare in constant time, and refuse a `t` more than 5 minutes old:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isValid(secret, rawBody, header) {
  const t = header?.match(/t=(\d+)/)?.[1];
  const v1 = header?.match(/v1=([0-9a-f]+)/)?.[1];
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

**Answer with any 2xx within 10 seconds.** Do slow work after answering. Anything else counts as a failure, including a redirect, which is not followed.

**Dedupe on `X-Wacrm-Event-Id`.** Delivery is at least once, and order is not guaranteed. A retry or a replay carries the same event id.

Failures are retried after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2, 6, 12 and 24 hours, then marked failed. The delivery log in Settings > Webhooks shows every attempt and can replay any finished delivery. Logs are kept for `WEBHOOK_RETENTION_DAYS`.

Endpoints must be public HTTPS addresses. Private and internal addresses are refused, including names that resolve to them.
