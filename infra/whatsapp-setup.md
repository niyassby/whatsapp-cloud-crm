# Connecting a real WhatsApp number

What to set up in Meta so a number connects and webhooks arrive. Meta's dashboard wording changes
often, so treat labels as approximate.

## 1. Create the Meta app

1. At [developers.facebook.com](https://developers.facebook.com/apps), create a **Business** app and
   add the **WhatsApp** product.
2. From **App settings > Basic**, copy the App ID and App Secret.
3. Choose any long random string as the webhook verify token: `openssl rand -hex 24`

Put these in `.env`:

```
META_APP_ID=...
META_APP_SECRET=...
META_WEBHOOK_VERIFY_TOKEN=...
```

## 2. Expose the API over HTTPS

Meta only calls public HTTPS URLs. Locally, tunnel port 4000:

```bash
cloudflared tunnel --url http://localhost:4000
```

Keep the printed URL. It changes each run unless you set up a named tunnel.

## 3. Configure the webhook

In **WhatsApp > Configuration > Webhook**:

- Callback URL: `https://<your-tunnel>/webhooks/meta`
- Verify token: the value of `META_WEBHOOK_VERIFY_TOKEN`
- Subscribe to at least: `messages`, `message_template_status_update`,
  `phone_number_quality_update`, `account_update`

The API answers the verification handshake, so **Verify and save** should succeed while it runs.

## 4. Connect a test number (fastest)

Meta gives every app a free test number.

1. In **WhatsApp > API Setup**, note the **Phone number ID** and **WhatsApp Business Account ID**,
   and add your own phone as an allowed recipient.
2. Create a permanent token: **Business Settings > Users > System users**, add a system user,
   assign the app and the WABA, generate a token with `whatsapp_business_messaging` and
   `whatsapp_business_management`.
3. In the app, go to **Settings > WhatsApp > Connect with a token** and paste the three values.
   Leave the PIN empty: test numbers are already registered.

## 5. Check the acceptance criteria

1. Send a WhatsApp message from your phone to the test number.
2. **Settings > WhatsApp > Recent webhook events** shows a `messages` event as `routed`.
3. The row is also in the `webhook_events` table.

Message handling and the inbox arrive in Phase 1.5; until then events stop at `routed`.

## 6. Embedded Signup (how customers connect)

Needs App Review and Business Verification for real customers, but works for app admins before that.

1. Add the **Facebook Login for Business** product and create a configuration from the
   **WhatsApp Embedded Signup** template. Set `META_EMBEDDED_SIGNUP_CONFIG_ID` to its ID.
2. Under its settings, add your web origin to **Allowed domains** and enable
   **Login with the JavaScript SDK**. Production needs HTTPS.
3. **Settings > WhatsApp** now shows **Connect with Facebook**.

## 7. Deletion and deauthorization callbacks

In **App settings > Basic > Data deletion**, and **Facebook Login > Settings > Deauthorize**:

- Data deletion callback: `https://<public-api>/meta/data-deletion`
- Deauthorize callback: `https://<public-api>/meta/deauthorize`

## Production

- `WEB_URL` must be the public web origin: deletion status links use it.
- `ALLOW_MANUAL_CONNECT` defaults to off in production.
- `META_GRAPH_BASE_URL` is for local fakes only; the API refuses to start with it in production.
