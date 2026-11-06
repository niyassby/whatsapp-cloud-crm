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
  `template_category_update`, `message_template_quality_update`,
  `message_template_components_update`, `phone_number_quality_update`, `account_update`

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
2. **Settings > WhatsApp > Recent webhook events** shows a `messages` event as `processed`.
3. The message appears in the inbox, and a reply shows its ticks there.

## Template approval check

1. In **Templates > New template**, create a Utility template and click **Submit to Meta**.
2. Wait for it to show **Approved**, which arrives by webhook. Review can take up to 24 hours. Use
   **Sync with Meta** if the webhook is not reaching you.
3. Message the number from your phone, then in the inbox click **Send a template**, choose it, and
   send. Check it arrives, and that its ticks reach read.
4. Repeat with an image header. This checks the sample upload as well as sending media.

Meta test numbers can only message recipients allowed in **API Setup**.

## 6. Embedded Signup (how customers connect)

The app uses the v4 flow. Meta's docs say you must be a Tech Provider or Solution Partner. Before
App Review, permissions only show in the flow for people with an admin, developer or tester role on
the app. Real customers need Business Verification and Advanced Access to
`whatsapp_business_management` and `whatsapp_business_messaging`.

1. Add the **Facebook Login for Business** product.
2. Under **Configurations**, create a new configuration with the **WhatsApp Embedded Signup** login
   variation and select the Cloud API product. Selecting products is what puts it on v4, so an older
   configuration has to be replaced. Set `META_EMBEDDED_SIGNUP_CONFIG_ID` to its ID and restart.
3. Under **Settings > Client OAuth settings**, set to Yes: Client OAuth login, Web OAuth login,
   Enforce HTTPS, Embedded Browser OAuth Login, Strict Mode for redirect URIs and Login with the
   JavaScript SDK.
4. Add the page's domain to both **Allowed domains** and **Valid OAuth redirect URIs**. If either is
   missing, the popup cannot send the account ids back. Meta only documents HTTPS domains and says
   nothing about `localhost`.
5. **Settings > WhatsApp** now shows **Connect with Facebook**. Click **Finish** on the last screen:
   closing it with X returns no code. Use a number that is not live on another account here, and not
   one that stays on the WhatsApp Business app (not supported yet).
6. Outside a Solution Partner credit line, the customer must add a payment method to their WhatsApp
   account before they can send.

## 7. Deletion and deauthorization callbacks

In **App settings > Basic > Data deletion**, and **Facebook Login > Settings > Deauthorize**:

- Data deletion callback: `https://<public-api>/meta/data-deletion`
- Deauthorize callback: `https://<public-api>/meta/deauthorize`

## Production

- `WEB_URL` must be the public web origin: deletion status links use it.
- `ALLOW_MANUAL_CONNECT` defaults to off in production.
- `META_GRAPH_BASE_URL` is for local fakes only; the API refuses to start with it in production.
