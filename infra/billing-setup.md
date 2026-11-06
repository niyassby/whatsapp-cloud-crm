# Setting up payments

Test keys only until you are ready to charge. Keys go in your local `.env` (gitignored), for both the API and the worker. Never commit them.

## Stripe (test mode)

1. In the Stripe dashboard, switch to test mode and create a product with a recurring price for each plan and period. Note each `price_...` id.
2. Add a webhook endpoint at `https://<your-api>/webhooks/stripe`, on API version `2026-10-28.endive`, for these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`.
3. For local testing, the Stripe CLI can forward events: `stripe listen --forward-to localhost:4000/webhooks/stripe`. It prints the signing secret to use.
4. Turn on the customer portal in the Stripe dashboard.
5. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

## Razorpay (test mode)

1. In the Razorpay dashboard, switch to test mode and create a subscription plan for each plan and period. Note each `plan_...` id.
2. Add a webhook at `https://<your-api>/webhooks/razorpay` with a secret, for these events:
   `payment_link.paid`, `subscription.activated`, `subscription.charged`, `subscription.completed`, `subscription.updated`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.paused`, `subscription.resumed`.
   Razorpay refuses `localhost` and some tunnels such as ngrok; its docs suggest zrok for local testing.
3. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`.

## Plans and prices

1. Copy `packages/db/prisma/sample-plans.json`, and fill in your real prices and the provider ids from above. Prices are what the provider charges, tax included, so they must match the provider's.
2. Run `pnpm plans:import <your-file.json>`.
3. Set `BILLING_SELLER_NAME`, `BILLING_SELLER_ADDRESS` and `BILLING_SELLER_TAX_ID` for invoices.

## Checking it works

1. Settings > Billing: enter billing details, then choose a plan and pay with the provider's test card. The plan changes once the webhook arrives, and an invoice appears.
2. Wallet > Add funds: pay with a test card. The balance rises by the amount, not the tax.
3. In the provider's dashboard, resend the same webhook event. Nothing should change.
